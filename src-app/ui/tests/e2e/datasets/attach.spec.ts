import { expect, test } from '@playwright/test'
import {
  createDatasetApi,
  createProjectApi,
  gotoDatasets,
  loginOwnerToDatasets,
  openDatasetsPane,
  ownerToken,
} from './_helpers'

// TEST-30 [ITEM-3] — attach a dataset to a project (M:N) from the library, and
// detach. A dataset can attach to MANY projects, so we attach one dataset to TWO
// projects and assert it shows in each project's Datasets panel; detaching from one
// project leaves the dataset itself (it survives in the library). Real backend.
//
// PORTED — verification SURFACE only; attach/detach itself is unchanged.
// `a7c75ef1` moved the project Datasets panel out of a project SECTION and into a
// workbench PANE: the dataset extension registers a `detail_panels` panel with NO
// `project_nav` entry, so `/projects/:id/datasets` now redirects to `/workspace`, and
// the panel sits behind a region TAB whose body is not mounted until the tab is
// selected. `project-datasets-card` therefore could not appear on the URL this spec
// used to visit. `project/_helpers.ts::openDatasetsPane` is the migration path four
// project specs already went through; this was the last un-migrated call site. It
// navigates to `/workspace`, clicks `region-tab-p-datasets`, and asserts
// `project-datasets-card` became visible — so the card assertion this spec made is
// not dropped, it just runs inside the helper.
test('attach a dataset to two projects (M:N); detach leaves the dataset — TEST-30', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()
  const projectA = await createProjectApi(request, admin, `Attach A ${ts}`)
  const projectB = await createProjectApi(request, admin, `Attach B ${ts}`)
  const ds = await createDatasetApi(request, admin, `attach-ds-${ts}`)

  await loginOwnerToDatasets(page)

  // Open the attach dialog from the dataset's row and attach to BOTH projects.
  await page.getByTestId(`dataset-attach-${ds.id}`).click()
  await expect(page.getByTestId('dataset-attach-dialog')).toBeVisible()
  await page.getByTestId(`dataset-attach-project-${projectA.id}`).click()
  await expect(page.getByTestId(`dataset-attach-project-${projectA.id}`)).toContainText(/attached/i)
  await page.getByTestId(`dataset-attach-project-${projectB.id}`).click()
  await expect(page.getByTestId(`dataset-attach-project-${projectB.id}`)).toContainText(/attached/i)
  await page.getByTestId('dataset-attach-done').click()

  // The dataset appears in project A's Datasets pane …
  await openDatasetsPane(page, projectA.id)
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toBeVisible()

  // … and in project B's (many-to-one / M:N).
  await openDatasetsPane(page, projectB.id)
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toBeVisible()

  // Detach from project B — the LINK is removed, the dataset is not deleted.
  // ITEM-38: detach now asks first, so the mutation is behind a confirmation.
  await page.getByTestId(`project-detach-${ds.id}`).click()
  await page.getByTestId(`project-dataset-detach-confirm-${ds.id}-confirm`).click()
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toHaveCount(0)

  // The dataset still exists in the library (detach leaves the dataset) …
  await gotoDatasets(page)
  await expect(page.getByTestId(`dataset-row-${ds.id}`)).toBeVisible()
  // … and is still linked to project A (M:N — only the B link was removed).
  await openDatasetsPane(page, projectA.id)
  await expect(page.getByTestId(`project-dataset-row-${ds.id}`)).toBeVisible()
})
