import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, canvasNonBlank } from './_helpers'
import { canvasPixelSignature } from './_pixelsig'

// TEST-57 (covers ITEM-29..32): the Controls surface. The draggable visualMap DragRail
// sets a [lo,hi] value range that filters the scatter ON THE GPU (DataFilterExtension);
// a categorical Legend and a continuous Colorbar sit alongside. We drag the visualMap
// hi-handle and assert the range readout changes (proving the scatter's filter uniform
// responds) + the canvas stays non-blank, click a legend item (fade/toggle), and assert
// the colorbar is present — all with zero console errors.
//
// NOTE: this story exposes no separate dataZoom slider (visualMap IS the DragRail here);
// the legend + colorbar are the other two control primitives, both exercised below.
test('TEST-57 visualMap drag filters + legend/colorbar controls respond', async ({ page }) => {
  // Heavier interaction test (rail drag + repeated swiftshader pixel reads) — extend the
  // per-test budget past the 60s default.
  test.slow()
  const bag = trackErrors(page)
  await openStory(page, 'controls-visualmap')

  await expect(page.locator('[data-testid="viz-scatter-canvas"]')).toBeVisible()
  await expectSomeCanvasRendered(page)

  // ── legend: toggle a category (fade) ───────────────────────────────────────
  // Done before the drag so the DOM is calm; a `toPass` retry tolerates any re-mount.
  const legendItem = page.locator('[data-testid="viz-legend-item-0"]')
  await expect(legendItem).toBeVisible()
  await expect(legendItem).toHaveAttribute('aria-pressed', 'true')
  await expect(async () => {
    await page.locator('[data-testid="viz-legend-item-0"]').click({ timeout: 2000 })
    await expect(page.locator('[data-testid="viz-legend-item-0"]')).toHaveAttribute('aria-pressed', 'false')
  }).toPass({ timeout: 15_000 })

  // ── colorbar: present alongside ────────────────────────────────────────────
  await expect(page.locator('[data-testid="viz-colorbar"]')).toBeVisible()

  // ── visualMap: drag the hi-handle down to shrink the value range ────────────
  const rail = page.locator('[data-testid="viz-visualmap-rail"]')
  await expect(rail).toBeVisible()
  const hiHandle = page.locator('[data-testid="viz-visualmap-rail-handle-hi"]')
  const maxReadout = page.locator('[data-testid="viz-visualmap-max"]')

  const railBox = await rail.boundingBox()
  const handleBox = await hiHandle.boundingBox()
  expect(railBox).not.toBeNull()
  expect(handleBox).not.toBeNull()
  const maxBefore = (await maxReadout.textContent())?.trim() ?? ''
  // Pixel digest of the scatter BEFORE the filter drag. The visualMap range feeds the
  // scatter's `DataFilterExtension.filterRange` GPU uniform, so shrinking the range must
  // FADE/DROP points → the rendered frame changes. Assert on this (not just the readout
  // number) so the test fails if the range→GPU-filter wiring were inert.
  const sigBefore = await canvasPixelSignature(page, 0)
  expect(sigBefore, 'scatter renders a readable frame before the drag').not.toBe('')

  if (railBox && handleBox) {
    // vertical rail: top = max. Press the hi-handle, drag DOWN toward the rail centre
    // (lower value) so the upper clamp — and the GPU filterRange — changes.
    const startX = handleBox.x + handleBox.width / 2
    const startY = handleBox.y + handleBox.height / 2
    // Drag the hi-handle WELL down the rail (to ~75% down = keep only the bottom ~25% of the
    // value range) so a LARGE fraction of points fall out of `filterRange` — an unambiguous
    // frame change that overdraw can't mask (many overdrawn pixels lose their top point).
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, railBox.y + railBox.height * 0.5, { steps: 10 })
    await page.mouse.move(startX, railBox.y + railBox.height * 0.75, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(600)
  }

  const maxAfter = (await maxReadout.textContent())?.trim() ?? ''
  expect(maxAfter, `visualMap upper clamp should change on drag (was "${maxBefore}")`).not.toEqual(maxBefore)
  expect(await canvasNonBlank(page, 0), 'scatter still renders after the filter drag').toBeGreaterThan(0)

  // The REAL downstream effect: the scatter frame changed because the GPU filter dropped the
  // now-out-of-range points. Poll (deck redraws async) for the digest to differ from the
  // pre-drag baseline — this fails if the visualMap→filterRange→scatter path were inert.
  await expect
    .poll(() => canvasPixelSignature(page, 0), {
      message: 'scatter pixels change after the visualMap filter drag (points filtered/faded)',
      timeout: 15_000,
    })
    .not.toBe(sigBefore)

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
