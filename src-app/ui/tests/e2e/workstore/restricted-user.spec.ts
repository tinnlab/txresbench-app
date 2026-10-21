import { expect, test } from '@playwright/test'
import {
  createRestrictedUser,
  loginAsOwner,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'
import { openArtifactsPane, openWorkspace } from './_artifacts'

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────────────────
// Without this, a change that hid Artifacts from EVERY user (exactly what a7c75ef1 did to
// the old assertions) would pass the negative case below and look like a passing gate.
test('POSITIVE CONTROL: a user WITH projects::use reaches the Artifacts pane — TEST-22a', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `WS positive ${Date.now()}`, description: '' },
    })
  ).json()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await loginAsOwner(page)

  // (1) The Projects route DOES render (the route gate the negative asserts absent).
  await expect(page.getByTestId('projects-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('router-route-forbidden-result')).toHaveCount(0)

  // (2) The same deep-link the negative uses reaches the project detail page…
  await page.goto(`/projects/${project.id}/artifacts`)
  await expect(page.getByTestId('project-detail-page')).toBeVisible({ timeout: 30_000 })

  // (3) …and the Artifacts SURFACE is reachable from there — the "+" menu offers the pane
  // and it renders the workstore panel. This is the affordance whose absence is the
  // negative's real claim.
  await openWorkspace(page, project.id)
  await openArtifactsPane(page)
  await expect(page.getByTestId('project-artifacts-card')).toBeVisible()

  await ctx.close()
})

// ── THE NEGATIVE ─────────────────────────────────────────────────────────────────────
test('a user without projects::use sees no Projects/Artifacts surface — TEST-22', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const uname = `wsrestrict${Date.now()}`
  await createRestrictedUser(request, admin, uname)

  // Seed a real project (as admin) so the deep-link targets an existing project.
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `WS restrict ${Date.now()}`, description: '' },
    })
  ).json()

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await loginViaUi(page, uname, MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // (1) Route gate: the Projects page does not render…
  await page.goto('/projects')
  await expect(
    page.getByTestId('router-route-forbidden-result'),
    'the route resolved and was REFUSED — the count-0 below is a permission fact, not a ' +
      'blank page',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('projects-page')).toHaveCount(0)

  // (2) …and neither does the project detail page on a direct deep-link, at the retired
  // section URL OR at the live workbench URL. Both are gated on `projects::use`.
  for (const section of ['artifacts', 'workspace']) {
    await page.goto(`/projects/${project.id}/${section}`)
    await expect(
      page.getByTestId('router-route-forbidden-result'),
      `/${section} resolved and was refused`,
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('project-detail-page')).toHaveCount(0)
    // The workbench never mounts, so neither of the two by-name pane openers exists…
    await expect(page.getByTestId('workbench-shell')).toHaveCount(0)
    await expect(page.getByTestId('region-add-pane-right')).toHaveCount(0)
    await expect(page.getByTestId('center-empty-panes')).toHaveCount(0)
    // …and the Artifacts pane + its panel are unreachable by ANY route.
    await expect(page.getByTestId('region-add-pane-item-artifacts')).toHaveCount(0)
    await expect(page.getByTestId('workbench-section-pane-artifacts')).toHaveCount(0)
    await expect(page.getByTestId('project-artifacts-card')).toHaveCount(0)
  }

  await ctx.close()
})

// (3) The BACKEND gate is what makes the UI absence a defense-in-depth layer rather than
// the only thing standing between this user and the catalog. Assert it directly so that
// claim is evidenced, not assumed — `list_artifacts` takes
// `RequirePermissions<(ProjectsUse,)>`, so a stripped user must get 403, never 200.
test('the workstore catalog API itself refuses a user without projects::use (403) — TEST-22b', async ({
  request,
}) => {
  const admin = await ownerToken(request)
  const uname = `wsrestrictapi${Date.now()}`
  await createRestrictedUser(request, admin, uname)

  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `WS restrict API ${Date.now()}`, description: '' },
    })
  ).json()

  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username: uname, password: MEMBER_PASSWORD },
  })
  expect(login.ok(), `restricted login -> ${login.status()}`).toBeTruthy()
  const body = await login.json()
  const token = (body.access_token ?? body.token) as string

  const listed = await request.get(`${BACKEND}/api/projects/${project.id}/artifacts`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(listed.status(), 'the workstore catalog gate holds for a stripped user').toBe(403)

  // Positive control on the SAME endpoint: the admin's token gets 200, so the 403 above is
  // a permission verdict — not a wrong URL, a missing route, or a dead backend.
  const asAdmin = await request.get(`${BACKEND}/api/projects/${project.id}/artifacts`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(asAdmin.status(), 'the endpoint exists and answers a permitted caller').toBe(200)
})
