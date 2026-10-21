import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { runToReview, REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-309 (ITEM-25) — the in-artifact LINEAGE. The review renders the linear
// inputs → run → outputs chain from `Provenance.run` (reusing `ProvenanceView` +
// methods), matching the run's real artifact ids.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_DIR).

test.describe('artifact lineage — inputs → run → outputs (ITEM-25)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a completed run renders its lineage chain in the artifact review', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Lineage ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    await runToReview(page, request, id)

    const lineage = page.locator('[data-testid^="workbench-artifact-lineage"]').first()
    await expect(lineage).toBeVisible({ timeout: 20_000 })
    // The chain shows the run node + at least one output tag.
    await expect(lineage.locator('[data-testid$="-run"]').first()).toBeVisible()
    await expect(lineage.locator('[data-testid*="-outputs"]').first()).toBeVisible()
  })
})
