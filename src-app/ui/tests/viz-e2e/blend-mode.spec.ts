import { test, expect } from '@playwright/test'
import { openStory, trackErrors, canvasPixelSignature } from './_helpers'

// BLEND MODE Phase 1 — category → hue × continuous → lightness/alpha, in one GPU scatter mark.
// Two proofs:
//  (1) WIRING — `__VIZ_TEST__` confirms blend is enabled and BOTH per-point attributes (category
//      codes + normalized modValue) are bound, and the 2D legend has rows.
//  (2) RENDER — toggling blend OFF (single-channel, hue only) vs ON (hue + value modulation) must
//      CHANGE the rendered pixels. This is the real "the shader modulation actually happens" check
//      (the value ramp shifts lightness/alpha per point), not merely that a flag flipped.
test('scatter blend: category→hue × continuous→lightness modulates the render (wiring + pixels)', async ({
  page,
}) => {
  const bag = trackErrors(page)

  await openStory(page, 'scatter-blend')
  await expect(page.getByTestId('viz-blend-story')).toBeVisible()

  const viz = () =>
    page.evaluate(
      () => (window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__ ?? {},
    )

  // (1) Wiring: blend enabled by default, two attributes bound, 2D legend populated.
  await expect.poll(async () => (await viz()).blendEnabled, { timeout: 15_000 }).toBe(true)
  expect((await viz()).blendTwoAttrsBound, 'both colorValue (codes) + modValue attrs bound').toBe(true)
  expect((await viz()).blendLegendRows as number, '2D legend has a row per category').toBeGreaterThan(0)
  await expect(page.getByTestId('viz-blend-story').locator('canvas').first()).toBeVisible()

  // Blend ON pixel signature (hue + value modulation).
  const sigBlend = await canvasPixelSignature(page, 0)

  // (2) Toggle to single-channel (hue only) → the value modulation is removed.
  await page.getByTestId('viz-blend-toggle-btn').click()
  await expect.poll(async () => (await viz()).blendEnabled, { timeout: 10_000 }).toBe(false)
  await page.waitForTimeout(600) // let the recolor settle
  const sigHueOnly = await canvasPixelSignature(page, 0)

  // The rendered image must DIFFER — the continuous value genuinely modulates lightness/alpha.
  expect(sigHueOnly, 'blend vs single-channel must render different pixels').not.toBe(sigBlend)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// BLEND MODE Phase 2 — MULTI-column reduce: concat N categorical columns → one composite
// category (cross-product) + aggregate M continuous columns → one value, feeding the SAME
// Phase-1 hue × lightness encode.
// Two proofs:
//  (1) WIRING — toggling to multi-column enables the composite reduce (`blendComposite`) and the
//      2D legend grows to the composite domain (group × type ⇒ MORE rows than group alone).
//  (2) RENDER — the composite hue assignment + aggregated value modulation must CHANGE the pixels
//      vs the single-column blend (different categories → different hues → different render).
test('scatter blend Phase 2: multi-column reduce (composite category + aggregated value) rewires + repaints', async ({
  page,
}) => {
  const bag = trackErrors(page)

  await openStory(page, 'scatter-blend')
  await expect(page.getByTestId('viz-blend-story')).toBeVisible()

  const viz = () =>
    page.evaluate(
      () => (window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__ ?? {},
    )

  // Single-column blend is the default: composite OFF, legend has the single column's rows.
  await expect.poll(async () => (await viz()).blendEnabled, { timeout: 15_000 }).toBe(true)
  expect((await viz()).blendComposite, 'starts single-column').toBe(false)
  const singleRows = (await viz()).blendCompositeRows as number
  expect(singleRows, '2D legend has a row per single-column category').toBeGreaterThan(0)
  await expect(page.getByTestId('viz-blend-story').locator('canvas').first()).toBeVisible()
  const sigSingle = await canvasPixelSignature(page, 0)

  // (1) Toggle to the multi-column reduce (group+batch × mean(qcA,qcB)).
  await page.getByTestId('viz-blend-columns-btn').click()
  await expect.poll(async () => (await viz()).blendComposite, { timeout: 10_000 }).toBe(true)
  // The composite (group × batch) cross-product yields MORE categories than group alone.
  const compositeRows = (await viz()).blendCompositeRows as number
  expect(compositeRows, 'composite cross-product legend grows past the single column').toBeGreaterThan(
    singleRows,
  )
  // Blend is still enabled and both attributes stay bound through the reduce.
  expect((await viz()).blendEnabled).toBe(true)
  expect((await viz()).blendTwoAttrsBound).toBe(true)

  // (2) The composite hue re-assignment + aggregated modulation must repaint.
  await page.waitForTimeout(600) // let the recolor settle
  const sigComposite = await canvasPixelSignature(page, 0)
  expect(sigComposite, 'multi-column composite blend must render different pixels').not.toBe(sigSingle)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
