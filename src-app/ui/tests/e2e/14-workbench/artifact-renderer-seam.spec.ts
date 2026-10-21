import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-413 (ITEM-38) — the per-analysis artifact-view SEAM (host-owned dispatch). Every
// produced artifact is dispatched through `ArtifactPanel` → its registered renderer (else
// the honest heuristic default). The named-ref resolver + fallback are pinned
// deterministically by the unit test `ArtifactPanel.test.ts`.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_DIR).

test.describe('artifact-renderer seam — host-owned dispatch (ITEM-38)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a produced artifact is dispatched through a host-owned artifact panel', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Seam ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)

    const panel = page
      .locator('[data-testid^="workbench-artifact-"]')
      .filter({ hasNot: page.locator('[data-testid^="workbench-artifact-review"]') })
      .first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  })
})
