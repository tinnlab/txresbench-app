import { expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedRunnableExpression } from './_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-E4 (e2e) [covers: ITEM-22, ITEM-23] — a re-homed processor renders + registers in the
// workbench from DATA ONLY (`packages/{anndata-import,import-h5ad,cellranger}/manifest.yaml`
// `contributes.analyses`, no `builtins/<name>/extension.ts`): the launchable `cellranger.count`
// appears in the launcher, the on-ingest converters (`anndata.import` / `import.h5ad`) register but
// stay launcher-hidden (`trigger:'on-ingest'`), and — REAL — the converter auto-runs on a freshly
// ingested dataset. Confirms the live import path survives the `builtins/` deletion (DEC-22).
//
// The registration + launcher split is PURE (from DATA, no compute). The converter AUTO-RUN on a
// real ingest is REAL-compute — gated on TXR_E2E_REAL_COMPUTE. This describe mixes a PURE test
// with a gated one, so the gate here is a BODY-level `test.skip` on the gated test alone (a
// describe-level one would wrongly skip the pure sibling). Either way it is REPORTED as skipped
// with its reason, never dropped from collection — see `../14-workbench/_analysis.ts`. The describe
// has no `beforeEach`, so the body-level form costs nothing on a capability-less host.

test.describe('re-homed converters register from DATA + survive the builtins deletion (TEST-E4)', () => {
  test('cellranger.count launchable; converters registered-but-hidden (DATA-only registration)', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Rehomed ${Date.now()}`)
    await openWorkbench(page, id)

    await page
      .locator('[data-testid^="workbench-launcher-row-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })

    // The launchable re-homed analysis is present in the launcher (from DATA).
    await expect(page.getByTestId('workbench-launcher-row-cellranger.count')).toBeVisible()
    // The on-ingest converters register but are launcher-hidden.
    await expect(page.getByTestId('workbench-launcher-row-anndata.import')).toHaveCount(0)
    await expect(page.getByTestId('workbench-launcher-row-import.h5ad')).toHaveCount(0)

    // All three re-homed contributions ARE registered (from manifest DATA) — proven via the
    // read-only registry seam (resolvable-by-id even when launcher-hidden).
    const registered = await page.evaluate(() => {
      const reg = (window as unknown as { __workbenchRegistry?: { analyses: () => string[] } }).__workbenchRegistry
      return reg?.analyses() ?? []
    })
    for (const rehomed of ['cellranger.count', 'anndata.import', 'import.h5ad']) {
      expect(registered, `${rehomed} registered from DATA`).toContain(rehomed)
    }
  })

  test('the on-ingest converter auto-runs on a freshly ingested dataset', async ({ page, request }) => {
    test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)
    await loginAsOwner(page)
    const id = await createProject(request, `Rehomed AutoRun ${Date.now()}`)
    // A freshly ingested dataset — the on-ingest converter resolves + runs to a produced
    // expression artifact (the live import path). `seedRunnableExpression` IS that path now:
    // it uploads through the real streaming endpoint and waits on the converter's own terminal
    // `processing_status`, failing loudly with the converter's reason. Before this branch the
    // seed inserted catalog rows directly and enqueued no converter at all, so this test's
    // subject never happened and the only assertion left (`canvas-host` attached) held for a
    // project with no import in it.
    const seeded = await seedRunnableExpression(request, id, 'Ingest')

    // The artifact was PRODUCED BY A RUN, not inserted: the on-ingest converter is the thing
    // under test, and `run_id` is what distinguishes its output from a seeded row.
    const admin = await ownerToken(request)
    const listed = await request.get(`${BACKEND}/api/projects/${id}/artifacts`, {
      headers: { authorization: `Bearer ${admin}` },
    })
    expect(listed.ok(), `list artifacts -> ${listed.status()}`).toBeTruthy()
    const rows = (await listed.json()) as { id: string; run_id?: string | null }[]
    const produced = rows.find(a => a.id === seeded.expression_artifact_id)
    expect(produced, 'the imported matrix is catalogued in the project').toBeTruthy()
    expect(
      produced?.run_id,
      'the expression artifact carries the id of the RUN that produced it — an on-ingest ' +
        'converter run. A null run_id would mean the row was inserted, not converted.',
    ).toBeTruthy()

    await openWorkbench(page, id)
    await expect(page.getByTestId('workbench-canvas-host')).toBeAttached({ timeout: 20_000 })
  })
})
