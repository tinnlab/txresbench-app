import { expect, test } from '@playwright/test'
import {
  findDatasetRow,
  loginOwnerToDatasets,
  ownerToken,
  singleFileTypeTitle,
} from './_helpers'

// TEST-31 [ITEM-4] — upload file(s) → dataset(s): N independent inputs become N
// INDEPENDENT datasets (never one merged row), each carrying its datatype. Real
// streaming upload endpoint, real DB — no API mocking.
//
// PORTED, with one assertion DELETED because the capability itself is gone. This spec
// used to drop BOTH files into one multi-select dropzone (`dataset-upload-input` /
// `dataset-upload-files`) and rely on a "one-per-file default grouping" rule. Neither
// testid exists anywhere in `src/` any more: the panel became the TYPE-FIRST wizard
// (`UploadPanel.tsx`), where choosing a datatype reveals exactly the input(s) that type
// declares — one dropzone for a `single` type, named slots for a `manifest` one. There
// is no multi-select drop path left at all (`Datasets.uploadFiles`, the old untyped
// entry point, now has zero callers), so the SIMULTANEOUS multi-file affordance is
// deleted here rather than re-expressed against a surface that cannot express it.
//
// What is NOT deleted is the outcome that affordance existed to guarantee, which the
// product still owes the user: two independent `.h5ad` files must end up as two
// independent datasets. That is now reached the way the product reaches it — two wizard
// passes — and asserted more strongly than before: as well as both rows existing with a
// real datatype, one dataset's file table is checked to contain ITS file and NOT the
// other's, which is the actual "they were not grouped" claim (the old spec only counted
// rows, which a merge would have failed only incidentally).
test('two independent .h5ad uploads → two independent, typed datasets — TEST-31', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // The wizard option label is DERIVED from the registry for this extension, never
  // written down here.
  const ext = 'h5ad'
  const typeTitle = await singleFileTypeTitle(request, admin, ext)
  await loginOwnerToDatasets(page)

  const ts = Date.now()
  const nameA = `up-${ts}-a.${ext}`
  const nameB = `up-${ts}-b.${ext}`

  /** One wizard pass: pick the type, reveal its single dropzone, upload `name`. */
  const uploadOne = async (name: string) => {
    await page.getByTestId('datasets-upload-button').click()
    const dialog = page.getByTestId('dataset-upload-dialog')
    await expect(dialog).toBeVisible()
    await page.getByTestId('dataset-upload-type').click()
    await page.getByRole('option', { name: typeTitle, exact: true }).click()
    await page
      .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
      .setInputFiles([
        { name, mimeType: 'application/octet-stream', buffer: Buffer.from(`bytes-${name}`) },
      ])
    await page.getByTestId('dataset-upload-submit').click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
  }

  await uploadOne(nameA)
  await uploadOne(nameB)

  // TWO independent inputs → TWO library rows, each with its declared datatype (not
  // "Untyped"). `findDatasetRow` filters the library to the name first — see its doc
  // for the concurrent-seed hazard that makes a bare page-1 lookup unreliable.
  const rowB = await findDatasetRow(page, nameB)
  await expect(rowB.getByTestId('dataset-datatype-badge')).not.toHaveText('Untyped')
  const rowA = await findDatasetRow(page, nameA)
  await expect(rowA.getByTestId('dataset-datatype-badge')).toBeVisible()
  await expect(rowA.getByTestId('dataset-datatype-badge')).not.toHaveText('Untyped')

  // They are genuinely INDEPENDENT, not one dataset holding both files: A's Contents
  // lists A's file and does not list B's.
  await rowA.getByRole('link', { name: nameA }).click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible()
  await expect(page.getByTestId('dataset-detail-name')).toHaveText(nameA)
  const files = page.getByTestId('dataset-files-table')
  await expect(files).toContainText(nameA)
  await expect(files).not.toContainText(nameB)
})
