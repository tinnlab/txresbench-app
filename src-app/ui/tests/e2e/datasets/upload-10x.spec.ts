import { expect, test } from '@playwright/test'
import { loginOwnerToDatasets } from './_helpers'

// TEST-23 [ITEM-14] — the 10x (MTX trio) branch of the type-first upload WIZARD
// (`single-cell/matrix-mtx`). The manifest type declares THREE named members
// (matrix.mtx / barcodes.tsv / features.tsv) OR a single `.zip`/`.tar` archive
// alternative (the `Segmented` mode toggle). This spec drives the real `UploadPanel`:
//   1. individual-files mode — pick all three → upload → dataset appears.
//   2. archive mode — pick one `.zip` → upload → dataset appears.
//   3. missing-member validation — only 2 of 3 members → the wizard refuses the
//      upload (submit stays disabled; the missing slot + the "or a .zip/.tar"
//      alternative remain the affordance).
// Real streaming upload + real DB — no `page.route()` API mocking.
//
// COMPUTE NOTE: same as the `.h5ad` wizard spec — the seeded members are SYNTHETIC
// (not a valid 10x matrix), so the assertions stop at "the dataset ROW appears"
// (created at upload time); the background SOMA conversion needs the sandbox rootfs
// + valid inputs and is covered (gated) by the inspector spec + backend integration
// tests. The upload/validation UI surface runs independently of the converter.

const fileArg = (name: string, body: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(body),
})

/** Open the wizard and select the 10x (MTX trio) type. Returns the dialog locator. */
async function open10xWizard(page: import('@playwright/test').Page) {
  await page.getByTestId('datasets-upload-button').click()
  const dialog = page.getByTestId('dataset-upload-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: '10x matrix (MTX trio)' }).click()
  await expect(page.getByTestId('dataset-upload-mode')).toBeVisible()
  return dialog
}

test.describe('10x (MTX trio) upload wizard', () => {
  test('individual files mode: pick all three members → upload → dataset appears — TEST-23', async ({
    page,
  }) => {
    await loginOwnerToDatasets(page)
    const ts = Date.now()
    const dialog = await open10xWizard(page)

    // Files mode is the default → the three named slots render.
    await expect(page.getByTestId('dataset-upload-member-slots')).toBeVisible()
    // Two of three members → NOT ready yet (validation gate).
    await page
      .locator('[data-testid="dataset-upload-slot-matrix-input"] input[type="file"]')
      .setInputFiles([fileArg('matrix.mtx', `mtx-${ts}`)])
    await page
      .locator('[data-testid="dataset-upload-slot-barcodes-input"] input[type="file"]')
      .setInputFiles([fileArg('barcodes.tsv', `bc-${ts}`)])
    await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()

    // The third member completes the trio → ready → submit enabled.
    await page
      .locator('[data-testid="dataset-upload-slot-features-input"] input[type="file"]')
      .setInputFiles([fileArg('features.tsv', `ft-${ts}`)])
    await expect(page.getByTestId('dataset-upload-slot-matrix-file')).toContainText('matrix.mtx')
    await expect(page.getByTestId('dataset-upload-slot-barcodes-file')).toContainText('barcodes.tsv')
    await expect(page.getByTestId('dataset-upload-slot-features-file')).toContainText('features.tsv')
    await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled()

    await page.getByTestId('dataset-upload-submit').click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    // The trio groups into ONE dataset (named after the first member).
    await expect(
      page.getByTestId('datasets-table').getByRole('link', { name: 'matrix.mtx' }).first(),
    ).toBeVisible({ timeout: 30_000 })
  })

  test('archive mode: pick one .zip of the trio → upload → dataset appears — TEST-23', async ({
    page,
  }) => {
    await loginOwnerToDatasets(page)
    const ts = Date.now()
    const zipName = `tenx-${ts}.zip`
    const dialog = await open10xWizard(page)

    // Switch the mode toggle to the archive alternative → the single archive
    // dropzone replaces the 3-slot manifest.
    await page.getByTestId('dataset-upload-mode-opt-archive').click()
    await expect(page.getByTestId('dataset-upload-archive-field')).toBeVisible()
    await expect(page.getByTestId('dataset-upload-member-slots')).toHaveCount(0)
    // No archive picked yet → not ready.
    await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()

    await page
      .locator('[data-testid="dataset-upload-archive-input"] input[type="file"]')
      .setInputFiles([fileArg(zipName, `PK\u0003\u0004-${ts}`)])
    await expect(page.getByTestId('dataset-upload-archive-file')).toContainText(zipName)
    await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled()

    await page.getByTestId('dataset-upload-submit').click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(
      page.getByTestId('datasets-table').getByRole('link', { name: zipName }),
    ).toBeVisible({ timeout: 30_000 })
  })

  test('missing-member validation: only 2 of 3 members → the wizard refuses to upload — TEST-23', async ({
    page,
  }) => {
    await loginOwnerToDatasets(page)
    const ts = Date.now()
    await open10xWizard(page)

    // Fill only matrix + features (features present, barcodes missing).
    await page
      .locator('[data-testid="dataset-upload-slot-matrix-input"] input[type="file"]')
      .setInputFiles([fileArg('matrix.mtx', `mtx-${ts}`)])
    await page
      .locator('[data-testid="dataset-upload-slot-features-input"] input[type="file"]')
      .setInputFiles([fileArg('features.tsv', `ft-${ts}`)])

    // The affordance for "needs 3 files or a zip": submit is DISABLED (no upload
    // possible), the missing member's dropzone is still open (not a picked file),
    // and the archive-mode alternative is offered. (This UI expresses the
    // requirement structurally — a disabled submit + the open slot + the archive
    // toggle — rather than a dedicated error string.)
    await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()
    await expect(page.getByTestId('dataset-upload-slot-matrix-file')).toBeVisible()
    await expect(page.getByTestId('dataset-upload-slot-features-file')).toBeVisible()
    // barcodes has NO picked-file chip — its dropzone input is still present.
    await expect(page.getByTestId('dataset-upload-slot-barcodes-file')).toHaveCount(0)
    await expect(page.getByTestId('dataset-upload-slot-barcodes-input')).toBeVisible()
    // The "or a single .zip/.tar" alternative is available on the mode toggle.
    await expect(page.getByTestId('dataset-upload-mode-opt-archive')).toBeVisible()
    // No upload occurred → no error surface / no progress bar.
    await expect(page.getByTestId('dataset-upload-progress')).toHaveCount(0)
  })
})
