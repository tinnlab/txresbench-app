import { type APIRequestContext, expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from './_helpers'

// TEST-16 [ITEM-15 / ITEM-17] — the dataset-detail **Supporting files** surface.
// Drives the real `SupportingFilesPanel` against the real backend (NO
// `page.route()` mocking — project rule):
//   1. On a CONVERTED dataset the Supporting-files section renders and the "Add
//      supporting file" control is offered (converted ⇒ its declared axes exist).
//   2. The user picks a target AXIS from the dataset's DECLARED axes (cells/genes,
//      overlaid onto `single-cell/anndata` at boot) and drops a CSV → the endpoint
//      links it `role=supporting` and the new row appears (no manual reload).
//   3. A second supporting file added OUT OF BAND (REST, a different SSE origin)
//      appears in the still-open page WITHOUT `page.reload()` — proving the
//      `sync:dataset` notify-and-refetch path (ITEM-17).
//   4. On an UNCONVERTED dataset the Add control is hidden behind the
//      "Convert this dataset first" hint.
//
// A dataset is "converted" once its primary import has populated `metadata`
// (obs/var shape). The frontend gate is `metadata`-non-empty; we seed that
// directly via `POST /datasets {datatype, metadata}` so the surface is reachable
// WITHOUT the sandbox rootfs (the import converter needs it, unavailable on this
// box). The dataset's datatype `single-cell/anndata` carries the `cells`/`genes`
// axis overlay, so the axis picker offers exactly those.
//
// COVERAGE NOTE — the live integration REACHING a coverage summary (matched/
// missing/extra) requires the sandbox rootfs to actually run the `annotation-
// integrate` converter (unavailable here). So this spec asserts up to the row
// appearing + its integration STATUS reflected (queued/integrating). The
// integrated-with-coverage and failed-with-reason renderings are covered by the
// component gallery (TEST-18: `datasets-supporting` cell) under the gate:ui
// runtime-health harness, and the real alignment+coverage output by the backend
// integration tests (TEST-15 / TEST-24, rootfs-gated).

const AXES_DATATYPE = 'single-cell/anndata' // carries the cells/genes axis overlay
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** Create a "converted" dataset (typed + non-empty metadata) so the Supporting
 *  panel treats it as import-complete and offers the Add control. */
async function createConvertedDataset(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const r = await request.post(`${BACKEND}/api/datasets`, {
    headers: auth(token),
    data: {
      name,
      datatype: AXES_DATATYPE,
      metadata: { n_obs: 100, n_vars: 50, layers: ['counts'] },
    },
  })
  expect(r.ok(), `create converted dataset ${name}`).toBeTruthy()
  return r.json()
}

/** Create an UNCONVERTED dataset (typed but no metadata yet). */
async function createUnconvertedDataset(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const r = await request.post(`${BACKEND}/api/datasets`, {
    headers: auth(token),
    data: { name, datatype: AXES_DATATYPE }, // metadata omitted → {} → not converted
  })
  expect(r.ok(), `create unconverted dataset ${name}`).toBeTruthy()
  return r.json()
}

/** Add a supporting annotation table via the REST endpoint (out-of-band mutation
 *  used to drive the `sync:dataset` path). */
async function addSupportingApi(
  request: APIRequestContext,
  token: string,
  datasetId: string,
  filename: string,
  axis: string,
): Promise<void> {
  const r = await request.post(`${BACKEND}/api/datasets/${datasetId}/supporting-files`, {
    headers: auth(token),
    multipart: {
      file: { name: filename, mimeType: 'text/csv', buffer: Buffer.from('barcode,label\nAAAC,Tcell\n') },
      axis,
      kind: 'annotation_table',
    },
  })
  expect(r.ok(), `add supporting ${filename}`).toBeTruthy()
}

test('supporting files: Add gated on converted, axis pick + CSV drop, live row, sync-without-reload — TEST-16', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ds = await createConvertedDataset(request, admin, `supporting-${Date.now()}.h5ad`)

  await loginAsOwner(page)
  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()

  // --- The Supporting-files tab renders the section. ---
  await page.getByRole('tab', { name: 'Supporting files' }).click()
  await expect(page.getByTestId('dataset-tab-supporting')).toBeVisible()
  const panel = page.getByTestId('dataset-supporting')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Supporting files', { exact: true })).toBeVisible()
  // Converted ⇒ NO "convert first" hint, and the Add control is offered.
  await expect(page.getByTestId('dataset-supporting-not-converted')).toHaveCount(0)
  await expect(page.getByTestId('dataset-supporting-count')).toHaveText('0')
  const addBtn = page.getByTestId('dataset-supporting-add')
  await expect(addBtn).toBeVisible()

  // --- Add: open the form, pick a DECLARED axis, drop a CSV, submit. ---
  await addBtn.click()
  await expect(page.getByTestId('dataset-supporting-form')).toBeVisible()

  // The axis picker offers ONLY the dataset's declared axes (cells/genes).
  await page.getByTestId('dataset-supporting-axis').click()
  await expect(page.getByRole('option', { name: /Cells/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Genes/ })).toBeVisible()
  await page.getByRole('option', { name: /Cells/ }).click()

  // Drop a CSV into the annotation dropzone (kit Upload renders a real <input>).
  await page
    .locator('[data-testid="dataset-supporting-file-input"] input[type="file"]')
    .setInputFiles([
      { name: 'cell_types.csv', mimeType: 'text/csv', buffer: Buffer.from('barcode,cell_type\nAAAC,Tcell\n') },
    ])
  await expect(page.getByTestId('dataset-supporting-file')).toContainText('cell_types.csv')

  const submit = page.getByTestId('dataset-supporting-submit')
  await expect(submit).toBeEnabled()
  await submit.click()

  // The store refetches the dataset on success → the new supporting row appears
  // WITHOUT a manual page reload, and its integration STATUS is reflected. (Live
  // coverage requires the rootfs — see the COVERAGE NOTE above.)
  await expect(page.getByTestId('dataset-supporting-count')).toHaveText('1', { timeout: 30_000 })
  const rows = page.getByTestId('dataset-supporting-rows')
  await expect(rows).toBeVisible()
  await expect(rows.locator('[data-testid^="dataset-supporting-row-"]')).toHaveCount(1)
  // The status tag is present + non-empty (Queued / Integrating… depending on the
  // enqueue — a rootfs-free box never reaches Integrated/coverage).
  const statusTag = rows.locator('[data-testid^="dataset-supporting-status-"]').first()
  await expect(statusTag).toBeVisible()
  await expect(statusTag).not.toBeEmpty()

  // --- sync:dataset — an OUT-OF-BAND supporting add (REST, different SSE origin)
  // reaches this open page WITHOUT reload (notify-and-refetch, ITEM-17). ---
  await addSupportingApi(request, admin, ds.id, 'gene_meta.tsv', 'genes')
  await expect(page.getByTestId('dataset-supporting-count')).toHaveText('2', { timeout: 30_000 })
  await expect(rows.locator('[data-testid^="dataset-supporting-row-"]')).toHaveCount(2)
})

test('supporting files: Add is hidden on an unconverted dataset (convert-first hint) — TEST-16', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ds = await createUnconvertedDataset(request, admin, `unconverted-${Date.now()}.h5ad`)

  await loginAsOwner(page)
  await page.goto(`/datasets/${ds.id}`)
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()
  await page.getByRole('tab', { name: 'Supporting files' }).click()
  await expect(page.getByTestId('dataset-tab-supporting')).toBeVisible()

  // Not converted ⇒ the convert-first hint shows and the Add control is withheld.
  await expect(page.getByTestId('dataset-supporting-not-converted')).toBeVisible()
  await expect(page.getByTestId('dataset-supporting-add')).toHaveCount(0)
  await expect(page.getByTestId('dataset-supporting-empty')).toBeVisible()
})
