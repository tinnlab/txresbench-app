import { test, expect } from '@playwright/test'
import {
  openStory,
  expectSomeCanvasRendered,
  trackErrors,
  canvasNonBlank,
  canvasPixelSignature,
} from './_helpers'

// #228 TEST-15 — A HUMAN SEES SPOTS ON TISSUE, AND THE REFUSAL WHEN THE FRAMES DIFFER.
//
// > *"the spot centres drawn on the tissue image at the declared transform … A human sees a
// >  misregistration instantly and sees nothing else about it."*   — design §7.5
//
// The unit and integration proofs next door establish that the right matrix is built and that the
// right layers are emitted. Neither shows a PICTURE. This does, on the real grid pane, in a real
// browser, on a real GPU — which is the only thing that can catch a placement that is arithmetically
// correct and visually absent (a layer routed to the wrong viewport, a matrix deck rejects, a point
// buffer that never uploads).
//
// The assertion is a PIXEL DIFFERENCE between the bound and refused states of ONE story, taken on
// the same canvas at the same size. That is what makes it about the overlay: a spec that only
// asserted "the canvas is non-blank" would pass with the points gone, because the raster is drawn
// in both states — which is precisely the shape of the failure this item exists to close.
test('TEST-15 the bound overlay draws spots on the raster; breaking the frame withdraws them', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'spatial-binding')

  await expect(page.locator('[data-testid="viz-spatial-binding"]')).toBeVisible()
  await expectSomeCanvasRendered(page)
  await expect(page.locator('[data-testid="viz-spatial-binding-state"]')).toContainText('BOUND')

  const boundPixels = await canvasNonBlank(page, 0)
  expect(boundPixels, 'the bound pane paints').toBeGreaterThan(0)
  const boundSig = await canvasPixelSignature(page, 0)
  expect(boundSig).not.toBe('no-canvas')

  // Break the FRAME — nothing else. The same raster, the same 160 positions, the same camera; the
  // only change is one declared `coordinate_space` string on the layout.
  await page.click('[data-testid="viz-spatial-binding-toggle"]')
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-testid="viz-spatial-binding-state"]')).toContainText('REFUSED')

  const refusedSig = await canvasPixelSignature(page, 0)
  // The PICTURE is still there — a refused binding withdraws the points, never the raster. A
  // version that hid the image too would satisfy "the pixels changed" and be a different bug.
  expect(await canvasNonBlank(page, 0), 'the refused pane still draws the raster').toBeGreaterThan(0)
  // …and the pixels DIFFER, which is the spots being gone. This is the assertion that fails if the
  // overlay was never on screen in the first place.
  expect(refusedSig, 'withdrawing the overlay must change what is painted').not.toBe(boundSig)

  // Restore, and the picture comes back to what it was — so the difference above is the overlay
  // and not some one-way state change.
  await page.click('[data-testid="viz-spatial-binding-toggle"]')
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-testid="viz-spatial-binding-state"]')).toContainText('BOUND')
  expect(await canvasPixelSignature(page, 0)).toBe(boundSig)

  // A refusal is legitimate and it is LOUD — but it is not an error. The console must stay clean
  // of errors in both states (the refusal is a `console.warn`, which is not collected here).
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// #228 TEST-15 (second leg) — THE POINTS ARE INSIDE THE FRAME THE RASTER IS FRAMED BY.
//
// ── WHAT THIS DOES NOT CLAIM, AND WHY THE FIRST VERSION WAS WRONG ────────────────────────────
//
// The first version of this test argued that a mis-placed layer would "slide" under a pan and
// asserted only that panning changes the composite and panning back restores it. A blind audit
// called that correctly: every layer in one `OrthographicView` shares the view matrix, so a
// WRONGLY-placed raster pans in lockstep and returns to an identical composite too. That version
// proved the camera is reversible and nothing else — it would have passed unchanged with the
// mutation it claimed to catch.
//
// What a browser CAN prove about "one frame" is this: at the camera that frames the RASTER, the
// POINTS are on screen. The pane's camera is seeded on the placed raster's extent (7000x9000 on
// this fixture), so if the points were in any other frame — unplaced, at the raster's pixel
// scale, at the coarsest level's scale — they would be a speck or off-screen entirely, and the
// bound and refused arms would paint the same thing. Asserting the difference EXISTS at the home
// camera AND still exists after a pan is a real, falsifiable statement about shared placement,
// and it is what this test now claims.
test('TEST-15 the overlay is inside the frame the raster is framed by, at rest and after a pan', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'spatial-binding')
  await expectSomeCanvasRendered(page)

  const difference = async (): Promise<[string, string]> => {
    await expect(page.locator('[data-testid="viz-spatial-binding-state"]')).toContainText('BOUND')
    const bound = await canvasPixelSignature(page, 0)
    await page.click('[data-testid="viz-spatial-binding-toggle"]')
    await page.waitForTimeout(1200)
    await expect(page.locator('[data-testid="viz-spatial-binding-state"]')).toContainText('REFUSED')
    const refused = await canvasPixelSignature(page, 0)
    await page.click('[data-testid="viz-spatial-binding-toggle"]')
    await page.waitForTimeout(1200)
    return [bound, refused]
  }

  const [homeBound, homeRefused] = await difference()
  expect(homeBound, 'the spots are visible at the camera that frames the raster').not.toBe(homeRefused)

  const canvas = page.locator('canvas').first()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(1200)

  const panned = await canvasPixelSignature(page, 0)
  expect(panned, 'panning moved the camera').not.toBe(homeBound)

  const [pannedBound, pannedRefused] = await difference()
  expect(
    pannedBound,
    'the spots are STILL on the raster after a pan — one camera moved both, and the points did ' +
      'not slide out of the picture',
  ).not.toBe(pannedRefused)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
