import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { runQcToCompletion, seedRunnableExpression } from './_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-36 (ITEM-36) — a job's TERMINAL status raises a STICKY toast (duration: Infinity, DEC-16)
// that does NOT auto-dismiss; clicking its "View job" action opens the Jobs pane deep-linked to
// that job_id, and dismisses the toast. The toast fires on an observed non-terminal→terminal
// transition, so it needs a REAL completed compute JOB (seeded runnable `.h5ad` → qc.10x run).
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// CYTO_ENV_ROOTFS_DIR). WIRED (was DEFERRED) — see flow-guidance.spec.ts. The gate is a
// describe-level `test.skip`, so a capability-less run reports it as skipped rather than
// silently dropping it from collection (`../14-workbench/_analysis.ts`).

test.describe('job-completion sticky toast → Jobs pane (ITEM-36)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a terminal job raises a sticky toast whose "View job" opens the job details + dismisses', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Job Toast ${Date.now()}`)
    await seedRunnableExpression(request, id, 'PBMC')
    await openWorkbench(page, id)

    // Drive qc.10x to a real completed job (a real non-terminal→terminal transition).
    await runQcToCompletion(page)

    // The sticky toast appears (Sonner) and reports the job finished.
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /finished/i }).first()
    await expect(toast).toBeVisible({ timeout: 30_000 })
    // Sticky: still present after well past any default auto-dismiss window.
    await page.waitForTimeout(6_000)
    await expect(toast).toBeVisible()

    // Its "View job" action deep-links the Jobs pane to that job_id and dismisses the toast.
    await toast.getByRole('button', { name: 'View job' }).click()
    await expect(page.getByTestId('workbench-jobs-detail')).toBeVisible({ timeout: 20_000 })
    await expect(toast).toHaveCount(0)
  })
})
