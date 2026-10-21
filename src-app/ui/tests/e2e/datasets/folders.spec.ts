import { expect, test } from '@playwright/test'
import { BACKEND, createDatasetApi, gotoDatasets, loginOwnerToDatasets, ownerToken } from './_helpers'

// TEST-47 [ITEM-24] — dataset folders. Create a folder (UI), assign a dataset to
// it (the accessible per-row folder menu — the companion to drag-to-folder),
// filter the library by that folder (the assigned dataset shows, an unassigned
// one does not), then remove it (the folder empties; "All datasets" shows it
// again). Real backend, owner-scoped folder label layer.
test('create a folder, assign a dataset, filter by folder, remove — TEST-47', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const inFolder = await createDatasetApi(request, admin, `fld-in-${ts}`)
  const notInFolder = await createDatasetApi(request, admin, `fld-out-${ts}`)

  await loginOwnerToDatasets(page)
  await expect(page.getByTestId('dataset-folder-rail')).toBeVisible()

  // --- Create a folder via the rail's dialog. ---
  const folderName = `Folder ${ts}`
  await page.getByTestId('dataset-folder-new').click()
  await expect(page.getByTestId('dataset-folder-dialog')).toBeVisible()
  await page.getByTestId('dataset-folder-name').fill(folderName)
  await page.getByTestId('dataset-folder-submit').click()
  await expect(page.getByTestId('dataset-folder-dialog')).toBeHidden()

  // Resolve the folder id (for the id-keyed testids) from the REST list.
  const folders: Array<{ id: string; name: string }> = await (
    await request.get(`${BACKEND}/api/dataset-folders`, {
      headers: { authorization: `Bearer ${admin}` },
    })
  ).json()
  const folder = folders.find(f => f.name === folderName)
  expect(folder, 'created folder is listed').toBeTruthy()
  const folderId = folder!.id
  await expect(page.getByTestId(`dataset-folder-${folderId}`)).toBeVisible()

  // --- Assign `inFolder` to the folder via the per-row folder menu. ---
  await page.getByTestId(`dataset-row-folders-${inFolder.id}`).click()
  await page.getByTestId(`dataset-rowfolder-${inFolder.id}-${folderId}`).click()
  await expect(page.getByTestId(`dataset-rowfolder-${inFolder.id}-${folderId}`)).toContainText(
    /in folder/i,
  )
  await page.keyboard.press('Escape') // close the popover

  // --- Filter by the folder: the assigned dataset shows, the other does not. ---
  await page.getByTestId(`dataset-folder-${folderId}`).click()
  await expect(page.getByTestId(`dataset-row-${inFolder.id}`)).toBeVisible()
  await expect(page.getByTestId(`dataset-row-${notInFolder.id}`)).toHaveCount(0)

  // "All datasets" clears the filter — both are visible again.
  await page.getByTestId('dataset-folder-all').click()
  await expect(page.getByTestId(`dataset-row-${inFolder.id}`)).toBeVisible()
  await expect(page.getByTestId(`dataset-row-${notInFolder.id}`)).toBeVisible()

  // --- Remove it from the folder: filtering by the folder no longer shows it. ---
  await page.getByTestId(`dataset-row-folders-${inFolder.id}`).click()
  await page.getByTestId(`dataset-rowfolder-${inFolder.id}-${folderId}`).click()
  await page.keyboard.press('Escape')
  await page.getByTestId(`dataset-folder-${folderId}`).click()
  await expect(page.getByTestId(`dataset-row-${inFolder.id}`)).toHaveCount(0)

  // …and it reappears under "All datasets".
  await page.getByTestId('dataset-folder-all').click()
  await expect(page.getByTestId(`dataset-row-${inFolder.id}`)).toBeVisible()

  // Sanity: reloading keeps the folder (persisted, not just in-memory).
  await gotoDatasets(page)
  await expect(page.getByTestId(`dataset-folder-${folderId}`)).toBeVisible()
})
