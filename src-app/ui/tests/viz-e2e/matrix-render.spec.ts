import { test, expect } from '@playwright/test'
import { canvasNonBlank, trackErrors } from './_helpers'

// TEST-73 (covers ITEM-56): the matrix / gallery conformance sweep. Walk EVERY (moderate)
// story registered in the sidebar, in BOTH light and dark, click each, and assert its WebGL
// canvas mounts + renders non-blank with ZERO console errors. This is the view-kind ×
// state × theme render matrix across the whole showcase.
//
// Harness notes (blessed surface = headless SOFTWARE WebGL / swiftshader):
//  • The two 1M-point Scale/perf stories (`perf-scatter`, `chunked-scatter`) are EXCLUDED
//    here — mounting/tearing them down under software WebGL stalls the driver, and they are
//    fully exercised by perf.spec.ts against fresh pages. (Task: "skip the heaviest 1M
//    stories' long sweeps.")
//  • Each theme runs on a FRESH page load so swiftshader's live-context budget resets
//    between passes (a single pass of ~30 sequential canvas mounts is fine; accumulating a
//    second pass on top of the first exhausts the software driver).
//  • `data-progressive` (streaming worker) + `image-tile` are likewise EXCLUDED: the progressive
//    stream stalls the software driver mid-sweep (a `page.click` timed out), and each has its own
//    dedicated e2e (data-progressive.spec.ts / the image-tile spec). Same rationale as the 1M stories.
const HEAVY = new Set(['perf-scatter', 'chunked-scatter', 'data-progressive', 'image-tile'])
// Stories that INTENTIONALLY render an error state (not a healthy WebGL canvas) + emit an
// expected console error — excluded from the non-blank / no-console-error conformance sweep.
const EXPECTED_ERROR = new Set(['viz-load-error'])
// Controls/STATE-only stories that INTENTIONALLY render no WebGL canvas (their surface is DOM:
// rails, swatches, tables) — excluded from the non-blank-CANVAS assertion but STILL swept for
// console errors below. `session-state-save-restore` proves the save/restore round-trip via the
// VisualMap rail + dataZoom rail + override swatch (its own spec asserts a DOM pixel signature).
const NO_CANVAS = new Set(['session-state-save-restore'])

test('TEST-73 every story renders non-blank in light + dark with no console error', async ({ page }) => {
  // Walks EVERY story × light+dark under software WebGL — inherently long and grows with the
  // story count; needs a large budget (240s was exceeded mid-walk as heavy stories were added).
  test.setTimeout(600_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })

  const allIds = await page.$$eval('[data-testid^="showcase-story-"]', els =>
    els.map(e => (e.getAttribute('data-testid') ?? '').replace('showcase-story-', '')),
  )
  const ids = allIds.filter(id => !HEAVY.has(id) && !EXPECTED_ERROR.has(id))
  expect(ids.length, 'should discover multiple non-heavy stories').toBeGreaterThan(5)

  for (const themeName of ['light', 'dark'] as const) {
    // Fresh page per theme so the software-WebGL context budget resets.
    await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
    if (themeName === 'dark') {
      await page.click('[data-testid="showcase-theme-toggle"]')
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.vizTheme))
        .toBe('dark')
    }

    for (const id of ids) {
      const before = bag.errors.length
      await page.click(`[data-testid="showcase-story-${id}"]`, { timeout: 20_000 })
      await page.waitForTimeout(1200)

      if (!NO_CANVAS.has(id)) {
        const nb = await canvasNonBlank(page, 0)
        expect(nb, `[${themeName}/${id}] canvas should render non-blank pixels`).toBeGreaterThan(0)
      }

      const newErrors = bag.errors.slice(before)
      expect(
        newErrors,
        `[${themeName}/${id}] no console/page errors: ${newErrors.slice(0, 3).join(' | ')}`,
      ).toHaveLength(0)
    }
  }
})
