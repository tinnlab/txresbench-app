import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import {
  runToReview,
  viewBackedAnalyses,
  focusAwayFrom,
  expectAnalysisPaneRevealed,
  runPaneTabs,
  REAL_COMPUTE,
  REAL_COMPUTE_SKIP,
} from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-313 (ITEM-27) — light chaining (the TOP validated pain-point fix). From a completed
// artifact, "Start next analysis" opens the downstream analysis' config surface.
//
// HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// TXR_ENV_ROOTFS_DIR): it needs a run to genuinely COMPLETE and produce an artifact
// whose datatype another analysis accepts.
//
// Gated by a describe-level `test.skip`, so a capability-less run COLLECTS this spec and
// REPORTS it as skipped with the env var to set (see `./_analysis.ts`).
//
// ── WHAT A CHIP OPENS, amended for the manifest/UI separation (INV-3/INV-4) ──────────────
//
// The chip has always gone through the ONE `analysis.launch` action, so it lands wherever a
// launcher click lands — and that now depends on the DOWNSTREAM analysis' own declaration: one
// that ships a form is REVEALED in its own pane, one that does not gets a run pane. The chip
// names the downstream id in its testid, so the spec reads that id off the DOM (as it always
// did) and then asks the registry which arm applies. Both arms are asserted; the branch is the
// routing contract, not a workaround.
//
// ── ONE KNOWN LOSS, named rather than left to be discovered ──────────────────────────────
//
// The chip's `inputs` PRE-SEED does not survive into a contributed pane. `analysis.launch`
// stashes it in the RUN pane's `paneState`, which a contributed view does not read (a view
// seeds its own inputs at mount and shows what it seeded). So on the reveal arm this spec
// asserts the downstream form OPENS, and no longer that the upstream artifact arrives
// pre-selected in it. That is a real affordance loss, recorded at the launch handler; INV-4 is
// the part that still holds (whatever the surface shows is what runs), and a spec must not
// claim a pre-seed the app does not perform.
//
// ── WHAT "OPENS" IS, and the assumption this spec used to encode ─────────────────────────
//
// The reveal arm asserted that the number of open panes GREW BY ONE. It never could: a
// declarative analysis' view pane is auto-mounted by the view reconcile, and the chip only
// appears for an analysis whose input this run just produced — so the downstream's pane is
// already open when the chip is clicked, and `analysis.launch` is idempotent by design ("focus
// the pane where it actually LIVES … and add one only if the user had dismissed it",
// `WorkbenchSection.tsx`). The spec was asserting an ADD against a product that performs a
// REVEAL. What a user gets is that analysis' surface in front of them, so that is the
// observable now — made non-vacuous by focusing a sibling first (`focusAwayFrom`), exactly as
// `analysis-launch-action.spec.ts` does for the launcher and ⌘K entry points.

test.describe('chaining — start next analysis from an artifact (ITEM-27)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a chaining chip on an artifact opens the downstream analysis config surface', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Chain ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)

    // A chaining chip appears only when a downstream analysis accepts a produced type. The chip's
    // testid carries the downstream analysis id, so the spec reads it off the DOM and asks the
    // registry which arm applies.
    //
    // NOTE the review's artifact-pane host supplies no `producedByAnalysisId`, so the PRODUCING
    // analysis is itself a chaining candidate and may be the chip picked here — which is exactly
    // why the reveal needs a reset step.
    const chip = page.locator('[data-testid^="workbench-artifact-chaining-"]').first()
    if (await chip.isVisible().catch(() => false)) {
      const chipTestid = (await chip.getAttribute('data-testid')) ?? ''
      const downstream = chipTestid.replace('workbench-artifact-chaining-', '')
      const viewBacked = await viewBackedAnalyses(page)
      const target = viewBacked.find(a => a.id === downstream)

      if (target) {
        // The downstream analysis is REVEALED in its own pane — and gets no run pane, which is
        // the half that would silently regress if the routing were reverted. Focus a sibling
        // first so "its tab is active" is a state the CHIP produced.
        await focusAwayFrom(page, target, viewBacked)
        await chip.click()
        await expectAnalysisPaneRevealed(page, target)
        await expect(
          runPaneTabs(page),
          'chaining into an analysis that ships its own form must not also open a run pane (INV-3)',
        ).toHaveCount(0)
      } else {
        // The downstream analysis has no form of its own → the run pane's fallback form, with
        // the upstream artifact pre-seeded into its input slot (the point of ITEM-27).
        await chip.click()
        await expect(page.getByTestId(`workbench-analysis-panel-${downstream}`)).toBeVisible({
          timeout: 20_000,
        })
      }
    } else {
      // No compatible downstream analysis for this output → no dead affordance shown.
      await expect(page.locator('[data-testid^="workbench-artifact-chaining"]')).toHaveCount(0)
    }
  })
})
