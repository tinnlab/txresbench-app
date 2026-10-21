import { test, expect } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// SESSION STATE SAVE / RESTORE (SESSION_STATE_PLAN capstone). The story mutates every serializable
// surface — a point SELECTION, the lifted per-plot dataZoom WINDOW, the lifted per-plot FILTER
// range, and a per-group COLOR OVERRIDE — then CAPTURES a data-independent `VizSessionState`,
// RESETS the interaction stores (visuals snap back to defaults), and RESTORES the snapshot.
//
// Two proofs of "restored EXACTLY":
//   1. value proof — the store readouts (selection length / zoom window / filter range / override
//      color) return to their mutated values, and the story's `restoredMatchesCaptured` deep-equal
//      flag is true.
//   2. PIXEL proof — an element screenshot of the story container taken BEFORE reset equals the
//      screenshot taken AFTER restore (the VisualMap rail, the dataZoom rail, and the override
//      swatch all render pixel-identically). DOM screenshots are deterministic (no WebGL), so
//      buffer equality is a sound "pixel signature".
test('session-state: mutate → capture → reset → restore round-trips exactly (values + pixels)', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'session-state-save-restore')

  const container = page.getByTestId('viz-session-state')
  await expect(container).toBeVisible()

  // Blur the active element before a screenshot so the focus RING on whichever button was last
  // clicked (capture vs restore) doesn't break the byte-equality of the pre-reset vs restored shots.
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())

  // Baseline — nothing mutated yet. Under the consolidated getOption model an UNTOUCHED dataZoom
  // window is NOT written to the store (the ValueDataZoom renders the full-domain fallback via
  // `activeValueWindow` without persisting it) — so it does not round-trip until explicitly set, and
  // the store readout is null. The render is still full-range (no visual change; the pixel proof below
  // is unaffected). The VisualMap filter is likewise unset until touched.
  expect(await vizTest<number>(page, 'sessionSelectionLength')).toBe(0)
  expect(await vizTest<{ lo: number; hi: number } | null>(page, 'sessionZoom')).toBeNull()
  expect(await vizTest<unknown>(page, 'sessionFilter')).toBeNull()

  // MUTATE every surface.
  await page.getByTestId('viz-session-mutate').click()
  await expect
    .poll(() => vizTest<number>(page, 'sessionSelectionLength'))
    .toBe(4)
  expect(await vizTest<{ lo: number; hi: number }>(page, 'sessionZoom')).toEqual({ lo: 20, hi: 60 })
  expect(await vizTest<[number, number]>(page, 'sessionFilter')).toEqual([30, 70])
  expect(await vizTest<string>(page, 'sessionOverrideColor')).toBe('#e11d48')

  // CAPTURE the snapshot.
  await page.getByTestId('viz-session-capture').click()
  await expect.poll(() => vizTest<boolean>(page, 'sessionHasCapture')).toBe(true)

  // Pixel signature of the fully-mutated render.
  await blur()
  const vizRow = page.getByTestId("viz-session-viz-row")
  const sigMutated = await vizRow.screenshot()

  // RESET — the interaction stores clear; the visuals snap back to defaults.
  await page.getByTestId('viz-session-reset').click()
  await expect.poll(() => vizTest<number>(page, 'sessionSelectionLength')).toBe(0)
  expect(await vizTest<unknown>(page, 'sessionFilter')).toBeNull()
  await blur()
  const sigReset = await vizRow.screenshot()
  // Sanity: reset actually changed the pixels (else the restore proof would be vacuous).
  expect(Buffer.compare(sigMutated, sigReset)).not.toBe(0)

  // RESTORE — every surface returns.
  await page.getByTestId('viz-session-restore').click()
  await expect.poll(() => vizTest<number>(page, 'sessionSelectionLength')).toBe(4)
  expect(await vizTest<{ lo: number; hi: number }>(page, 'sessionZoom')).toEqual({ lo: 20, hi: 60 })
  expect(await vizTest<[number, number]>(page, 'sessionFilter')).toEqual([30, 70])
  expect(await vizTest<string>(page, 'sessionOverrideColor')).toBe('#e11d48')
  // The deep-equal round-trip flag (a re-capture equals the captured interaction).
  await expect.poll(() => vizTest<boolean>(page, 'sessionRestoredMatches')).toBe(true)

  // PIXEL PROOF: the restored render is byte-identical to the pre-reset render.
  await blur()
  const sigRestored = await vizRow.screenshot()
  expect(Buffer.compare(sigMutated, sigRestored)).toBe(0)

  expect(bag.errors, `console errors: ${bag.errors.join('\n')}`).toEqual([])
})
