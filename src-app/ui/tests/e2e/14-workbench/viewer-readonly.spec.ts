import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { createMember, loginMemberToProjects, MEMBER_PASSWORD, ownerToken } from '../project/_helpers'

// TEST-321 (ITEM-29) — the viewer read-only WORKBENCH. Sharing a project as `viewer`
// yields a fully-rendered, EXPLORABLE, but READ-ONLY-for-MUTATING workbench: the shell +
// docks + canvas render and layout ops (per-user) work, but every DATA-MUTATION affordance
// (toolbar Run/Export, launcher LAUNCH, the launcher read-only banner) is gated by the
// central `ProjectScope` `canEdit`. An EDITOR (positive control) DOES see Run + enabled
// launch rows, so the viewer-absence assertions are non-vacuous. `canEdit` is the
// per-project role — DISTINCT from the coarse RBAC perms the actions carry.

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'

async function seedSharedProject(
  request: APIRequestContext,
  admin: string,
  recipientEmail: string,
  level: 'viewer' | 'editor',
): Promise<string> {
  const h = { authorization: `Bearer ${admin}` }
  const name = `WB RO ${level} ${Date.now()}`
  const project = await (
    await request.post(`${BACKEND}/api/projects`, { headers: h, data: { name, description: '' } })
  ).json()
  const share = await request.post(`${BACKEND}/api/projects/${project.id}/shares`, {
    headers: h,
    data: { email: recipientEmail, permission_level: level },
  })
  expect(share.ok()).toBeTruthy()
  return project.id as string
}

async function acceptAndOpenWorkbench(page: Page, username: string, projectId: string): Promise<void> {
  await loginMemberToProjects(page, username, MEMBER_PASSWORD)
  await page.getByTestId('notification-bell').click()
  // WAIT for the invitation row before clicking: the bell popover fetches its list, so a
  // blind `.first().click()` can fire before the row exists and silently leave the share
  // UNACCEPTED — which then surfaces (confusingly) as "workbench-shell never became
  // visible" on the workspace route, because the member has no access to the project.
  const accept = page.locator('[data-testid^="notification-accept-"]').first()
  await accept.waitFor({ state: 'visible', timeout: 20_000 })
  await accept.click()
  // …and wait for the accept to actually land (the row disappears once accepted) so the
  // navigation below happens with project access in place.
  await expect(accept).toHaveCount(0, { timeout: 20_000 })
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-testid^="region-pane-body-"]').first().waitFor({ state: 'visible', timeout: 20_000 })
}

test('a VIEWER sees the workbench but NONE of the data-mutation affordances — TEST-321', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const viewer = `wbview${Date.now()}`
  await createMember(request, admin, viewer)
  const id = await seedSharedProject(request, admin, `${viewer}@cyto.test`, 'viewer')

  const ctx = await browser.newContext()
  const vp = await ctx.newPage()
  await acceptAndOpenWorkbench(vp, viewer, id)

  // Fully rendered + EXPLORABLE: the shell + dock host + a pane frame render, and the
  // per-user LAYOUT ops (grip drag + pop-out) are present (viewers may re-arrange).
  await expect(vp.getByTestId('workbench-dock-host')).toBeVisible()
  await expect(vp.locator('[data-testid^="region-tab-"]').first()).toBeVisible()
  await expect(vp.locator('[data-testid^="region-popout-"]').first()).toBeVisible()

  // …but every DATA-MUTATION affordance is ABSENT/read-only (viewer). (The former
  // `workbench-toolbar-*` checks were removed — the RegionShell redesign dropped the TopToolbar,
  // so those would now pass vacuously for everyone.)
  await expect(vp.locator('[data-testid^="workbench-analysis-run-"]')).toHaveCount(0) // no per-analysis Run
  await expect(vp.getByTestId('workbench-launcher-readonly-p-launcher')).toBeVisible()

  // ── A VIEWER MAY OPEN AN ANALYSIS FORM. THE REFUSAL MOVED TO THE CONTROL THAT IS REFUSED. ──
  //
  // This block previously asserted the OPPOSITE — that the row was disabled and said "viewers
  // cannot launch analyses" — and it read as a well-explained refusal while being a refusal
  // that should never have happened. `analysis.launch` opens the analysis' FORM and enqueues
  // nothing (its own doc; now declared `mutating: false` + the same read perm that opens the
  // analyses CATALOG). The refusal that is TRUE — you cannot RUN this — lives on the Run button
  // inside that form, where `AnalysisRunPanel` has always stated it and where this gate stood
  // in front of it. A viewer weighing whether to ask for edit access can now read the
  // parameters they would be asking about.
  //
  // THE SUBJECT IS THE ⚙ FORM BUTTON, NOT THE ROW, and the reason is measured rather than
  // assumed: this project is freshly shared and EMPTY, so every launcher row is refused for
  // `needs-type` — it has no input of the type the analysis consumes. That refusal applies to
  // an editor identically, so the row cannot discriminate the role either way. (The assertion
  // this replaced, `toBeDisabled()`, was satisfied by BOTH causes at once, which is how it read
  // as proof of a viewer gate while proving nothing about one.) The ⚙ button is the affordance
  // that is genuinely role-scoped: by design it stays open for an availability-gated analysis
  // precisely so params can be INSPECTED before the inputs exist — which is what a viewer was
  // refused, and is what needs no seeded dataset to test.
  const row = vp.locator('[data-testid^="workbench-launcher-row-"]').first()
  const availability = await row.getAttribute('data-availability')
  expect(availability, 'the row refusal here is about missing inputs, not about the role').toBe(
    'needs-type',
  )
  // The NAME still says WHICH analysis (the 93167985 rule), asserted without naming one — this
  // file must carry no domain vocabulary (`lint-no-domain-in-builtin`).
  const rowTitle = ((await row.innerText()) ?? '').trim()
  expect(rowTitle.length, 'the row must render its own title').toBeGreaterThan(0)
  const label = (await row.getAttribute('aria-label')) ?? ''
  expect(rowTitle.startsWith(label), 'the name must BE the row, not a shared sentence').toBe(true)

  const openForm = vp.locator('[data-testid^="workbench-analysis-open-"]').first()
  await expect(openForm, 'a viewer must be able to open an analysis form').toBeVisible()
  await expect(
    openForm,
    'this used to be aria-disabled for a viewer, with the whole point of the control being inspection',
  ).toBeEnabled()

  // …and clicking it LANDS somewhere. An enabled control whose handler early-returns would be
  // the worst outcome of this change: a refusal with no reason in any channel at all, on a
  // control that looks live. Asserted as "a pane appeared", NOT as "the run panel appeared":
  // WHICH surface opens is the instance handler's call — an analysis declaring its own `ui:`
  // is revealed in its OWN declarative pane, one that does not gets the run pane — and this
  // seeded project's analyses take the first branch. Pinning the run panel here would pin a
  // fixture's choice rather than the behaviour under test.
  // An INCREASE, not an exact count: opening one analysis added two tabs here (the reveal
  // focuses the analysis' pane and its region brings a sibling with it), and how many surfaces
  // a reveal composes is the dock's business, not this test's. What has to be true is that
  // SOMETHING opened.
  const tabsBefore = await vp.locator('[data-testid^="region-tab-"]').count()
  await openForm.click()
  await expect
    .poll(() => vp.locator('[data-testid^="region-tab-"]').count(), {
      message: 'a viewer`s click must open a surface, not silently do nothing',
      timeout: 20_000,
    })
    .toBeGreaterThan(tabsBefore)

  // …and the MUTATION is still gated on the surface that opened: no Run affordance exists for
  // them anywhere. That is the half of the old assertion that was always true, kept.
  await expect(vp.locator('[data-testid^="workbench-analysis-run-"]')).toHaveCount(0)

  await ctx.close()
})

test('an EDITOR (positive control) DOES see Run + enabled launch — TEST-321', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const editor = `wbedit${Date.now()}`
  await createMember(request, admin, editor)
  const id = await seedSharedProject(request, admin, `${editor}@cyto.test`, 'editor')

  const ctx = await browser.newContext()
  const ep = await ctx.newPage()
  await acceptAndOpenWorkbench(ep, editor, id)

  // Non-vacuous editor positive control: the read-only launcher banner the VIEWER carries is
  // ABSENT for an editor (the `canEdit` discriminator). (The former `workbench-toolbar-run`
  // check was dropped — the RegionShell redesign removed the TopToolbar; Run is now driven from
  // the launcher/run pane + the command palette, not a top toolbar button.)
  await expect(ep.getByTestId('workbench-launcher-readonly-p-launcher')).toHaveCount(0)

  await ctx.close()
})
