import { expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, openDatasetsPane, ownerToken } from './_helpers'

// TEST-36: in a project's Datasets surface, attach a dataset via the picker → it lists;
// detach removes it. A dataset is seeded via the REST API (no dataset UI yet).
//
// The Datasets surface is now a workbench PANE behind a tab, not a page section — see
// `openDatasetsPane`. Before that call the panel is unmounted, which is why this test had
// been failing on `project-datasets-empty` since `a7c75ef1`.
test('project detail: attach + detach a dataset', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const dsName = `ds-${Date.now()}`
  const dsResp = await request.post(`${BACKEND}/api/datasets`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name: dsName },
  })
  expect(dsResp.ok()).toBeTruthy()

  await loginAsOwner(page)
  const name = `Detail Project ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await page.getByTestId('project-card-title').filter({ hasText: name }).click()

  await expect(page.getByTestId('project-detail-page')).toBeVisible()
  await openDatasetsPane(page)
  await expect(page.getByTestId('project-datasets-empty')).toBeVisible()

  // Attach via the picker.
  await page.getByTestId('project-attach-select').click()
  await page.getByRole('option', { name: dsName }).click()
  await page.getByTestId('project-attach-button').click()
  // Assert on the attached-dataset ROW (not getByText, which also matches the
  // picker's selected value).
  await expect(page.locator('[data-testid^="project-dataset-row-"]')).toHaveCount(1)
  await expect(page.getByTestId('project-datasets-empty')).toHaveCount(0)

  // Detach it. ITEM-38: the mutation is behind a confirmation, so the click opens a
  // prompt and the accept is what actually detaches.
  await page.locator('[data-testid^="project-detach-"]').first().click()
  await page.locator('[data-testid^="project-dataset-detach-confirm-"][data-testid$="-confirm"]').first().click()
  await expect(page.getByTestId('project-datasets-empty')).toBeVisible()
})

// TEST-7: opening a project lands on its default section, the URL reflects it, the section
// is deep-link safe, and browser back returns to the list.
//
// ── Rewritten: the SECTION NAV this test was built around no longer exists ──────────────
//
// It used to assert `project-section-nav` + `project-section-tab-datasets[aria-current]`
// and a `/datasets` URL. `a7c75ef1` moved the workbench's `project_nav` entry to order 5,
// making the full-bleed Workspace the FIRST and — since the workstore and dataset
// extensions register `detail_panels` with NO `project_nav` — the ONLY section. With one
// section there is no tab strip to render, and `ProjectDetailPage`'s `fullBleed` early
// return drops `subHeader` (which owns the nav) entirely. Datasets became a workbench PANE
// instead (`dock/panes.tsx`, open by default per `defaultLayout`).
//
// The two nav assertions are therefore DELETED rather than weakened: a single-section
// shell has no tab strip, and a `/datasets` redirect is a URL the router no longer
// produces. What is still true and worth covering — the default-section redirect (now
// `/workspace`), deep-link safety, back navigation — is kept and re-pointed. The
// full-bleed mount itself is covered in depth by `workbench/workbench-shell.spec.ts`.
test('project detail shell: default section + deep-link + back navigation', async ({ page }) => {
  await loginAsOwner(page)
  const name = `Shell Project ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await page.getByTestId('project-card-title').filter({ hasText: name }).click()

  // Lands on the shell; the URL defaults to the first (and only) section: workspace.
  await expect(page.getByTestId('project-detail-page')).toBeVisible()
  await expect(page).toHaveURL(/\/projects\/[^/]+\/workspace$/)
  // The full-bleed workbench renders, with the project's identity in its OWN header, and
  // the datasets pane (an extension `detail_panels` panel) is docked open by default.
  // These are the CONTROL for the chrome-absence assertion below.
  await expect(page.getByTestId('workbench-project-name')).toHaveText(name)
  // The dataset extension's panel is reachable as a workbench pane (behind its tab).
  await openDatasetsPane(page)
  // A full-bleed section renders no shell chrome. Non-vacuous: the assertions above prove
  // the page really rendered, so this is genuinely "the nav is not drawn" — and it fails
  // the moment a non-full-bleed section is registered, which would revive the strip.
  await expect(page.getByTestId('project-section-nav')).toHaveCount(0)

  // Deep-link straight to the section renders the workbench (deep-link safe).
  const url = page.url()
  await page.goto('/projects')
  await page.getByTestId('projects-page').waitFor({ state: 'visible' })
  await page.goto(url)
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(page.getByTestId('workbench-project-name')).toHaveText(name)

  // Browser back returns to the projects list (URL-reflected navigation).
  await page.goBack()
  await expect(page.getByTestId('projects-page')).toBeVisible()
})
