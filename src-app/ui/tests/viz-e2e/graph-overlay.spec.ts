import { test, expect } from '@playwright/test'
import {
  openStory,
  canvasNonBlank,
  expectSomeCanvasRendered,
  trackErrors,
  canvasPixelSignature,
} from './_helpers'

// TEST-69 (covers ITEM-52/53): the graph-on-scatter surface renders the embedding
// scatter with a node-link lineage overlay. Toggling the overlay OFF keeps the base
// scatter rendering (no crash / no error); toggling it back ON restores the overlay.
test('TEST-69 graph overlay toggles off and on without breaking the scatter render', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'graph-on-scatter')

  await expect(page.getByTestId('graph-scatter-view')).toBeVisible()
  // Scatter + graph overlay render into a non-blank canvas.
  await expectSomeCanvasRendered(page)

  const toggle = page.getByTestId('graph-overlay-toggle')
  const pseudotime = page.getByTestId('graph-pseudotime-toggle')
  await expect(toggle).toBeVisible()
  // The overlay starts visible with pseudotime coloring ON.
  await expect(toggle).toBeChecked()
  await expect(pseudotime).toBeChecked()

  // Baseline pixels: overlay drawn + pseudotime-colored edges/nodes.
  const sigOverlayColored = await canvasPixelSignature(page, 0)
  expect(sigOverlayColored).not.toBe('no-canvas')

  // DOWNSTREAM PROOF #1 — overlay OFF vs ON: the base scatter must still render, but the
  // edges/nodes must be GONE (pixels change). A no-op toggle would leave them identical.
  await toggle.uncheck()
  await page.waitForTimeout(700)
  await expect(toggle).not.toBeChecked()
  expect(await canvasNonBlank(page, 0), 'scatter still renders with overlay OFF').toBeGreaterThan(0)
  const sigOverlayOff = await canvasPixelSignature(page, 0)
  expect(sigOverlayOff, 'overlay OFF must remove edges/nodes from the canvas (pixels change)').not.toBe(
    sigOverlayColored,
  )

  // Toggle it back ON — overlay restored, pseudotime coloring preserved.
  await toggle.check()
  await page.waitForTimeout(700)
  await expect(toggle).toBeChecked()
  expect(await canvasNonBlank(page, 0), 'scatter + overlay render with overlay ON').toBeGreaterThan(0)

  // DOWNSTREAM PROOF #2 — pseudotime coloring flat vs colored: recoloring the overlay
  // by its ORDER value must move pixels vs the flat default.
  await pseudotime.uncheck()
  await page.waitForTimeout(700)
  await expect(pseudotime).not.toBeChecked()
  const sigFlat = await canvasPixelSignature(page, 0)
  expect(sigFlat, 'pseudotime coloring OFF must recolor the overlay (flat ≠ pseudotime)').not.toBe(
    sigOverlayColored,
  )

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
