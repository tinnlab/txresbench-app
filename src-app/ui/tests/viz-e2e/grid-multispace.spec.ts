import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// Link-zoom SCOPED BY COORDINATE SPACE (story `grid-multispace`): a top row of THREE dense cells
// [scatter | scatter | image] in ONE shared `<DeckGL>`. The two scatters share ONE embedding
// space (they zoom-sync when link is ON); the image cell lives in its OWN space and NEVER
// zoom-syncs with the scatters. Selection stays GLOBAL — a lasso in any cell fans to all three.
//
// The core assertion (the embedding-blind-zoom fix): wheeling the LEFT scatter moves
// `scatterSpaceZoom` but leaves `imageSpaceZoom` untouched, and — cropping the shared deck canvas
// at each cell's rect — the OTHER scatter's region CHANGES (same space moved) while the IMAGE
// region does NOT (a byte-identical software-WebGL redraw of an unmoved space). Then selection
// still fans across spaces (a real grid rect-lasso populates the shared point selection).

/** FNV-1a digest of the shared deck canvas (index 0) CROPPED to cell `id`'s on-screen rect.
 *  Maps the cell's client rect into the canvas's pixel space (devicePixelRatio-aware) and hashes
 *  only that sub-region — so we can prove ONE cell's region moved while ANOTHER's held still.
 *  Returns '' on any invalid/tainted read (a caller comparing two '' sees "no change"). */
async function cropSigForCell(page: Page, id: string): Promise<string> {
  return page.evaluate((cellId) => {
    const cell = document.querySelector(`[data-testid="viz-cell-view-${cellId}"]`)
    const canvas = document.querySelectorAll('canvas')[0] as HTMLCanvasElement | undefined
    if (!cell || !canvas) return ''
    const cr = canvas.getBoundingClientRect()
    const er = cell.getBoundingClientRect()
    if (cr.width <= 0 || cr.height <= 0) return ''
    const scaleX = canvas.width / cr.width
    const scaleY = canvas.height / cr.height
    const sx = Math.max(0, Math.round((er.left - cr.left) * scaleX))
    const sy = Math.max(0, Math.round((er.top - cr.top) * scaleY))
    const sw = Math.min(canvas.width - sx, Math.round(er.width * scaleX))
    const sh = Math.min(canvas.height - sy, Math.round(er.height * scaleY))
    if (sw <= 0 || sh <= 0) return ''
    const off = document.createElement('canvas')
    off.width = canvas.width
    off.height = canvas.height
    const ctx = off.getContext('2d')
    if (!ctx) return ''
    try {
      ctx.drawImage(canvas, 0, 0)
      const { data } = ctx.getImageData(sx, sy, sw, sh)
      let h = 0x811c9dc5
      for (let i = 0; i < data.length; i += 4 * 101) {
        h ^= data[i]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 1]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 2]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 3]
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16)
    } catch {
      return ''
    }
  }, id)
}

/** Wheel-zoom over the CENTRE of cell `id` (by its measured rect). */
async function wheelOverCell(page: Page, id: string, dy: number) {
  const box = await page.locator(`[data-testid="viz-cell-view-${id}"]`).boundingBox()
  expect(box, `cell ${id} has a measured rect`).not.toBeNull()
  if (!box) return
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(400)
}

test('grid link-zoom is scoped by coordinate space: scatter↔scatter sync, scatter↮image, selection fans to all', async ({
  page,
}) => {
  // 120k-point deck across three shared-DeckGL cells + repeated swiftshader pixel reads — the
  // heaviest surface here, so a very wide budget.
  test.setTimeout(240_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-multispace')

  await expect(page.getByTestId('viz-grid-multispace')).toBeVisible()

  // ── ensure link zoom is ON (the two scatters share their embedding space) ────
  if ((await vizTest<boolean>(page, 'gridLinked')) !== true) {
    await page.getByTestId('grid-ms-link-zoom-toggle').check()
  }
  await expect.poll(() => vizTest<boolean>(page, 'gridLinked')).toBe(true)

  // ── discover the three cells; sort L→R = [scatter, scatter, image] ───────────
  const cells = await page.$$eval('[data-testid^="viz-cell-view-"]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return {
        id: e.getAttribute('data-testid')!.replace('viz-cell-view-', ''),
        kind: e.getAttribute('data-cell-kind') ?? '',
        x: r.left,
      }
    }),
  )
  expect(cells.length, 'the multi-space seed has three dense cells').toBe(3)
  cells.sort((a, b) => a.x - b.x)
  const [leftScatter, otherScatter, image] = cells
  expect(leftScatter.kind, 'left cell is a scatter').toBe('scatter')
  expect(otherScatter.kind, 'middle cell is a scatter (same embedding space)').toBe('scatter')
  expect(image.kind, 'right cell is an image (a DIFFERENT coordinate space)').toBe('image')

  // ── baselines: per-space shared zoom hooks + per-cell crop signatures ────────
  await page.waitForTimeout(500)
  const otherScatterBefore = await cropSigForCell(page, otherScatter.id)
  const imageBefore = await cropSigForCell(page, image.id)
  expect(otherScatterBefore, 'other-scatter region has a readable crop').not.toBe('')
  expect(imageBefore, 'image region has a readable crop').not.toBe('')
  const scatterZoomBefore = await vizTest<number | null>(page, 'scatterSpaceZoom')
  const imageZoomBefore = await vizTest<number | null>(page, 'imageSpaceZoom')

  // ── wheel the LEFT scatter (gentle zoom-OUT keeps the points in view) ────────
  await wheelOverCell(page, leftScatter.id, 200)
  await wheelOverCell(page, leftScatter.id, 200)

  // The SCATTER space zoom moved …
  await expect
    .poll(() => vizTest<number | null>(page, 'scatterSpaceZoom'), {
      message: 'wheeling a scatter moves the shared SCATTER-space zoom',
      timeout: 20_000,
    })
    .not.toBe(scatterZoomBefore)
  // … while the IMAGE space zoom did NOT (different coordinate space, never wheeled).
  expect(
    await vizTest<number | null>(page, 'imageSpaceZoom'),
    'the IMAGE space zoom is untouched by the scatter wheel (spaces are independent)',
  ).toBe(imageZoomBefore)

  // The CORE pixel assertion: the OTHER scatter's region repainted (same space moved with it) …
  await expect
    .poll(() => cropSigForCell(page, otherScatter.id), {
      message: 'the other scatter (same embedding space) moves with the linked zoom',
      timeout: 20_000,
    })
    .not.toBe(otherScatterBefore)
  // … while the IMAGE region did NOT (a different space → byte-identical software redraw).
  expect(
    await cropSigForCell(page, image.id),
    'the image cell (different space) does NOT zoom with the scatters',
  ).toBe(imageBefore)

  // ── selection still fans across ALL spaces (a REAL grid rect-lasso) ──────────
  const selToggle = page.getByTestId('viz-tool-rail-tool-select')
  await selToggle.click()
  await expect(selToggle).toHaveAttribute('aria-pressed', 'true')
  const rectTool = page.getByTestId('viz-tool-rail-sel-rect')
  await rectTool.click()
  await expect(rectTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('viz-grid-select-overlay')).toBeVisible()

  const cellBox = await page.locator(`[data-testid="viz-cell-view-${leftScatter.id}"]`).boundingBox()
  expect(cellBox, 'left scatter cell has a measured rect').not.toBeNull()
  if (cellBox) {
    const sx = cellBox.x + cellBox.width * 0.3
    const sy = cellBox.y + cellBox.height * 0.35
    const ex = cellBox.x + cellBox.width * 0.72
    const ey = cellBox.y + cellBox.height * 0.78
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 8 })
    await page.mouse.move(ex, ey, { steps: 8 })
    await page.mouse.up()
  }

  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'the real grid rect-lasso populates the GLOBAL shared point selection',
      timeout: 20_000,
    })
    .toBeGreaterThan(0)

  // Clearing via the product control returns the shared selection to empty.
  await page.getByTestId('viz-tool-rail-sel-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'Clear resets selection' })
    .toBe(0)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
