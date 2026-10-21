import { test, expect } from '@playwright/test'
import {
  openStory,
  expectSomeCanvasRendered,
  trackErrors,
  canvasNonBlank,
  canvasPixelSignature,
} from './_helpers'

// TEST-22 (covers ITEM-16): the node-link GRAPH overlay (a generic GraphData lineage —
// the "trajectory" reconciled to a generic node-link overlay, DEC-28/34) draws over the
// embedding scatter in ONE OrthographicView. We assert the composited canvas is non-blank,
// then toggle the overlay off → on via `graph-overlay-toggle` and assert it re-renders
// with no console error.
test('TEST-22 node-link graph overlay draws over the scatter and toggles', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'graph-on-scatter')

  await expect(page.locator('[data-testid="graph-scatter-view"]')).toBeVisible()
  await expectSomeCanvasRendered(page)

  const withOverlay = await canvasNonBlank(page, 0)
  expect(withOverlay, 'scatter + graph overlay renders non-blank').toBeGreaterThan(0)

  const toggle = page.locator('[data-testid="graph-overlay-toggle"]')
  const pseudotime = page.locator('[data-testid="graph-pseudotime-toggle"]')
  // The story boots overlay ON with pseudotime coloring ON.
  await expect(toggle).toBeChecked()
  await expect(pseudotime).toBeChecked()

  // Baseline pixels: overlay drawn + edges/nodes colored by pseudotime.
  const sigOverlayColored = await canvasPixelSignature(page, 0)
  expect(sigOverlayColored).not.toBe('no-canvas')

  // DOWNSTREAM PROOF #1 — overlay OFF vs ON changes the pixels (edges/nodes disappear).
  await toggle.uncheck()
  await page.waitForTimeout(800)
  await expect(toggle).not.toBeChecked()
  expect(await canvasNonBlank(page, 0), 'base scatter still renders with overlay off').toBeGreaterThan(0)
  const sigOverlayOff = await canvasPixelSignature(page, 0)
  expect(sigOverlayOff, 'hiding the graph overlay must remove edges/nodes (pixels change)').not.toBe(
    sigOverlayColored,
  )

  // Restore the overlay (pseudotime state is preserved → colored again).
  await toggle.check()
  await page.waitForTimeout(800)
  await expect(toggle).toBeChecked()
  expect(await canvasNonBlank(page, 0), 'overlay re-renders after toggling on').toBeGreaterThan(0)

  // DOWNSTREAM PROOF #2 — pseudotime coloring flat vs colored changes the pixels.
  await pseudotime.uncheck()
  await page.waitForTimeout(800)
  await expect(pseudotime).not.toBeChecked()
  const sigFlat = await canvasPixelSignature(page, 0)
  expect(sigFlat, 'turning off pseudotime coloring must recolor the overlay (flat ≠ colored)').not.toBe(
    sigOverlayColored,
  )

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
