import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Grid GRIP DRAG (pointer-based). A cell is dragged by its chrome grip:
//   • released ON another cell → SWAP their contents (swapCells);
//   • released OUTSIDE the grid → TEAR OFF into its own window (portal pop-out). window.open needs a
//     user gesture and a drag release may not grant one, so a blocked tear-off shows an
//     "allow pop-ups + Retry" prompt whose Retry runs from a real click (a valid gesture);
//   • Escape / cancel mid-drag → ABORT (no swap, no tear-off).
// Unlike HTML5 DnD, a real Playwright pointer sequence (mouse.down/move/up) drives this directly.
//
// NOTE: some grid control panels (e.g. viz-tool-rail-tool-select) overlap the top row's cell chrome, so
// `pickHittableCell` finds a cell whose grip is actually on top (a hittable drag SOURCE). The drop
// TARGET can be anywhere — the drop is resolved from a rect SNAPSHOT, not the element under the cursor.

async function cellKinds(page: Page): Promise<{ id: string; kind: string | null }[]> {
  return page.$$eval('[data-testid^="viz-cell-view-"]', els =>
    els.map(e => ({ id: e.getAttribute('data-testid')!.replace('viz-cell-view-', ''), kind: e.getAttribute('data-cell-kind') })),
  )
}

/** A cell whose grip's center is actually the top element (not covered by a grid panel) — a hittable
 *  drag source. Returns its id + grip center. */
async function pickHittableCell(page: Page): Promise<{ id: string; cx: number; cy: number } | null> {
  const grips = await page.locator('[data-testid^="viz-cell-grip-"]').all()
  for (const grip of grips) {
    const tid = await grip.getAttribute('data-testid')
    if (!tid) continue
    const id = tid.replace('viz-cell-grip-', '')
    const box = await grip.boundingBox()
    if (!box) continue
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    // Hittable = the element under the grip's centre really belongs to THAT pane's toolbar. This
    // used to close on the test id of the floating chrome PILL — the surface the occupied-space
    // toolbar replaced, which no longer renders anywhere, so the predicate was false for every
    // grip and this helper returned `null` on every run: all four tests below had been failing
    // since, on a dead selector rather than on the behaviour they name. The pill's component is
    // deleted now; this closes on the toolbar that actually ships.
    const ok = await page.evaluate(
      ([x, y, cid]) =>
        !!(document.elementFromPoint(x as number, y as number) as HTMLElement | null)?.closest(
          `[data-testid="viz-pane-toolbar-${cid}"]`,
        ),
      [cx, cy, id] as const,
    )
    if (ok) return { id, cx, cy }
  }
  return null
}

/** Pointer-drag from a grip center to `(toX, toY)`. */
async function dragFrom(page: Page, from: { cx: number; cy: number }, toX: number, toY: number, opts?: { escapeBeforeUp?: boolean }) {
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  await page.mouse.move(toX, toY, { steps: 12 })
  if (opts?.escapeBeforeUp) await page.keyboard.press('Escape')
  await page.mouse.up()
}

test('grip drag ONTO another cell SWAPS their contents', async ({ page }) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const src = await pickHittableCell(page)
  expect(src, 'a hittable grip source').toBeTruthy()
  if (!src) return
  const kinds = await cellKinds(page)
  const srcKind = kinds.find(c => c.id === src.id)!.kind
  const target = kinds.find(c => c.id !== src.id && c.kind !== srcKind)
  expect(target, 'a target cell of a different kind').toBeTruthy()
  if (!target) return

  const tbox = await page.getByTestId(`viz-cell-view-${target.id}`).boundingBox()
  expect(tbox, 'target cell bounding box').toBeTruthy()
  if (!tbox) return
  await dragFrom(page, src, tbox.x + tbox.width / 2, tbox.y + tbox.height / 2)

  // Content swapped: source now shows the target's old kind and vice versa (ids stay in place).
  await expect(page.getByTestId(`viz-cell-view-${src.id}`)).toHaveAttribute('data-cell-kind', target.kind!, {
    timeout: 10_000,
  })
  await expect(page.getByTestId(`viz-cell-view-${target.id}`)).toHaveAttribute('data-cell-kind', srcKind!)

  const realErrors = bag.errors.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

test('grip drag OUTSIDE the grid tears off — blocked prompt → Retry opens a real window', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const src = await pickHittableCell(page)
  expect(src).toBeTruthy()
  if (!src) return
  const ws = await page.getByTestId('viz-grid-workspace').boundingBox()
  if (!ws) return
  const outsideX = Math.max(5, ws.x - 40) // left of the workspace (outside the grid rect)
  const outsideY = ws.y + ws.height / 2

  // Force window.open to fail (a blocked pop-up / a drag release without user activation).
  await page.evaluate(() => {
    ;(window as unknown as { __origOpen: typeof window.open }).__origOpen = window.open
    window.open = () => null
  })
  await dragFrom(page, src, outsideX, outsideY)

  await expect(page.getByTestId(`viz-tearoff-blocked-${src.id}`)).toBeVisible({ timeout: 10_000 })

  // Restore window.open, Retry from a REAL click → a real popup opens + the placeholder shows.
  await page.evaluate(() => {
    window.open = (window as unknown as { __origOpen: typeof window.open }).__origOpen
  })
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId(`viz-tearoff-retry-${src.id}`).click(),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId(`viz-tearoff-blocked-${src.id}`)).toHaveCount(0)
  // The cell MOVED into the popup (main grid reflows); the popup renders it with a Return affordance.
  await expect(page.locator(`[data-testid="viz-cell-view-${src.id}"]`)).toHaveCount(0, { timeout: 15_000 })
  await expect(popup.getByTestId(`viz-cell-return-${src.id}`)).toBeVisible({ timeout: 15_000 })
  expect(popup.isClosed()).toBe(false)

  // Return from the popup → the cell docks back into the main grid.
  await popup.getByTestId(`viz-cell-return-${src.id}`).click()
  await expect(page.locator(`[data-testid="viz-cell-view-${src.id}"]`)).toHaveCount(1, { timeout: 15_000 })

  const realErrors = bag.errors.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

test('Escape mid-drag ABORTS — no swap, no tear-off', async ({ page }) => {
  test.setTimeout(90_000)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const src = await pickHittableCell(page)
  expect(src, 'a hittable grip source').toBeTruthy()
  if (!src) return
  const before = await cellKinds(page)
  const ws = await page.getByTestId('viz-grid-workspace').boundingBox()
  expect(ws, 'workspace bounding box').toBeTruthy()
  if (!ws) return

  // Drag the grip outside the grid but press Escape BEFORE releasing → abort.
  await dragFrom(page, src, Math.max(5, ws.x - 40), ws.y + ws.height / 2, { escapeBeforeUp: true })

  // Aborted: the cell stays in the main grid (not moved to a popup), no blocked prompt.
  await expect(page.locator(`[data-testid="viz-cell-view-${src.id}"]`)).toHaveCount(1)
  await expect(page.getByTestId(`viz-tearoff-blocked-${src.id}`)).toHaveCount(0)
  expect(await cellKinds(page)).toEqual(before)
})

test('tear-off blocked prompt → Dismiss closes it without opening a window', async ({ page }) => {
  test.setTimeout(90_000)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const src = await pickHittableCell(page)
  expect(src, 'a hittable grip source').toBeTruthy()
  if (!src) return
  const ws = await page.getByTestId('viz-grid-workspace').boundingBox()
  expect(ws, 'workspace bounding box').toBeTruthy()
  if (!ws) return
  await page.evaluate(() => {
    window.open = () => null
  })
  await dragFrom(page, src, Math.max(5, ws.x - 40), ws.y + ws.height / 2)

  await expect(page.getByTestId(`viz-tearoff-blocked-${src.id}`)).toBeVisible({ timeout: 10_000 })
  await page.getByTestId(`viz-tearoff-dismiss-${src.id}`).click()
  await expect(page.getByTestId(`viz-tearoff-blocked-${src.id}`)).toHaveCount(0)
  await expect(page.locator(`[data-testid="viz-cell-view-${src.id}"]`)).toHaveCount(1)
})
