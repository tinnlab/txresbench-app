import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-533 (ITEM-63) + the multi-run compare VIEW (ITEM-65) — the iteration loop
// end-to-end against the REAL backend.
//
// ── WHAT THIS SPEC USED TO ASSERT, AND WHY MOST OF IT IS STRUCK ──────────────────────────
//
// It drove: a completed run → "Re-run with tweaked params" → a run pane pre-seeded
// with that run's params → Run again → the before/after `workbench-rerun-diff-*` → "Compare
// runs" → the N-run compare's second legend column. Three of those legs are gone for this
// analysis, and NOT because a selector moved.
//
// That analysis declares `ui:` — it ships its own form — and the re-run pane mounts the SAME
// `AnalysisRunPanel` the run pane does. `reseedFromRun` recovers the source run's PARAMS and no
// inputs (a `RunNodeDto` carries `params`), so a re-run of a view-backed analysis re-launched
// with the view's own inputs silently dropped: the compute reads a missing optional input as an
// empty match set, so the job COMPLETED and reported zeros — the same defect the launcher path
// had, one button further along. `AnalysisRunPanel` now refuses (INV-4) and signposts the
// analysis' own pane instead. `RerunPane.tsx` says so in its own header: a genuine re-run for
// such an analysis needs the view's STATE re-seeded, which is a different capability (view state
// is not run params) and was deliberately not invented.
//
// So the diff (`workbench-rerun-diff-*`) and the N-run compare (`workbench-compare-*`) have NO
// SHIPPED SUBJECT left to reach them through this route: the re-run entry point is the artifact
// review's, and every analysis a review can be produced by today declares `ui:`. Those legs are
// STRUCK here rather than rewritten against a surface that cannot be driven — an invented,
// unverifiable rewrite is exactly the "assumed-synchronous" failure this ledger already records
// twice.
//
// WHAT WOULD RESTORE THEM, precisely: either (a) a form-backed analysis (no `ui:`) a person can
// complete a run of — every shipped one today is a launcher-hidden on-ingest converter — or
// (b) re-run learning to re-seed a declarative view's STATE, at which point the re-run pane
// again mounts a runnable form and the original spec is restorable almost verbatim. The compare
// VIEW itself stays separately reachable (`preview-compare.spec.ts` opens a `compare` pane
// through the pane seam) and its param-preview half is covered there.
//
// WHAT REMAINS, and it is the part that matters most: the re-run entry point still exists on a
// completed run's review, and following it must NOT produce a second rival form. That is the
// INV-4 guarantee at the browser tier — the only tier where all four hosts of
// `AnalysisRunPanel` are actually mounted — and it is asserted below.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_DIR): it needs one
// run to genuinely complete. Gated by a describe-level `test.skip`, so a capability-less run
// COLLECTS this spec and REPORTS it as skipped with the env var to set (see `./_analysis.ts`).

test.describe('re-run entry from a completed run (ITEM-63)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('the review offers a re-run, and the re-run pane refuses to build a rival form for a view-backed analysis', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Rerun ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    // ── A completed predecessor run + its review.
    const { analysisId } = await runToReview(page, request, id)

    // ── The review still offers "Re-run with tweaked params" (editor-only affordance).
    const rerunBtn = page.getByTestId('workbench-artifact-review-rerun').first()
    await expect(rerunBtn).toBeVisible({ timeout: 20_000 })
    await rerunBtn.click()

    const rerunPane = page.locator('[data-testid^="workbench-rerun-pane-"]').first()
    await expect(rerunPane).toBeVisible({ timeout: 20_000 })

    // ── The producing analysis' panel mounts inside it — as a SIGNPOST, not a form.
    //    This is what the struck legs are replaced by: a re-run of an analysis that owns its
    //    form must not offer to run it from params alone, because the inputs the view supplies
    //    are not in those params and their absence is silent.
    const panel = rerunPane.getByTestId(`workbench-analysis-panel-${analysisId}`)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(
      panel.getByTestId(`workbench-analysis-form-${analysisId}`),
      'the re-run pane must not synthesize a slot-only form for an analysis that ships one (INV-4)',
    ).toHaveCount(0)
    await expect(
      panel.getByTestId(`workbench-analysis-run-${analysisId}`),
      'and it must not offer a Run that would dispatch with the view inputs unset',
    ).toHaveCount(0)
    // It says WHERE the analysis is configured rather than rendering an empty pane.
    await expect(panel.getByTestId(`workbench-analysis-own-form-${analysisId}`)).toBeVisible()
  })
})
