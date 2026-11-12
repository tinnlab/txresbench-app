import { expect, test } from '@playwright/test'
import {
  BACKEND,
  createMember,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  openDatasetsPane,
  openProjectCardMenu,
  ownerToken,
  projectCard,
} from './_helpers'

// TEST-9/10 — the viewer read-only workbench (the reviewer / read-only-collaborator JTBD).
// Sharing a project as `viewer` yields a fully-rendered but READ-ONLY project surface:
// every mutation affordance is absent (the central `ProjectScope` context gates them); an
// EDITOR (positive control) DOES see edit + attach, so the viewer-absence assertions are
// non-vacuous.
//
// ── Rewritten: the detail-page header surfaces these assertions targeted are GONE ───────
//
// This spec used to assert `project-detail-permission` / `-edit` / `-share` / `-transfer`
// and `project-share-panel`. `a7c75ef1` made the full-bleed workbench the DEFAULT and ONLY
// registered `project_nav` section, and `ProjectDetailPage`'s `fullBleed` early return
// renders neither `headerBar` nor `subHeader` — so none of those testids can appear on any
// project URL, for any role.
//
// That broke this spec in BOTH directions, and the second is the dangerous one:
//   • the two POSITIVE assertions (`-permission`, and the editor's `-edit`) simply failed;
//   • the five NEGATIVE assertions (`toHaveCount(0)` on `-edit`/`-share`/`-transfer` and
//     `project-share-panel`) kept PASSING — but vacuously. They passed because the whole
//     header was gone, not because `ProjectScope` gates anything. They would have passed
//     just as well with the permission checks deleted outright.
//
// So the mutation-affordance assertions are re-pointed at the surfaces that actually carry
// them now — the projects-list card ⋮ menu (Edit/Share/Transfer/Delete) and the datasets
// pane (attach/detach) — and each is paired with a control that fails if the surface
// disappears, so this class of silent rot cannot recur here:
//   • `openProjectCardMenu` asserts the unconditional "Open" item before any absence check;
//   • the editor test re-asserts the SAME locators positively;
//   • `workbench-project-name` / `project-datasets-card` prove the page really rendered
//     before we conclude anything is "absent".
//
// `project-share-panel` is NOT re-asserted for the viewer: it now lives inside the share
// drawer, which a viewer has no menu item to open, so asserting its absence against a
// closed drawer would itself be vacuous. The real gate — no "Share" item for a viewer —
// is asserted on the menu instead.


/** Owner (REST) creates a project + dataset, attaches it, and shares at `level`. */
async function seedSharedProject(
  request: import('@playwright/test').APIRequestContext,
  admin: string,
  recipientEmail: string,
  level: 'viewer' | 'editor',
): Promise<string> {
  const h = { authorization: `Bearer ${admin}` }
  const name = `RO ${level} ${Date.now()}-${Math.floor(performance.now())}`
  const project = await (
    await request.post(`${BACKEND}/api/projects`, { headers: h, data: { name, description: '' } })
  ).json()
  const sid = project.id as string
  const ds = await (
    await request.post(`${BACKEND}/api/datasets`, { headers: h, data: { name: `matrix ${sid}` } })
  ).json()
  const att = await request.post(`${BACKEND}/api/projects/${sid}/datasets/${ds.id}`, { headers: h })
  expect(att.ok()).toBeTruthy()
  const share = await request.post(`${BACKEND}/api/projects/${sid}/shares`, {
    headers: h,
    data: { email: recipientEmail, permission_level: level },
  })
  expect(share.ok()).toBeTruthy()
  return name
}

/** Log the recipient in, accept the share invite, open the project detail page. */
async function acceptAndOpen(
  page: import('@playwright/test').Page,
  username: string,
  projectName: string,
): Promise<void> {
  await loginMemberToProjects(page, username, MEMBER_PASSWORD)
  await page.getByTestId('notification-bell').click()
  await page.locator('[data-testid^="notification-accept-"]').first().click()
  await page.goto('/projects')
  await expect(page.getByTestId('projects-page')).toBeVisible()
  await page.getByTestId('project-card-title').filter({ hasText: projectName }).click()
  await expect(page.getByTestId('project-detail-page')).toBeVisible()
  // Every project URL is the full-bleed workbench; wait for its shell so the assertions
  // below run against a rendered page rather than an empty frame.
  await expect(page.getByTestId('workbench-shell')).toBeVisible()
}

test('viewer gets a read-only project workbench (TEST-9)', async ({ browser, request }) => {
  const admin = await ownerToken(request)
  const viewer = `roview${Date.now()}`
  await createMember(request, admin, viewer)
  const name = await seedSharedProject(request, admin, `${viewer}@txresbench.test`, 'viewer')

  const ctx = await browser.newContext()
  const vp = await ctx.newPage()
  await acceptAndOpen(vp, viewer, name)

  // Fully-rendered — the workbench really mounted for a viewer (a read-only IDE, not a
  // blank/denied page), and the datasets pane is there. These are the CONTROLS for the
  // absence assertions that follow: if the page failed to render, they fail here first.
  await expect(vp.getByTestId('workbench-project-name')).toHaveText(name)
  await openDatasetsPane(vp) // also asserts `project-datasets-card` became visible

  // …but NO mutation affordance is present in the datasets pane. (Positive control: the
  // editor test below asserts these SAME two locators are present under the same gate.)
  await expect(vp.getByTestId('project-attach-row')).toHaveCount(0) // datasets pane read-only
  await expect(vp.locator('[data-testid^="project-detach-"]')).toHaveCount(0) // no detach

  // The card overflow menu — the only surface carrying project-level actions — is likewise
  // read-only. `openProjectCardMenu` asserts the unconditional "Open" item first, so the
  // absences below cannot pass on a menu that never opened.
  await vp.goto('/projects')
  await expect(projectCard(vp, name).getByTestId('project-permission-badge')).toHaveText(/viewer/i)
  await openProjectCardMenu(vp, name)
  await expect(vp.getByRole('menuitem', { name: /^edit$/i })).toHaveCount(0)
  await expect(vp.getByRole('menuitem', { name: /^share$/i })).toHaveCount(0)
  await expect(vp.getByRole('menuitem', { name: /transfer/i })).toHaveCount(0)
  await expect(vp.getByRole('menuitem', { name: /^delete$/i })).toHaveCount(0)
  await ctx.close()
})

test('editor sees edit + attach affordances — positive control (TEST-10)', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const editor = `roedit${Date.now()}`
  await createMember(request, admin, editor)
  const name = await seedSharedProject(request, admin, `${editor}@txresbench.test`, 'editor')

  const ctx = await browser.newContext()
  const ep = await ctx.newPage()
  await acceptAndOpen(ep, editor, name)

  // The SAME locators that were absent for a viewer ARE present for an editor — this test
  // is what makes every absence assertion in the viewer test above non-vacuous. If a gate
  // were deleted, or a surface silently disappeared, these fail.
  await openDatasetsPane(ep)
  await expect(ep.getByTestId('project-attach-row')).toBeVisible() // datasets pane editable
  // Control for the viewer's `project-detach-` absence: the seeded dataset's detach button
  // DOES render for an editor (the same `canEdit` gate).
  await expect(ep.locator('[data-testid^="project-detach-"]')).toHaveCount(1)

  // Same for the card ⋮ menu: an editor sees Edit (control for the viewer's Edit absence),
  // while the owner-only actions stay hidden for an editor too.
  await ep.goto('/projects')
  await expect(projectCard(ep, name).getByTestId('project-permission-badge')).toHaveText(/editor/i)
  await openProjectCardMenu(ep, name)
  await expect(ep.getByRole('menuitem', { name: /^edit$/i })).toBeVisible() // editor may edit
  await expect(ep.getByRole('menuitem', { name: /^share$/i })).toHaveCount(0)
  await expect(ep.getByRole('menuitem', { name: /transfer/i })).toHaveCount(0)
  await expect(ep.getByRole('menuitem', { name: /^delete$/i })).toHaveCount(0)
  await ctx.close()
})
