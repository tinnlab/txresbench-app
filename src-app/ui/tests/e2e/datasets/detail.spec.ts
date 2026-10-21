import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken, uploadDatasetApi } from './_helpers'

// TEST-34 [ITEM-16] — the `/datasets/:id` detail page. Asserts the three tabs the page
// actually has — Contents / Supporting files / Lineage — the Contents inspector (info +
// files table), and that each tab's panel mounts.
//
// REWRITTEN. This spec used to assert a fourth "Pipeline" tab and drive a processor
// launch from it (`pipeline-timeline` → `pipeline-processor-import.h5ad` →
// `pipeline-form-run` → `pipeline-job`). That tab was removed ON PURPOSE by `e4ac4af7`
// — "feat(datasets): remove the Pipeline tab from the detail page (processing lives in
// the workbench/analysis flow)", the entire content of that commit, recorded as FB-19 in
// that round's HUMAN_FEEDBACK artifact: the detail page's job is inspect (Contents) +
// provenance (Lineage); running processors belongs in the workbench. `DatasetDetailPage`
// now types its tab union as exactly `'contents' | 'supporting' | 'lineage'`, and
// `PipelineTimeline.tsx` survives only as a gallery story. So the old leg asserted a
// surface that is intentionally gone — it went unnoticed because the removal arrived as
// mid-round human feedback, outside the round's enumerated test plan.
//
// The launch path is NOT lost: `import.h5ad` / `anndata.import` became `trigger:
// on-ingest` converters that auto-run (and are filtered out of any launcher by
// `launcherAvailability.ts`), the human launch surface is the workbench launcher
// (`tests/e2e/14-workbench/`), and backend `POST /api/datasets/{id}/process` is
// untouched.
test('dataset detail: Contents / Supporting files / Lineage tabs — TEST-34', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ds = await uploadDatasetApi(request, admin, `detail-${Date.now()}.h5ad`)

  await loginAsOwner(page)
  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()
  await expect(page.getByTestId('dataset-detail-name')).toHaveText(ds.name)

  // --- The tab strip offers exactly these three. ---
  const tabs = page.getByTestId('dataset-detail-tabs')
  await expect(tabs).toBeVisible()
  await expect(tabs.getByRole('tab')).toHaveText(['Contents', 'Supporting files', 'Lineage'])
  // Non-vacuous negative control: the removed tab is absent, asserted against the very
  // strip that was just proved to render tabs at all — so this cannot pass by finding
  // no tab strip.
  await expect(tabs.getByRole('tab', { name: 'Pipeline' })).toHaveCount(0)

  // --- Contents tab (default): info descriptions + files table. ---
  await expect(page.getByTestId('dataset-tab-contents')).toBeVisible()
  await expect(page.getByTestId('dataset-contents-info')).toBeVisible()
  await expect(page.getByTestId('dataset-files-table')).toBeVisible()

  // --- Supporting files tab: the panel mounts (empty / not-converted / rows). ---
  await tabs.getByRole('tab', { name: 'Supporting files' }).click()
  await expect(page.getByTestId('dataset-tab-supporting')).toBeVisible()
  await expect(page.getByTestId('dataset-supporting')).toBeVisible()

  // --- Lineage tab: the forward-provenance surface renders (empty until a run
  // completes; compute cannot complete in this container — see vertical-slice). ---
  await tabs.getByRole('tab', { name: 'Lineage' }).click()
  await expect(page.getByTestId('dataset-tab-lineage')).toBeVisible()
  await expect(
    page.getByTestId('dataset-lineage').or(page.getByTestId('dataset-lineage-empty')),
  ).toBeVisible()
})
