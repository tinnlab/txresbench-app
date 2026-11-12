import { type APIRequestContext, expect, type Page } from '@playwright/test'
import {
  BACKEND,
  loginAsOwner as ensureOwnerSession,
  loginViaUi,
  ownerApiToken,
  waitUntilOffLoginScreen,
} from '../_owner'

// Shared project-e2e helpers. The webServer reuses ONE backend + persistent DB
// across specs (workers:1, sequential); the owner admin is created once and
// subsequently logged into — by `tests/e2e/_owner.ts`, the ONE owner for the
// whole directory (see that file for why a per-suite owner was a bug). Sub-users
// are created via the admin REST API and logged in through the UI.

export { OWNER, BACKEND, loginViaUi, waitUntilOffLoginScreen } from '../_owner'

/** Ensure the owner admin exists and land authenticated on `/projects`. */
export async function loginAsOwner(page: Page): Promise<void> {
  await ensureOwnerSession(page)
  await gotoProjects(page)
}

/** Navigate to /projects and wait for the projects page to render. */
export async function gotoProjects(page: Page): Promise<void> {
  await page.goto('/projects')
  await page.getByTestId('projects-page').waitFor({ state: 'visible', timeout: 20_000 })
}

/**
 * Activate the workbench's Datasets pane and wait for the dataset extension's panel.
 *
 * Datasets stopped being a project SECTION with `a7c75ef1`: the dataset extension registers
 * a `detail_panels` panel with NO `project_nav` entry, and it is surfaced as a workbench
 * PANE (`dock/panes.tsx` → `SectionPane`). The pane exists on first load but is NOT the
 * ACTIVE tab — the left region opens on "Visualize" — and an inactive tab's body is not
 * mounted, so `project-datasets-*` is absent until the tab is selected.
 *
 * That is why `/projects/:id/datasets` plus a bare `project-datasets-card` assertion stopped
 * working: the URL redirects to `/workspace`, AND the panel sits behind a tab. Every
 * datasets-panel assertion has to come through here.
 */
export async function openDatasetsPane(page: Page, projectId?: string): Promise<void> {
  if (projectId) await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('region-tab-p-datasets').click()
  await expect(page.getByTestId('project-datasets-card')).toBeVisible({ timeout: 30_000 })
}

/** Locate a project's card in the /projects grid by its visible name. */
export function projectCard(page: Page, projectName: string) {
  return page
    .locator('[data-testid^="project-card-"]')
    .filter({ has: page.getByTestId('project-card-title').filter({ hasText: projectName }) })
    .first()
}

/**
 * Open a project's ⋮ actions menu from the /projects grid, and assert it really opened.
 *
 * WHY this exists: since `a7c75ef1` the projects-list card ⋮ menu is the ONLY reachable
 * route to Edit / Share / Transfer / Delete. That commit made the full-bleed workbench the
 * default (and only) project section, and `ProjectDetailPage`'s `fullBleed` early return
 * renders no header — so `project-detail-{edit,share,transfer}` cannot appear on ANY
 * project URL. `ProjectCard.tsx::onSelect` runs the SAME `Stores.ProjectDrawer.open*` the
 * header buttons ran (after `loadProject`), so the drawer opens against the same project.
 *
 * The "Open" assertion is a POSITIVE CONTROL: "Open" is the one unconditional item, so it
 * proves the menu actually rendered. Without it, any `toHaveCount(0)` a caller makes
 * against a menu item passes vacuously whenever the menu fails to open at all — which is
 * exactly how the old detail-header assertions kept "passing" after the header vanished.
 */
export async function openProjectCardMenu(page: Page, projectName: string): Promise<void> {
  await projectCard(page, projectName)
    .getByRole('button', { name: /project actions/i })
    .click()
  await expect(page.getByRole('menuitem', { name: /^open$/i })).toBeVisible()
}

/** Open the card ⋮ menu and select an action (Edit / Share / Transfer ownership / Delete). */
export async function runProjectCardAction(
  page: Page,
  projectName: string,
  action: RegExp,
): Promise<void> {
  await gotoProjects(page)
  await openProjectCardMenu(page, projectName)
  await page.getByRole('menuitem', { name: action }).click()
}

/** Log in a Users-group member and land on /projects (mounts the sidebar + the
 *  notification bell — the blank post-login `/` has no app chrome). */
export async function loginMemberToProjects(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await loginViaUi(page, username, password)
  await waitUntilOffLoginScreen(page)
  await gotoProjects(page)
}

/** An admin API token (setup or login), for REST-driving sub-user creation. */
export async function ownerToken(request: APIRequestContext): Promise<string> {
  return ownerApiToken(request)
}

const USERS_GROUP_ID = '79668b78-16ff-4d3f-80e6-afdbb3236dc9'

/** Create a Users-group member (holds projects::use). Returns their id. */
export async function createMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/users`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { username, email: `${username}@txresbench.test`, password: 'memberPassw0rd!' },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

/** Create a user then STRIP the Users group → they lack projects::use (A10). */
export async function createRestrictedUser(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<void> {
  const id = await createMember(request, admin, username)
  const r = await request.delete(
    `${BACKEND}/api/groups/${id}/${USERS_GROUP_ID}/remove`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(r.ok()).toBeTruthy()
}

export const MEMBER_PASSWORD = 'memberPassw0rd!'
