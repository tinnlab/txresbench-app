import { test, expect } from '@playwright/test'
import { openStory, readAttrs, trackErrors, vizTest } from './_helpers'
import { deckRegionPaintedPixels, deckRegionPixelSignature } from './_pixelsig'

// TEST-35 (covers ITEM-25): the headline cross-plot selection fan-out. A scatter
// selection is written into the shared Coordination store and read by the heatmap;
// `__VIZ_TEST__.pointSelectionLength` + the visible readout expose that it fired.
// Seed cluster 0 → length > 0 (fan-out reached the store); Clear → back to 0.
test('TEST-35 scatter selection fans out to the heatmap and clears', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'selection-sync-fanout')

  await expect(page.getByTestId('viz-selection-sync')).toBeVisible()
  await expect(page.getByTestId('viz-selection-sync-source')).toBeVisible()
  await expect(page.getByTestId('viz-selection-sync-reader')).toBeVisible()

  // Initially nothing is selected — the shared store is empty.
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'shared selection starts empty',
    })
    .toBe(0)
  await expect(page.getByTestId('viz-selection-sync-readout')).toContainText('0 points')

  // Seed a deterministic selection (every point in group code 0). The scatter WRITES,
  // the store HOLDS it, the heatmap READS it → the length becomes > 0.
  await page.getByTestId('viz-selection-sync-seed').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'fan-out populated the shared selection',
    })
    .toBeGreaterThan(0)
  // The visible readout reflects the same non-zero count.
  await expect(page.getByTestId('viz-selection-sync-readout')).not.toContainText('0 points')
  await expect(page.getByTestId('viz-selection-sync-readout')).toContainText(/points/)

  // Clear returns the shared selection to empty.
  await page.getByTestId('viz-selection-sync-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'Clear resets the shared selection',
    })
    .toBe(0)
  await expect(page.getByTestId('viz-selection-sync-readout')).toContainText('0 points')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// TEST-35b (covers ITEM-25, the REAL headline): the cross-plot fan-out driven by the
// PRODUCT selection tool — no seed button. On the heterogeneous grid we enter the grid's
// real select mode (`viz-tool-rail-tool-select` → `viz-tool-rail-sel-rect`), rect-drag over a
// DENSE scatter cell, and prove BOTH downstream effects the coordination loop must produce:
//   (1) the shared point-selection is populated by the REAL lasso (`pointSelectionLength`>0),
//   (2) the HEATMAP chart cell REPAINTS (its group-row band lights up → its canvas pixels
//       change), which is the actual cross-plot highlight the product ships.
// Both assertions FAIL if the selection tool / fan-out / heatmap-band were inert. Clearing
// via the product `viz-tool-rail-sel-clear` returns the shared selection to empty.
/** The grid's per-pane MODEL facts, read off the attributes each pane publishes
 *  (`ATTR_ID` / `ATTR_KIND`) rather than off a control's `.value` — the kind switcher is a
 *  kit `<Select>` BUTTON, and a button has no `.value`, so the old read returned `undefined`
 *  for every kind and every `.find(r => r.kind === …)` on it silently found nothing.
 *  `id` addresses a pane's TOOLBAR buttons; `testId` addresses its BODY. */
const ATTR_ID = 'data-cell-id'
const ATTR_KIND = 'data-cell-kind'
const VIEW_PREFIX = 'viz-cell-view-'
async function gridPanes(page: import('@playwright/test').Page) {
  const rows = await readAttrs(page, `[${ATTR_KIND}]`, [ATTR_ID, ATTR_KIND, 'data-testid'])
  return rows.map(a => ({
    id: a[ATTR_ID] ?? '',
    testId: (a['data-testid'] ?? '').replace(VIEW_PREFIX, ''),
    kind: a[ATTR_KIND] ?? '',
  }))
}

test('TEST-35b REAL grid rect-lasso over a scatter cell lights the heatmap band + fans out', async ({
  page,
}) => {
  // The heterogeneous grid drives a 150k-point deck + several chart canvases under headless
  // swiftshader — the heaviest viz surface — so it needs a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')

  await expect(page.getByTestId('viz-grid-heterogeneous')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // Discover the seed cells: locate a DENSE scatter cell (the selection source) and the
  // HEATMAP chart cell (the cross-plot reader) by their per-cell kind switchers.
  const rows = await gridPanes(page)
  // Both address the pane BODY (`viz-cell-view-…`), so both take the DOM identity.
  const scatterId = rows.find(r => r.kind === 'scatter')?.testId
  const heatmapId = rows.find(r => r.kind === 'heatmap')?.testId
  expect(scatterId, 'seed layout has a dense scatter cell').toBeTruthy()
  expect(heatmapId, 'seed layout has a heatmap chart cell').toBeTruthy()

  // Shared selection starts empty.
  await expect.poll(() => vizTest<number>(page, 'pointSelectionLength')).toBe(0)

  // Capture the heatmap pane's baseline pixel digest (BEFORE any selection) so we can prove the
  // band lights up. `deckRegionPixelSignature` — NOT `canvasPixelSignatureInSelector` — because
  // `heatmap` is a SHARED-DECK chart kind (`multiView.ts::SHARED_DECK_CHART_KINDS`): its plot is a
  // view on the ONE workspace `<DeckGL>` canvas, a SIBLING of the pane tree, so the first canvas
  // INSIDE the pane's own view element is its dataZoom RAIL (`viz-heatmap-datazoom-rows`, 16x141)
  // and never repaints on a selection. Measured on `882d8bfd`: rail digest `b53ff007` before and
  // after a real lasso, while this pane's deck region moves `f0d5067a` -> `bc979ca6`.
  const heatmapSel = `[data-testid="${VIEW_PREFIX}${heatmapId}"]`
  const scatterSel = `[data-testid="${VIEW_PREFIX}${scatterId}"]`
  await expect
    .poll(() => deckRegionPaintedPixels(page, heatmapSel), {
      message: 'the heatmap pane paints into the shared deck region under its rect',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  // NEGATIVE CONTROL on the probe itself: a selector matching no pane must read 0 painted
  // pixels. Without it the readiness poll above passes for a probe that is simply stuck on a
  // positive constant — the "instrument reports a value that is not a measurement" failure this
  // whole test was a victim of.
  expect(
    await deckRegionPaintedPixels(page, `[data-testid="${VIEW_PREFIX}no-such-pane"]`),
    'the paintedness probe reads a REAL region (an absent pane reads 0)',
  ).toBe(0)
  const heatmapBefore = await deckRegionPixelSignature(page, heatmapSel)
  // The digest is PANE-SPECIFIC, not a whole-deck digest: two different panes' regions must
  // hash differently. Without this, cropping to the full deck would still satisfy the repaint
  // assertion below — the SCATTER dims on selection, so a whole-deck digest changes whether or
  // not the heatmap band ever lights.
  expect(
    await deckRegionPixelSignature(page, scatterSel),
    'the deck-region digest is scoped to ONE pane (heatmap region != scatter region)',
  ).not.toBe(heatmapBefore)

  // ── enter the PRODUCT select mode + rect tool ───────────────────────────────
  const toggle = page.getByTestId('viz-tool-rail-tool-select')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const rectTool = page.getByTestId('viz-tool-rail-sel-rect')
  await rectTool.click()
  await expect(rectTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('viz-grid-select-overlay')).toBeVisible()

  // ── rect-drag over the scatter cell's central region (away from the top-left
  //    toolbar) — the REAL lasso: pointer-down → move → up in that dense cell ────
  const cellBox = await page.locator(`[data-testid="${VIEW_PREFIX}${scatterId}"]`).boundingBox()
  expect(cellBox, 'scatter cell has a measured rect').not.toBeNull()
  if (!cellBox) return
  const sx = cellBox.x + cellBox.width * 0.3
  const sy = cellBox.y + cellBox.height * 0.35
  const ex = cellBox.x + cellBox.width * 0.72
  const ey = cellBox.y + cellBox.height * 0.78
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 8 })
  await page.mouse.move(ex, ey, { steps: 8 })
  await page.mouse.up()

  // (1) the REAL lasso populated the shared point-selection.
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'the real grid rect-lasso wrote a non-empty point selection into the store',
      timeout: 20_000,
    })
    .toBeGreaterThan(0)

  // (2) the HEATMAP chart pane REPAINTED — its group-row band lit up, so its pixels differ
  // from the pre-selection baseline. This is the cross-plot highlight, driven by a REAL
  // scatter selection (not the seed button).
  await expect
    .poll(() => deckRegionPixelSignature(page, heatmapSel), {
      message: 'the heatmap pane repaints (group-row band) in response to the scatter selection',
      timeout: 30_000,
    })
    .not.toBe(heatmapBefore)

  // Clearing via the PRODUCT control returns the shared selection to empty.
  await page.getByTestId('viz-tool-rail-sel-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'Clear resets the shared selection',
      timeout: 20_000,
    })
    .toBe(0)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
