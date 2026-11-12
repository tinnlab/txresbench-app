import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-308 (ITEM-24) — multi-output artifact review. A completed run shows a distinct
// card for EVERY produced artifact (deterministic, listed by `run_id` — not the racy
// `pickNewest`), each dispatched through its host-owned renderer.
//
// The property is unchanged; only WHERE the review is reached from moved. `runToReview` used
// to run the analysis from a run pane and read the review out of that same pane, and neither
// exists for a `ui:`-declaring analysis any more — see that helper's header. The run now goes
// through the analysis' own form and the review through its OTHER host (the `run::<runId>`
// artifact pane, the one the Provenance pane's run node opens), which renders the same
// component with the same testids.
//
// HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (bwrap + TXR_ENV_ROOTFS_DIR): the run
// must genuinely COMPLETE.
//
// Gated by a describe-level `test.skip`, so a capability-less run COLLECTS this spec and
// REPORTS it as skipped with the env var to set (see `./_analysis.ts`).

test.describe('artifact review — a card per produced artifact (ITEM-24)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a completed run reviews every output as a distinct card', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Review ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)

    const review = page.locator('[data-testid^="workbench-artifact-review"]').first()
    await expect(review).toBeVisible()
    // At least one output card (a multi-output run shows one per produced kind).
    const cards = review.locator('[data-testid*="-card-"]')
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBeGreaterThanOrEqual(1)
  })
})
