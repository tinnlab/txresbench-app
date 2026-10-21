import { expect, test } from '@playwright/test'
import { loginOwnerToDatasets } from './_helpers'

// TEST-17 [ITEM-16] — the upload wizard's optional per-axis ANNOTATION slots.
// Picking the AnnData (`single-cell/anndata`) primary type REVEALS the optional
// per-axis annotation drop zones the type declares ("Cell annotations" +
// "Gene annotations", one per its cells/genes axes). Uploading a primary `.h5ad`
// PLUS a cell-annotation CSV creates ONE dataset (the annotation rides the same
// upload as a supporting part — DEC-23, it never spawns its own dataset) whose
// detail view shows the annotation as a `role='supporting'` file.
//
// Real streaming upload + real DB — no `page.route()` API mocking.
//
// COMPUTE NOTE: the on-ingest SOMA import + the annotation integrate both need the
// sandbox rootfs (unavailable on this box), so the assertions stop at "ONE dataset
// created, carrying the supporting file" (linked at upload time regardless of the
// background conversion). The alignment/coverage output is covered (gated) by the
// backend integration tests (TEST-10 / TEST-15). The synthetic `.h5ad`/CSV here
// exercise only the UI-reachable truth: the per-axis slot reveal + the one-dataset
// supporting link.
test('upload wizard: AnnData reveals annotation slots → primary + cell annotation = one dataset w/ supporting file — TEST-17', async ({
  page,
}) => {
  await loginOwnerToDatasets(page)
  const ts = Date.now()
  const primaryName = `annot-${ts}.h5ad`
  const cellCsvName = `cell_labels-${ts}.csv`

  await page.getByTestId('datasets-upload-button').click()
  const dialog = page.getByTestId('dataset-upload-dialog')
  await expect(dialog).toBeVisible()

  // --- Pick the AnnData type → the SINGLE .h5ad dropzone AND the optional per-axis
  // annotation slots are revealed (cells + genes). ---
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: 'AnnData' }).click()
  await expect(page.getByTestId('dataset-upload-single')).toBeVisible()
  const supporting = page.getByTestId('dataset-upload-supporting')
  await expect(supporting).toBeVisible()
  await expect(supporting.getByText('Cell annotations (CSV/TSV)', { exact: true })).toBeVisible()
  await expect(supporting.getByText('Gene annotations (CSV/TSV)', { exact: true })).toBeVisible()
  await expect(page.getByTestId('dataset-upload-supporting-cells-input')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-supporting-genes-input')).toBeVisible()

  // --- Provide the primary .h5ad + a cell annotation CSV (gene slot left empty —
  // the annotation slots are optional). ---
  await page
    .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
    .setInputFiles([{ name: primaryName, mimeType: 'application/octet-stream', buffer: Buffer.from(`anndata-${ts}`) }])
  await expect(page.getByTestId('dataset-upload-single-file')).toContainText(primaryName)

  await page
    .locator('[data-testid="dataset-upload-supporting-cells-input"] input[type="file"]')
    .setInputFiles([{ name: cellCsvName, mimeType: 'text/csv', buffer: Buffer.from('barcode,cell_type\nAAAC,Tcell\n') }])
  await expect(page.getByTestId('dataset-upload-supporting-cells-file')).toContainText(cellCsvName)

  // --- Submit → the dialog closes and the library refetches. ---
  await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled()
  await page.getByTestId('dataset-upload-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  // Exactly ONE dataset row is created for the primary (the annotation did NOT
  // spawn a second dataset — it's a supporting part of this one).
  const table = page.getByTestId('datasets-table')
  const rowLink = table.getByRole('link', { name: primaryName })
  await expect(rowLink).toBeVisible({ timeout: 30_000 })
  await expect(table.getByRole('link', { name: cellCsvName })).toHaveCount(0)

  // --- Open the created dataset → its Supporting-files tab lists the annotation as
  // a role='supporting' file. ---
  await rowLink.click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()
  await page.getByRole('tab', { name: 'Supporting files' }).click()
  await expect(page.getByTestId('dataset-tab-supporting')).toBeVisible()

  const rows = page.getByTestId('dataset-supporting-rows')
  await expect(rows).toBeVisible({ timeout: 30_000 })
  await expect(rows.locator('[data-testid^="dataset-supporting-row-"]')).toHaveCount(1)
  await expect(rows).toContainText(cellCsvName)
  // The count chip reflects the one supporting (role='supporting') file.
  await expect(page.getByTestId('dataset-supporting-count')).toHaveText('1')
})
