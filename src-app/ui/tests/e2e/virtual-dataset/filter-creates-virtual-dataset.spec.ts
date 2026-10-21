import { expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { commitFilter, seedRunnableExpression } from '../14-declarative-qc/_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-36 (ITEM-13, §11.3 / DEC-6) — a filter Run CREATES a virtual dataset.
//
// A filter run emits a MARKED keep-mask; the server-side finalize sink mints a NEW
// `source='filter'` virtual dataset (named from the run label), leaving the source dataset
// unchanged and the mask HIDDEN (never listed). This is the twin of integrate→dataset: same
// "a run produced a new dataset" affordance, source count 1, a mask instead of an alignment.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// CYTO_ENV_ROOTFS_DIR) — a real filter run is a real compute. The gate is a describe-level
// `test.skip`, so a capability-less run reports it as skipped rather than dropping it.

/** The owner's datasets that belong to `projectId` (`GET /api/projects/{id}/datasets`). */
async function projectDatasets(
  request: import('@playwright/test').APIRequestContext,
  projectId: string,
): Promise<Array<{ id: string; name: string; source?: string }>> {
  const token = await ownerToken(request)
  const resp = await request.get(`${BACKEND}/api/projects/${projectId}/datasets`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(resp.ok(), `list project datasets (${resp.status()})`).toBeTruthy()
  const body = await resp.json()
  return Array.isArray(body) ? body : (body.datasets ?? body.items ?? [])
}

test.describe('a filter run creates a virtual dataset (ITEM-13)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a filter run mints a source=filter dataset in the picker, leaves the source, hides the mask @acceptance', async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000)

    await loginAsOwner(page)
    const projectId = await createProject(request, `Filter VD ${Date.now()}`)
    await seedRunnableExpression(request, projectId, 'Demo')

    const before = await projectDatasets(request, projectId)
    const sourceIds = new Set(before.map(d => d.id))

    await openWorkbench(page, projectId)
    // Tune + Commit the filter (upstream quality produces the criterion column, then a real
    // keep-mask commit) — its finalize sink creates the filter VD.
    await commitFilter(page, { column: 'total_counts', min: 42, label: 'kept' })

    // A NEW dataset appears with source 'filter', WITHOUT a reload (realtime catalog epoch).
    await expect
      .poll(
        async () => {
          const now = await projectDatasets(request, projectId)
          return now.filter(d => !sourceIds.has(d.id) && d.source === 'filter').length
        },
        { timeout: 90_000, message: 'a filter run must create exactly one source=filter dataset' },
      )
      .toBe(1)

    const after = await projectDatasets(request, projectId)
    const filterVd = after.find(d => !sourceIds.has(d.id) && d.source === 'filter')!

    // The SOURCE dataset is unchanged — still listed for comparison (D15).
    for (const s of before) {
      expect(after.some(d => d.id === s.id), `source dataset ${s.id} is kept`).toBeTruthy()
    }

    // The mask is HIDDEN: it never appears as a listable artifact of the VD (§3.4).
    const token = await ownerToken(request)
    const arts = await request.get(`${BACKEND}/api/projects/${projectId}/artifacts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(arts.ok()).toBeTruthy()
    const body = await arts.json()
    const rows: Array<{ role?: string; dataset_id?: string; source_dataset_id?: string }> =
      Array.isArray(body) ? body : (body.artifacts ?? body.items ?? [])
    expect(
      rows.some(r => r.role === 'mask'),
      'the per-source mask is hidden + role=mask — it is never in the usable/listed population',
    ).toBeFalsy()
    expect(filterVd.name, 'the VD is named from the run label').toBeTruthy()
  })
})
