import { test, expect } from '@playwright/test'
import {
  openStory,
  expectSomeCanvasRendered,
  trackErrors,
  canvasNonBlank,
  canvasPixelSignature,
} from './_helpers'

// TEST-14 (covers ITEM-10): the `image` view-kind composites a raster IMAGE UNDERLAY
// (BitmapLayer) beneath affine-aligned spots on ONE GPU canvas. We assert the canvas
// renders non-blank (underlay + points), then drive the exposed underlay-opacity range
// control and assert it re-renders with no console error. Generic naming (spots/points).
test('TEST-14 image underlay + spots render and the opacity control is live', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'image-underlay')

  await expect(page.locator('[data-testid="viz-image-canvas"]')).toBeVisible()
  await expectSomeCanvasRendered(page)

  const before = await canvasNonBlank(page, 0)
  expect(before, 'image canvas renders non-blank content').toBeGreaterThan(0)

  // DOWNSTREAM PROOF: snapshot the composited (underlay + spots) PIXELS at full opacity.
  const sigBefore = await canvasPixelSignature(page, 0)
  expect(sigBefore).not.toBe('no-canvas')

  // Exposed dim control: drop the underlay opacity from 1.0 → 0.2.
  const opacity = page.locator('[data-testid="image-opacity"]')
  await expect(opacity).toBeVisible()
  await opacity.fill('0.2')
  await page.waitForTimeout(800)

  await expect(opacity).toHaveValue('0.2')
  const after = await canvasNonBlank(page, 0)
  expect(after, 'canvas still renders after opacity change').toBeGreaterThan(0)

  // The opacity change must actually APPLY on the GPU: dimming the raster underlay
  // repaints the whole underlay region, so the pixel signature MUST differ. Fails if the
  // opacity control were inert (value flips but no re-composite).
  const sigAfter = await canvasPixelSignature(page, 0)
  expect(sigAfter, 'lowering underlay opacity must dim the image (pixels change)').not.toBe(
    sigBefore,
  )

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
