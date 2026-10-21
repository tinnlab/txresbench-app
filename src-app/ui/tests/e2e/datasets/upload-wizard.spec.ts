import { expect, test } from '@playwright/test'
import { loginOwnerToDatasets } from './_helpers'

// TEST-22 [ITEM-12/15] — the type-first upload WIZARD journey for `.h5ad`
// (`single-cell/anndata`). Drives the real `UploadPanel`: pick the data TYPE first,
// which REVEALS exactly the file input(s) that type declares (DEC-7/9/11); the
// AnnData type reveals ONE `.h5ad` dropzone, the 10x type reveals the 3-slot
// manifest. Pick one `.h5ad`, submit, and assert the new typed dataset lands in the
// library. Real streaming upload + real DB — no `page.route()` API mocking.
//
// COMPUTE NOTE: the on-ingest SOMA converter needs the sandbox rootfs (unavailable
// on this box) AND a valid AnnData file to produce embeddings; this spec seeds a
// SYNTHETIC `.h5ad`, so it asserts only the UI-reachable truth — the per-type input
// reveal, the ready-gating, and that the dataset ROW appears (the upload endpoint
// creates the row regardless of whether the background conversion completes). The
// "fully-converted-with-embeddings" leg is covered (gated) by the anndata-inspector
// spec + the backend integration tests (real pbmc3k fixture).
test('type-first wizard: type reveals its file input(s) → upload one .h5ad → dataset appears — TEST-22', async ({
  page,
}) => {
  await loginOwnerToDatasets(page)
  const ts = Date.now()
  const name = `wizard-${ts}.h5ad`

  await page.getByTestId('datasets-upload-button').click()
  const dialog = page.getByTestId('dataset-upload-dialog')
  await expect(dialog).toBeVisible()

  // Before a type is chosen NOTHING is revealed and submit is disabled — the type
  // selector is the single entry point to the wizard body.
  await expect(page.getByTestId('dataset-upload-single')).toHaveCount(0)
  await expect(page.getByTestId('dataset-upload-member-slots')).toHaveCount(0)
  await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()

  // --- Affordance check A: the 10x type reveals the 3-slot MANIFEST + mode toggle
  // (and NOT the single dropzone). Proves the per-type input reveal. ---
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: '10x matrix (MTX trio)' }).click()
  await expect(page.getByTestId('dataset-upload-mode')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-member-slots')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-slot-matrix-input')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-slot-barcodes-input')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-slot-features-input')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-single')).toHaveCount(0)

  // --- Affordance check B: switch to the AnnData type → the SINGLE `.h5ad` dropzone
  // is revealed (and the 10x manifest is torn down; switching type discards state). ---
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: 'AnnData' }).click()
  await expect(page.getByTestId('dataset-upload-single')).toBeVisible()
  await expect(page.getByTestId('dataset-upload-single-input')).toBeVisible()
  // The declared affordance is DERIVED from the chosen type, never hardcoded: the
  // prompt names the registry's `title`, and the input's accept glob comes from that
  // type's `ingest.extensions`. (It used to read the literal "Drag your .h5ad here" —
  // a format name baked into the one component whose contract is that the catalog is
  // DATA. Asserting the derived pair is strictly stronger than asserting the literal.)
  await expect(page.getByTestId('dataset-upload-single')).toContainText('AnnData')
  await expect(
    page.locator('[data-testid="dataset-upload-single-input"] input[type="file"]'),
  ).toHaveAttribute('accept', /\.h5ad/)
  await expect(page.getByTestId('dataset-upload-member-slots')).toHaveCount(0)
  // Nothing picked yet → submit stays disabled (ready-gating).
  await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()

  // --- Pick one `.h5ad` → the picked-file chip shows + submit enables. ---
  await page
    .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
    .setInputFiles([
      { name, mimeType: 'application/octet-stream', buffer: Buffer.from(`anndata-${ts}`) },
    ])
  await expect(page.getByTestId('dataset-upload-single-file')).toContainText(name)
  await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled()

  // --- Submit → the dialog closes on success and the library refetches. ---
  await page.getByTestId('dataset-upload-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  // The new typed dataset appears as a library row. Scope to the table — the name
  // also appears in the sidebar Recent-datasets widget.
  await expect(
    page.getByTestId('datasets-table').getByRole('link', { name }),
  ).toBeVisible({ timeout: 30_000 })
})
