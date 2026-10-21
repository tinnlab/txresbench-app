/**
 * Acceptance spec (jobs-detail-contrast, TEST-1 — [acceptance] [invariant: INV-1]).
 *
 * INV-1: every gallery surface is runtime-clean of gating HIGH findings — the crawl fails on
 * any WCAG-AA contrast failure (fg vs effective bg below 4.5:1 for normal text), in BOTH
 * light and dark themes.
 *
 * The four jobs-detail surfaces rendered a secondary timing fragment (`· <relative>`) in
 * `text-muted-foreground/70` — the muted-foreground token at 70% alpha on 12px text — which
 * composited to 2.97:1 (light) / 4.24:1 (dark), both below AA. This spec proves the invariant
 * DIRECTLY: it runs axe's `color-contrast` rule (the canonical WCAG-AA check) scoped to the
 * `job-timing-meta` region on each surface × theme and asserts ZERO violations. It is RED
 * against the pre-fix token and green only once the fix holds — a real-browser proof, not a
 * className tautology.
 *
 * Scoped to `[data-testid="job-timing-meta"]` on purpose: it audits the fragment under test,
 * not the whole surface, so it can never fold un-triaged findings elsewhere on the surface
 * into the gate (the DEC-8 broadening hazard `playwright.visual.config.ts` warns about).
 *
 * Lives under `tests/visual/` (NOT `tests/e2e/**`, which the app's `playwright.config.ts`
 * sweeps into the full backend e2e run) and is registered in `gallery.config.json`
 * `visualSpecs`, so `npm run gate:ui`'s visual step runs it.
 *
 * Run standalone (backend-free; pick a free port on a shared box):
 *   GALLERY_PORT=1479 npx playwright test -c playwright.visual.config.ts jobs-detail-contrast.spec.ts
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { THEMES, openGallery } from './_gallery'

/** The jobs-detail surfaces whose timing meta the fix corrects (the four the runtime-health
 *  crawl flagged). A LITERAL, matching the slugs registered by `modules/jobs/gallery.tsx` and
 *  `modules/workbench/gallery.tsx` — the same slugs `gate:ui` crawls. */
const JOBS_DETAIL_SURFACES = [
  'jobs-drawer-detail-completed',
  'jobs-drawer-detail-failed',
  'jobs-drawer-detail-running',
  'workbench-jobs-detail',
] as const

const TIMING_META = '[data-testid="job-timing-meta"]'

for (const surface of JOBS_DETAIL_SURFACES) {
  for (const theme of THEMES) {
    test(`${surface} — timing meta passes WCAG-AA contrast (${theme})`, async ({ page }) => {
      await openGallery(page, { surface, state: 'seeded', theme })

      // The meta row must actually be present — an absent region would let the axe check pass
      // vacuously (nothing to fail). This is the positive control for the contrast assertion.
      const meta = page.getByTestId('job-timing-meta').first()
      await meta.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(meta).toContainText('·')

      const results = await new AxeBuilder({ page })
        .include(TIMING_META)
        .withRules(['color-contrast'])
        .analyze()

      expect(
        results.violations,
        `axe color-contrast violations on ${surface} (${theme}): ${JSON.stringify(
          results.violations.map(v => v.nodes.map(n => n.html)),
          null,
          2,
        )}`,
      ).toEqual([])

      // Also require axe to have RESOLVED the contrast pair (empty `incomplete`) — not merely
      // to have found no violation. axe can classify a color it cannot flatten (e.g. an
      // unresolved alpha/color-mix) as `incomplete` (needs-review) rather than a `violation`,
      // which would let `violations == []` pass VACUOUSLY on the very element under test.
      // Asserting `incomplete` is empty forces a real, decided AA pass. (Empirically the
      // pre-fix `/70` token produced a real `violations` entry — verified RED — so this only
      // hardens the proof against axe-version drift.)
      expect(
        results.incomplete,
        `axe color-contrast could not resolve (needs-review) on ${surface} (${theme}): ${JSON.stringify(
          results.incomplete.map(v => v.nodes.map(n => n.html)),
          null,
          2,
        )}`,
      ).toEqual([])
    })
  }
}
