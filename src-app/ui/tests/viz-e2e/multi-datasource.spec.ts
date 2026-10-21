import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, canvasNonBlank } from './_helpers'

// MULTI-DATASOURCE (ITEM-25 proof surface). Two datasets (A + B) render on ONE shared GridWorkspace
// deck; when they share canonical barcodes, a selection published in A's canonical ids AUTO-LIGHTS the
// barcode-matched cells in B (DEC-M4). The `multi-datasource` story exposes lit-counts via
// window.__VIZ_TEST__ = { ready, canonicalLen, aLit, bLit } so the assertions are deterministic
// without depending on GPU pixels.

const viz = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: Record<string, number> }).__VIZ_TEST__ ?? {})

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('multi-datasource: two datasets render on one deck; a selection in A auto-lights matching cells in B', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'multi-datasource')

  const workspace = page.getByTestId('viz-grid-workspace')
  await expect(workspace).toBeVisible({ timeout: 20_000 })

  // Both datasets loaded + the shared deck rendered non-blank (TEST-9/23: distinct clouds, one canvas).
  await expect.poll(async () => (await viz(page)).ready, { timeout: 30_000 }).toBe(1)
  await expect.poll(() => canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)
  // ONE shared WebGL context regardless of dataset count.
  await expect.poll(() => workspace.locator('canvas').count(), { timeout: 10_000 }).toBe(1)

  // No selection yet.
  expect((await viz(page)).aLit).toBe(0)
  expect((await viz(page)).bLit).toBe(0)

  // Select a subset in dataset A → it lights in A AND auto-lights the barcode-matched cells in B (TEST-15).
  await page.getByTestId('viz-md-select-a').click()
  await expect.poll(async () => (await viz(page)).aLit, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await viz(page)).bLit, { timeout: 10_000 }).toBeGreaterThan(0)

  // Clear resets both.
  await page.getByTestId('viz-md-clear').click()
  await expect.poll(async () => (await viz(page)).aLit, { timeout: 10_000 }).toBe(0)
  await expect.poll(async () => (await viz(page)).bLit, { timeout: 10_000 }).toBe(0)

  // REAL produce path (not the direct-store button): enable the grid rect-select tool and drag a
  // large rectangle over cell A (left pane) → commitRect → publishCellSelection → cellSelectionSpace →
  // canonical space. This exercises the actual lasso→space-routing produce code, and B auto-lights.
  await page.getByTestId('viz-tool-rail-tool-select').click()
  const box = await workspace.boundingBox()
  expect(box).toBeTruthy()
  if (box) {
    await page.mouse.move(box.x + box.width * 0.06, box.y + box.height * 0.12)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.88, { steps: 10 })
    await page.mouse.up()
  }
  // The real produce path published a canonical selection; B (shared barcodes) auto-lights.
  await expect.poll(async () => (await viz(page)).canonicalLen, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await viz(page)).bLit, { timeout: 15_000 }).toBeGreaterThan(0)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

// TEST-9 (covers ITEM-8 · MD-8): hovering a point in a MULTI-DATASET cell surfaces THAT dataset's own
// tooltip — cell-2 (dataset B) shows B-* labels, cell-1 (dataset A) shows A-* — proving the tooltip reads
// the hovered cell's dataset, not the default one, AND that a datasetId cell's tooltip is surfaced at all
// (pre-MD-8 it was suppressed for every datasetId cell, so NO tooltip would appear here).
test('TEST-9 per-dataset hover tooltip: cell-2 shows dataset B, cell-1 shows dataset A', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'multi-datasource')

  const workspace = page.getByTestId('viz-grid-workspace')
  await expect(workspace).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await viz(page)).ready, { timeout: 30_000 }).toBe(1)
  await expect.poll(() => canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)

  const tooltip = page.getByTestId('viz-tooltip')
  const box = await workspace.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return

  // Sweep a region of a pane until picking lands on a scatter point and the tooltip mounts.
  const hoverUntilTooltip = async (gxLo: number, gxHi: number): Promise<string> => {
    for (let gy = 0.3; gy <= 0.72; gy += 0.08) {
      for (let gx = gxLo; gx <= gxHi; gx += 0.05) {
        await page.mouse.move(box.x + box.width * gx, box.y + box.height * gy)
        await page.waitForTimeout(90)
        if (await tooltip.isVisible()) return (await tooltip.innerText()).trim()
      }
    }
    return ''
  }

  // cell-2 = dataset B (right pane) → the tooltip must carry B's labels, never A's.
  const bText = await hoverUntilTooltip(0.56, 0.92)
  expect(bText, `dataset-B tooltip text: ${bText}`).toContain('B-x')
  expect(bText, `dataset-B tooltip must NOT show dataset A: ${bText}`).not.toContain('A-x')

  await page.mouse.move(10, 10)
  await expect(tooltip).toBeHidden()

  // cell-1 = dataset A (left pane) → A's labels (positive control that the per-dataset resolution differs).
  const aText = await hoverUntilTooltip(0.08, 0.44)
  expect(aText, `dataset-A tooltip text: ${aText}`).toContain('A-x')
  expect(aText, `dataset-A tooltip must NOT show dataset B: ${aText}`).not.toContain('B-x')

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

// TEST-11 (covers ITEM-10 · MD-10): a multi-dataset mount that supplies NO prop `catalog` still renders —
// GridWorkspace falls back to the first ready dataset's catalog (effectiveCatalog) for the content overlay.
test('TEST-11 no prop catalog: renders via the first-ready-dataset catalog fallback', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'multi-datasource-nocatalog')

  const workspace = page.getByTestId('viz-grid-workspace')
  await expect(workspace).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await viz(page)).ready, { timeout: 30_000 }).toBe(1)
  // The shared deck renders both datasets' clouds even with no prop catalog.
  await expect.poll(() => canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(() => workspace.locator('canvas').count(), { timeout: 10_000 }).toBe(1)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
