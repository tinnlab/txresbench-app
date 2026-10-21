import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-415 (ITEM-39) — multi-artifact compare. A run's same-kind outputs render side-by-side
// (tiled compare, else a merged renderer). The compare DISPATCH is pinned deterministically
// by `ArtifactPanel.test.ts`; here we assert the review renders. (The former per-analysis
// run-history LIST was folded into the graph-centric Provenance pane.)
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_DIR).

test.describe('artifact compare (ITEM-39)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a run reviews its outputs (same-kind outputs tile)', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Compare ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)
    // The review is present (multiple same-kind outputs tile via ArtifactCompareView).
    await expect(page.locator('[data-testid^="workbench-artifact-review"]').first()).toBeVisible()
  })
})
