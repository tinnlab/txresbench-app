import { expect, test, type Page } from '@playwright/test'
import {
  BACKEND,
  createProjectsOnlyMember,
  loginMemberToProjects,
  loginAsOwner,
  MEMBER_PASSWORD,
  ownerToken,
} from './_helpers'

// TEST-31 [negative-perm] (A10) — a user WITH project access but WITHOUT
// `provenance::read` reaches NO provenance surface.
//
// ── R4C-07 (round 4b): this spec had gone VACUOUS and had to be rewritten ─────────
//
// It was written against the project SECTION-NAV era and asserted `toHaveCount(0)` on
// `project-section-tab-provenance`, `provenance-panel`, `provenance-open-export` and
// `provenance-record-selection`. Commit 6d231748 retired the provenance section (and its
// `detail_panels` contribution) in favour of a workbench PANE, so none of those testids
// is rendered for ANY user any more — every one of those assertions passed for a reason
// that had nothing to do with permissions. A gate that had been DELETED would not have
// been caught; and it had been deleted.
//
// What replaced them is `region-add-pane-item-reproducibility` (the workbench "+" menu)
// and `workbench-provenance-pane-<id>` (the pane). The pane renderer is registered
// directly in `panes.tsx`, so unlike the section panel it inherits nothing from the
// project-extension registry's permission filtering — the gate was silently dropped by
// the move, and a denied user was shown the pane's "No provenance yet" empty state: a
// FALSE claim (the project may well have provenance this user simply may not see). The
// last case asserts the BACKEND gate directly, so the distinction between "UI honesty
// defect" and "data leak" stays evidenced rather than asserted in prose.
//
// Every negative below is paired with a POSITIVE CONTROL on the same affordance, because
// a `toHaveCount(0)` against a testid nobody renders is exactly how this spec died once.

/** Open a project's workbench and wait for the shell. */
async function openWorkspace(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
}

/** Open the right region's "+" (add-pane) menu — one of only two user affordances that
 *  open a pane BY NAME (the other is the centre empty-picker). */
async function openAddPaneMenu(page: Page) {
  const add = page.getByTestId('region-add-pane-right')
  await expect(add).toBeVisible({ timeout: 30_000 })
  await add.click()
  await expect(page.getByTestId('region-add-pane-menu-right')).toBeVisible()
}

// ── POSITIVE CONTROL ──────────────────────────────────────────────────────────────
// Without this, a gate that hid the Provenance pane from EVERY user would pass the
// negative case below and look like a fix.
test('POSITIVE CONTROL: a user WITH provenance::read is offered the Provenance pane and can open it', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name: `Prov Perm Positive ${Date.now()}`, description: '' },
  })
  expect(r.ok(), `create project -> ${r.status()}`).toBeTruthy()
  const project = await r.json()

  await loginAsOwner(page)
  await openWorkspace(page, project.id)

  await openAddPaneMenu(page)
  const item = page.getByTestId('region-add-pane-item-reproducibility')
  await expect(item, 'a permitted user IS offered the Provenance pane').toHaveCount(1)
  await item.click()

  // The pane opens and renders its REAL content — not the 403 surface.
  await expect(page.locator('[data-testid^="workbench-provenance-pane-"]').first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator('[data-testid^="workbench-provenance-pane-forbidden-"]')).toHaveCount(0)
})

// ── THE NEGATIVE ──────────────────────────────────────────────────────────────────
test('a user with projects::use but no provenance::read sees no provenance UI', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const username = `provnone-${Date.now()}`
  await createProjectsOnlyMember(request, admin, username)

  // The member logs in and lands on /projects — project access is intact.
  await loginMemberToProjects(page, username, MEMBER_PASSWORD)
  await expect(page.getByTestId('projects-page')).toBeVisible()

  // They can create + open their own project (positive control: project access works).
  const name = `Member Project ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await page.getByTestId('project-card-title').filter({ hasText: name }).click()

  await expect(page.getByTestId('project-detail-page')).toBeVisible()
  const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]
  expect(projectId, 'project id from URL').toBeTruthy()

  await openWorkspace(page, projectId as string)

  // (1) The "+" menu does NOT offer the Provenance pane…
  await openAddPaneMenu(page)
  await expect(
    page.getByTestId('region-add-pane-item-reproducibility'),
    'the add-pane menu must not offer a pane the user may not read',
  ).toHaveCount(0)
  // …while it DOES still offer ungated panes — proving the menu rendered and was
  // FILTERED, rather than being empty/absent for some unrelated reason.
  await expect(
    page.getByTestId('region-add-pane-menu-right').locator('[data-testid^="region-add-pane-item-"]'),
    'the menu itself renders — only the gated entry is filtered out',
  ).not.toHaveCount(0)
  await page.keyboard.press('Escape')

  // (2) …and neither does the CENTER empty-picker (the second by-name opener).
  if (await page.getByTestId('center-empty-panes').count()) {
    await expect(page.getByTestId('center-open-pane-reproducibility')).toHaveCount(0)
  }

  // (3) The pane is gated at the PANE too, not only in the menu: a pane is reachable by
  // paths that never pass the menu filter (a restored layout, `revealPane`, the
  // programmatic seam). Force it open through the seam and assert the user gets the
  // permission surface — NOT the "No provenance yet" empty state.
  await page.waitForFunction(
    () => !!(window as { __workbenchPanes?: unknown }).__workbenchPanes,
    undefined,
    { timeout: 20_000 },
  )
  const paneId = await page.evaluate(() =>
    (
      window as unknown as { __workbenchPanes: { open: (k: string) => string } }
    ).__workbenchPanes.open('reproducibility'),
  )
  expect(paneId, 'the seam opened a pane (the gate is not "refuse to add")').toBeTruthy()
  // `requestAddPane` docks the pane but does NOT activate its tab (only the "+" menu's
  // `moveToRegion` focuses), and an inactive region tab renders no content. Click the tab —
  // the same gesture a user makes on a pane restored from a persisted layout.
  await page.getByTestId(`region-tab-${paneId}`).click()
  await expect(page.locator('[data-testid^="workbench-provenance-pane-forbidden-"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.locator('[data-testid^="workbench-provenance-pane-empty-"]'),
    'a denied user must never be told "No provenance yet" — that is a claim about the ' +
      'project, and this user is simply not allowed to see the answer',
  ).toHaveCount(0)
  await expect(page.locator('[data-testid^="provenance-export-bundle-"]')).toHaveCount(0)

  // (4) Settings: the admin provenance settings page is unreachable (route gated on
  // provenance::settings::read) and absent from the settings nav.
  await page.goto('/settings/provenance')
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('provenance-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('provenance-settings-card')).toHaveCount(0)
})

// (5) The BACKEND gate is what makes the pane defect a UI-honesty problem rather than a
// data leak. Assert it directly so that claim is evidenced, not assumed.
test('the provenance API itself refuses a user without provenance::read (403)', async ({
  request,
}) => {
  const admin = await ownerToken(request)
  const username = `provnone-api-${Date.now()}`
  await createProjectsOnlyMember(request, admin, username)

  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username, password: MEMBER_PASSWORD },
  })
  expect(login.ok(), `member login -> ${login.status()}`).toBeTruthy()
  const body = await login.json()
  const memberToken = (body.access_token ?? body.token) as string

  const proj = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${memberToken}` },
    data: { name: `Prov Perm API ${Date.now()}`, description: '' },
  })
  expect(proj.ok(), `member create project -> ${proj.status()}`).toBeTruthy()
  const projectId = (await proj.json()).id

  const runs = await request.get(
    `${BACKEND}/api/provenance/runs?project_id=${projectId}&page=1&per_page=10`,
    { headers: { authorization: `Bearer ${memberToken}` } },
  )
  expect(
    runs.status(),
    'the backend gate holds — the UI defect was a false empty state, not a data leak',
  ).toBe(403)
})
