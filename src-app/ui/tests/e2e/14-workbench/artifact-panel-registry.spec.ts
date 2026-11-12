import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-524 (ITEM-58 / ITEM-35) — the `ArtifactPanel` is a PURE classifier: a produced
// artifact is dispatched through `defaultForKind` to one of the three host renderers.
// ITEM-35 deleted the `resultRenderers` contribution branch that used to win over it (zero
// production contributors), so this now proves the "always renders something" guarantee:
// whatever the produced datatype, the panel mounts a renderer.
//
// HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (bwrap + TXR_ENV_ROOTFS_DIR).

test.describe('ArtifactPanel = pure classifier (ITEM-58 / ITEM-35)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a produced artifact always renders through the host artifact panel', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB ArtifactReg ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)

    // The ArtifactPanel wraps the rendered artifact (`workbench-artifact-<kind>`); no kind-regex
    // branch and no contribution branch is involved — StatCard / ProvenanceView / the
    // GenericResult universal fallback is chosen purely by `defaultForKind`.
    const panel = page
      .locator('[data-testid^="workbench-artifact-"]')
      .filter({ hasNot: page.locator('[data-testid^="workbench-artifact-review"]') })
      .first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  })
})
