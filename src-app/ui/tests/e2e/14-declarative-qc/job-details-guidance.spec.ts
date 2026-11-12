import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { runQcToCompletion, seedRunnableExpression } from './_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-37 (ITEM-37) — a DONE job's details (processor-contributed, status-keyed) show the outputs
// + the DERIVED next-step launch action (the same `AnalysisFlowGuidance` the run pane renders).
// Needs a REAL completed compute JOB (seeded runnable `.h5ad` → qc.10x run).
//
// HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// TXR_ENV_ROOTFS_DIR). WIRED (was DEFERRED) — see flow-guidance.spec.ts. The gate is a
// describe-level `test.skip`, so a capability-less run reports it as skipped rather than
// silently dropping it from collection (`../14-workbench/_analysis.ts`).

test.describe('done-job details show status-keyed guidance (ITEM-37)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a completed job\'s details render the flow guidance (outputs + next-step launch)', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Job Details ${Date.now()}`)
    await seedRunnableExpression(request, id, 'PBMC')
    await openWorkbench(page, id)
    await runQcToCompletion(page)

    // Open the Jobs pane and its most-recent (done) job's details via the sticky toast.
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /finished/i }).first()
    await expect(toast).toBeVisible({ timeout: 30_000 })
    await toast.getByRole('button', { name: 'View job' }).click()
    const detail = page.getByTestId('workbench-jobs-detail')
    await expect(detail).toBeVisible({ timeout: 20_000 })

    // The status-keyed guidance renders in the job details (outputs + derived next step).
    await expect(page.getByTestId('workbench-jobs-detail-guidance')).toBeVisible({ timeout: 20_000 })
  })
})
