import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, vizTest } from './_helpers'

// TEST-9 (covers ITEM-6/8): the multi-area selection tool folds a rectangle drag AND a
// polygon lasso into ONE combined selection. We drive the real pointer overlay (down/
// move/up for the rect; click-vertices + Finish for the polygon), assert the live
// selection COUNT updates via the story's `__VIZ_TEST__.selectionCount` hook (and the
// visible `selection-count` readout), exercise the subtract combine-mode, and require
// zero console/page errors throughout. Generic naming only (value/group, no gene/cluster).
test('TEST-9 rectangle + polygon multi-area selection updates the combined count', async ({ page }) => {
  // Heavier interaction test (two drags + polygon clicks + repeated swiftshader pixel
  // reads over a 120k-point scatter) — give it a wide wall-clock budget (the box can be
  // under concurrent-e2e contention, which triples step latency).
  test.setTimeout(300_000)
  const bag = trackErrors(page)
  await openStory(page, 'selection-multi-area')

  await expectSomeCanvasRendered(page)

  // ── rectangle drag ─────────────────────────────────────────────────────────
  await page.click('[data-testid="sel-tool-rect"]')
  await expect(page.locator('[data-testid="sel-tool-rect"]')).toHaveAttribute('aria-pressed', 'true')

  const overlay = page.locator('[data-testid="selection-draw-overlay"]')
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  // Drag a large rectangle across the middle of the plot so it captures fixture points.
  const rx0 = box.x + box.width * 0.2
  const ry0 = box.y + box.height * 0.2
  const rx1 = box.x + box.width * 0.8
  const ry1 = box.y + box.height * 0.8
  await page.mouse.move(rx0, ry0)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 })
  await page.mouse.move(rx1, ry1, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(500)

  const afterRect = await vizTest<number>(page, 'selectionCount')
  expect(afterRect, 'rectangle selection should select > 0 points').toBeGreaterThan(0)
  // the visible readout mirrors the hook
  await expect(page.locator('[data-testid="selection-count"]')).toContainText('selected')

  // ── polygon lasso (add mode) ───────────────────────────────────────────────
  await page.click('[data-testid="sel-tool-polygon"]')
  await expect(page.locator('[data-testid="sel-tool-polygon"]')).toHaveAttribute('aria-pressed', 'true')

  // Each pointer-down on the overlay drops a polygon vertex; drop a spread triangle+.
  const verts: Array<[number, number]> = [
    [box.x + box.width * 0.30, box.y + box.height * 0.25],
    [box.x + box.width * 0.75, box.y + box.height * 0.40],
    [box.x + box.width * 0.60, box.y + box.height * 0.80],
    [box.x + box.width * 0.25, box.y + box.height * 0.65],
  ]
  for (const [vx, vy] of verts) {
    await page.mouse.click(vx, vy)
    await page.waitForTimeout(80)
  }
  const finish = page.locator('[data-testid="sel-poly-finish"]')
  await expect(finish).toBeEnabled()
  await finish.click()
  await page.waitForTimeout(500)

  const afterPoly = await vizTest<number>(page, 'selectionCount')
  // The SelectionController emitted a COMBINED set (rect ∪ polygon), so the count must be
  // AT LEAST the rect-only count. This DISTINGUISHES a real union from "polygon replaces the
  // selection": the polygon triangle is far smaller than the large add-rect, so a replace
  // would DROP the count BELOW `afterRect`. A union never does.
  expect(afterPoly, 'combined rect+polygon selection should be > 0').toBeGreaterThan(0)
  expect(
    afterPoly,
    `union keeps the rect points (>= rect-only ${afterRect}); a replace would drop below it`,
  ).toBeGreaterThanOrEqual(afterRect)

  // ── subtract-mode: prove subtraction REMOVES points ─────────────────────────
  // Drag a subtract-rect squarely INSIDE the additive region (which spans ~0.2–0.8), so it
  // overlaps currently-selected points. The combine op is set-DIFFERENCE, so the count must
  // strictly DECREASE — a tautological `>= 0` would pass even if subtract were a no-op.
  await page.click('[data-testid="sel-tool-rect"]')
  await page.click('[data-testid="sel-mode-subtract"]')
  await expect(page.locator('[data-testid="sel-mode-subtract"]')).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 6 })
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62, { steps: 6 })
  await page.mouse.up()

  // The set-difference dropped the overlapped points → the combined count is STRICTLY less
  // than after the additive rect∪polygon. Fails if subtract were inert.
  await expect
    .poll(() => vizTest<number>(page, 'selectionCount'), {
      message: 'subtract-area removes points → count strictly decreases',
      timeout: 10_000,
    })
    .toBeLessThan(afterPoly)
  const afterSubtract = await vizTest<number>(page, 'selectionCount')
  expect(afterSubtract, 'a subtracted count is still a valid non-negative count').toBeGreaterThanOrEqual(0)

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
