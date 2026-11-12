import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { runQcToCompletion, seedRunnableExpression } from './_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-35 (ITEM-35) — on QC completion the user is told what the run PRODUCED and offered a
// DERIVED next-step launch action ("Open Cell filter"). The next step is derived from the
// producer→consumer type graph (QC produces `metadata-column`; cell.filter consumes it), so a
// new downstream analysis appears automatically with no upstream edit. Drives a REAL completed
// qc.10x JOB over a real counts matrix (seeded runnable `.h5ad` → sandbox run).
//
// ── WHERE THE GUIDANCE IS READ, amended for the manifest/UI separation ───────────────────
//
// This used to assert `workbench-flow-guidance-qc.10x` — the RUN PANE's copy. `qc.10x` declares
// `ui:`, so it is run from its own declarative pane and `AnalysisRunPanel` renders no run
// surface for it at all (INV-4: the fallback form it would otherwise build omits an input the
// view supplies, and a Run from it completed with that input unset). The run pane's guidance is
// therefore unreachable for this analysis.
//
// The PROPERTY is untouched, because the guidance was authored ONCE and rendered in BOTH places
// (`AnalysisFlowGuidance`'s own header says so): the status-keyed JOB DETAILS render the same
// component under the testid `JobFlowGuidance` hands it. Every sub-element this spec asserts on
// is derived from that prop (`${testid}-produced`, `${testid}-<downstream analysis id>`), so the
// three beats — what it DID, what it PRODUCED, what's NEXT — are asserted verbatim, just at the
// surface that still exists. `job-details-guidance.spec.ts` asserts that this surface is REACHED
// at all; this spec is the one that asserts what it CONTAINS.
//
// HOST-CAPABILITY-gated on TXR_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// TXR_ENV_ROOTFS_DIR). The gate is a describe-level `test.skip`, so a container-only run still
// COLLECTS this spec and REPORTS it as skipped with the env var to set — see
// `../14-workbench/_analysis.ts` for why it is not an `if (REAL) { … }` wrapper.

/** The testid `JobFlowGuidance` passes to `AnalysisFlowGuidance`; every sub-element is
 *  `${GUIDANCE}-<part>`. */
const GUIDANCE = 'workbench-jobs-detail-guidance'

test.describe('QC completion → self-explaining next step (ITEM-35)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a completed QC run states its produced outputs + an "Open Cell filter" derived next step', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Flow Guidance ${Date.now()}`)
    await seedRunnableExpression(request, id, 'PBMC')
    await openWorkbench(page, id)

    // Run the analysis from its own declared form and wait for the declared completion.
    await runQcToCompletion(page)

    // Open the completed job's details through its own sticky completion toast (the route a
    // user takes — no pane seam), then read the status-keyed guidance there.
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /finished/i }).first()
    await expect(toast).toBeVisible({ timeout: 30_000 })
    await toast.getByRole('button', { name: 'View job' }).click()
    await expect(page.getByTestId('workbench-jobs-detail')).toBeVisible({ timeout: 20_000 })

    const guidance = page.getByTestId(GUIDANCE)
    await expect(guidance).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`${GUIDANCE}-produced`)).toBeVisible()
    const nextStep = page.getByTestId(`${GUIDANCE}-cell.filter`)
    await expect(nextStep).toBeVisible()
    await expect(nextStep).toContainText(/Open Cell filter/i)
  })
})
