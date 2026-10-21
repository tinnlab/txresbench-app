import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors } from './_helpers'

// TEST-7 (covers ITEM-5): the enriched heatmap's GPU hover tooltip. Sweeping the mouse
// over the heatmap BitmapLayer canvas surfaces the reusable DOM tooltip
// ([data-testid="viz-tooltip"], rendered by VizTooltip). deck.gl picking hands the view
// `info.bitmap.pixel` = [col,row] and the O(1) `resolveMatrixTooltip` fills the badge.
//
// RECONCILED from the stale TESTS.md text ("cluster + gene value"): the delivered tooltip
// uses GENERIC naming — its default fields are Group / Feature / Value / Cell
// (see tooltipModel.buildMatrixTooltipFields), NOT "cluster"/"gene". We assert the
// group + value readout (plus the feature/cell coordinate rows).
test('TEST-7 heatmap hover surfaces the group + value tooltip, then hides', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'heatmap-enriched')

  await expectSomeCanvasRendered(page)

  // The deck.gl canvas lives inside the ChartCanvas testid container (railTrack overlays
  // are plain <div>s, so this is the only canvas in the view).
  const canvas = page.locator('[data-testid="viz-heatmap-view"] canvas').first()
  const box = await canvas.boundingBox()
  expect(box, 'heatmap canvas should have a layout box').not.toBeNull()

  const tooltip = page.locator('[data-testid="viz-tooltip"]')

  // Sweep an interior grid until picking lands on a heatmap texel and the tooltip mounts.
  // The interior avoids the left/top dendrogram gutter + the right annotation track.
  let appeared = false
  if (box) {
    outer: for (let gy = 0.25; gy <= 0.75 && !appeared; gy += 0.1) {
      for (let gx = 0.2; gx <= 0.7; gx += 0.06) {
        await page.mouse.move(box.x + box.width * gx, box.y + box.height * gy)
        await page.waitForTimeout(120)
        if (await tooltip.isVisible()) {
          appeared = true
          break outer
        }
      }
    }
  }
  expect(appeared, 'hovering the heatmap should surface the viz-tooltip badge').toBe(true)

  // The rich readout: group (row label) + value + the feature/cell coordinate rows.
  await expect(tooltip).toBeVisible()
  const text = (await tooltip.innerText()).trim()
  expect(text, `tooltip text: ${text}`).toContain('Group')
  expect(text, `tooltip text: ${text}`).toContain('Value')
  // feature + cell-coordinate rows are part of the delivered default field set.
  expect(text, `tooltip text: ${text}`).toContain('Feature')
  expect(text, `tooltip text: ${text}`).toContain('Cell')

  // Move the pointer off the heatmap (over the sidebar) → picking returns null → hide.
  await page.mouse.move(10, 10)
  await expect(tooltip).toBeHidden()

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
