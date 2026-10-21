import { test, expect } from '@playwright/test'
import {
  openStory,
  canvasNonBlank,
  canvasPixelSignature,
  trackErrors,
  vizTest,
} from './_helpers'

// TEST (covers the headline TranscriptView per-gene GPU show/hide): the ≤128-category
// `DataFilterExtension({ categorySize: 1 })` path is a UNIFORM toggle — deck folds the
// visible category codes into a 128-bit `categoryBitMask` uvec4 and applies its
// category→bit transform to the per-point (binary) `getFilterCategory` attribute, so a
// toggle hides the right points WITHOUT re-uploading positions/colors. That correctness
// rests on subtle deck.gl behavior, so this spec renders in a real GL context and asserts
// the filter actually MOVES PIXELS (the anti-inert check): "Hide all" must collapse the
// canvas to ~0 non-blank pixels (not merely flip a count). A future deck upgrade that
// silently broke the binary-attribute category transform would fail this test.
//
// Generic naming: "gene" is only the demo term for a categorical CODE; a transcript is a
// POINT carrying one category. The story starts with EVERY gene visible, so the initial
// render is the "show all" baseline.
test('per-gene GPU filter actually hides/shows points (anti-inert)', async ({ page }) => {
  // The blessed harness renders under software WebGL (swiftshader); the story's 500k-point
  // fixture drawn across four full renders (baseline → hide → top-10 → show-all) is legitimately
  // slow there (seconds on real hardware, ~minutes on swiftshader), so this heavy anti-inert
  // spec needs a generous budget well above the 60s default.
  test.setTimeout(240_000)
  const bag = trackErrors(page)
  await openStory(page, 'spatial-transcripts')

  // 1) Baseline: every gene visible → the point cloud renders non-blank.
  const baseline = await canvasNonBlank(page, 0)
  expect(baseline, 'transcript points render non-blank at baseline (all genes visible)').toBeGreaterThan(500)
  const sigBaseline = await canvasPixelSignature(page, 0)
  expect(sigBaseline).not.toBe('no-canvas')

  const total = await vizTest<number>(page, 'totalTranscripts')
  expect(total, 'the fixture reports a total transcript count').toBeGreaterThan(0)

  // 2) Hide all → the GPU filter must actually blank the canvas. THIS is the anti-inert
  // assertion: if the filter were a no-op (count flips but the uniform never masks the
  // points), the pixels would NOT change and this would fail.
  await page.getByRole('button', { name: 'Hide all', exact: true }).click()
  await page.waitForTimeout(800)
  const hidden = await canvasNonBlank(page, 0)
  expect(hidden, 'hiding every gene collapses the point cloud to ~0 non-blank pixels').toBeLessThan(
    Math.max(1, baseline * 0.01),
  )
  const sigHidden = await canvasPixelSignature(page, 0)
  expect(sigHidden, 'the render changed when all genes were hidden (not inert)').not.toBe(sigBaseline)
  expect(await vizTest<number>(page, 'visibleTranscripts'), 'no transcripts visible when all hidden').toBe(0)

  // 3) Top 10 genes → a partial view: strictly MORE than hidden, strictly LESS than all.
  await page.getByRole('button', { name: 'Top 10 genes', exact: true }).click()
  await page.waitForTimeout(800)
  const partial = await canvasNonBlank(page, 0)
  expect(partial, 'showing the top 10 genes renders more than the fully-hidden view').toBeGreaterThan(
    hidden,
  )
  expect(partial, 'the top 10 genes render fewer points than all genes').toBeLessThan(baseline)
  const visiblePartial = await vizTest<number>(page, 'visibleTranscripts')
  expect(visiblePartial, 'top-10 visible count is a strict subset of the total').toBeGreaterThan(0)
  expect(visiblePartial, 'top-10 visible count is a strict subset of the total').toBeLessThan(total)

  // 4) Show all → the point cloud recovers to the baseline (the filter is reversible and
  // the recovery is byte-identical — the visible set is rebuilt identical to mount).
  await page.getByRole('button', { name: 'Show all', exact: true }).click()
  await page.waitForTimeout(800)
  const recovered = await canvasNonBlank(page, 0)
  expect(recovered, 'showing all genes recovers to ~the baseline point count').toBeGreaterThan(
    baseline * 0.9,
  )
  const sigRecovered = await canvasPixelSignature(page, 0)
  expect(sigRecovered, 'show-all recovers the exact baseline render (reversible filter)').toBe(
    sigBaseline,
  )

  // 5) No console/page errors throughout.
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
