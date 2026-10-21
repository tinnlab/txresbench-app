import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  createMember,
  loginAsOwner,
  loginMemberToProjects,
  MEMBER_PASSWORD,
  ownerToken,
} from '../project/_helpers'
import { createProject, openWorkbench, BACKEND } from './_dock'
import {
  openArtifactPane,
  primaryRunArtifact,
  runToReview,
  REAL_COMPUTE,
  REAL_COMPUTE_SKIP,
} from './_analysis'
import { seedRunnableMatrix } from './_seed'

// TEST-235 / TEST-236 (ITEM-19) — the UI artifact-delete affordance + GENUINE LOCAL self-close.
// The artifact review's editor-only "Delete artifact" button deletes the produced artifact; a pane
// BOUND to that artifact self-closes IN THE SAME TAB (the local half the sync-driven 229/230 never
// covered — the acting tab's own `sync:artifact` echo is server-suppressed, so the delete calls
// `reconcile` directly). TEST-236 is the [negative-perm] half: a Viewer never sees the Delete
// affordance while an Editor at the SAME surface does (non-vacuous). Both need a host whose sandbox
// can COMPLETE a run (they delete a REAL produced artifact) — env-gated, run on a privileged
// sandbox host.
//
// ── WHICH PANE IS THE BOUND ONE, amended for the manifest/UI separation ──────────────────
//
// The bound pane used to be the RUN pane: this spec launched the analysis from the launcher, ran
// it there, and the pane bound itself to the produced artifact via `AnalysisRunPanel`'s
// `onArtifact`. That analysis declares `ui:`, so it is now run from its own contributed pane and
// the run pane renders no run surface for it at all (INV-4) — that binding no longer happens, and
// that pane is not part of this flow.
//
// The PROPERTY — "deleting an artifact self-closes the pane bound to it, in the same tab, without
// a reload or a cross-device echo" — is untouched, and it has another, more direct subject: a
// single-artifact `artifact` pane binds itself in `ArtifactPane`'s own effect
// (`bindPaneEntity(pane.id, {entity:'artifact', id})`) — the same binding, by the same mechanism,
// reconciled by the same path. So the flow is: run the analysis from its own form, open the run's
// REVIEW (the `run::<runId>` artifact pane), open a second pane bound to the artifact the review's
// Delete targets, come back to the review, and delete.
//
// The bound pane is asserted through its TAB rather than its body, deliberately: RegionShell
// renders only the ACTIVE pane's body per region, and the review has to be active for its Delete
// to be clickable — so a body-level assertion could not distinguish "the pane closed" from "the
// pane is merely not the active tab". A tab is rendered for every pane in the region.
//
// The artifact bound to is resolved with `primaryRunArtifact`, which reproduces
// `sortRunArtifacts`' ordering off the same endpoint the review lists from — so the pane is bound
// to exactly the artifact the button will delete, rather than to a guess.

/** Run the analysis, open its review, and bind a second pane to the artifact Delete will remove.
 *  Returns the bound pane's id and the run's id. The review is left ACTIVE (its Delete lives in
 *  its body). Fails LOUDLY if the sandbox can't complete a run. */
async function reviewWithBoundPane(
  page: Page,
  request: APIRequestContext,
  projectId: string,
): Promise<{ boundPaneId: string; runId: string }> {
  const { runId, reviewPaneId } = await runToReview(page, request, projectId)
  const target = await primaryRunArtifact(request, projectId, runId)
  const boundPaneId = await openArtifactPane(page, `${target.datatype}::${target.id}`)
  // Back to the review — only the active pane renders a body, and the Delete lives in it.
  await page.getByTestId(`region-tab-${reviewPaneId}`).click()
  return { boundPaneId, runId }
}

/** The review's editor-only Delete affordance. */
function deleteButton(page: Page) {
  return page.getByTestId('workbench-artifact-review-delete')
}

test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

test('deleting an artifact via the UI self-closes its bound pane in the SAME tab; siblings untouched — TEST-235', async ({
  page,
  request,
}) => {
  await loginAsOwner(page)
  const id = await createProject(request, `LocalDelete ${Date.now()}`)
  await seedRunnableMatrix(request, id)
  await openWorkbench(page, id)

  const { boundPaneId } = await reviewWithBoundPane(page, request, id)
  const del = deleteButton(page)
  await expect(del).toBeVisible({ timeout: 20_000 })

  // Click Delete → confirm. This is a LOCAL (same-tab) delete: the server suppresses this tab's
  // own sync echo, so the pane can only close via the affordance's direct `reconcileEntityPanes`.
  await del.click()
  await page.getByTestId('workbench-artifact-review-delete-dialog-confirm').click()

  // The BOUND pane self-closes in THIS tab (no reload, no cross-device echo); the sibling
  // canvas pane is untouched.
  await expect(page.getByTestId(`region-tab-${boundPaneId}`)).toHaveCount(0, { timeout: 20_000 })
  // The sibling is asserted through its TAB too, and for the same reason the bound pane is (see
  // the header): only the ACTIVE pane of a region renders a body, and the review is the active
  // one here — so `region-pane-body-p-canvas` is legitimately absent and asserting it visible
  // reports an untouched sibling as a destroyed one.
  await expect(
    page.getByTestId('region-tab-p-canvas'),
    'deleting an artifact must not disturb an unrelated pane',
  ).toHaveCount(1)
})

test('[negative-perm] a Viewer does not see the artifact Delete affordance (editor does) — TEST-236', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)

  // Owner: create a project, run an analysis to completion, share it as VIEWER.
  const ownerCtx = await browser.newContext()
  const op = await ownerCtx.newPage()
  await loginAsOwner(op)
  const id = await createProject(request, `DeletePerm ${Date.now()}`)
  await seedRunnableMatrix(request, id)
  const viewer = `wbdel${Date.now()}`
  await createMember(request, admin, viewer)
  const share = await request.post(`${BACKEND}/api/projects/${id}/shares`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { email: `${viewer}@cyto.test`, permission_level: 'viewer' },
  })
  expect(share.ok()).toBeTruthy()

  await openWorkbench(op, id)
  // POSITIVE CONTROL — the editor's (canEdit=true) review DOES render the Delete affordance
  // (`workbench-artifact-review-delete`); this is the same assertion TEST-235 then clicks. So the
  // viewer's absence below is non-vacuous: the affordance exists and is reachable by an editor.
  const { runId } = await runToReview(op, request, id)
  await expect(deleteButton(op)).toBeVisible({ timeout: 20_000 })
  await ownerCtx.close()

  // Viewer: accept the share, open the deep-link artifact route (a viewer's reachable artifact surface;
  // gated by `provenance::read` + project access, both of which a viewer-sharee holds). The outputs
  // render, but the editor-only Delete affordance is ABSENT (the `canEdit` gate — matching the
  // backend `require_project_edit`). The route mounts ArtifactReview with testid `artifact-detail-review`.
  const vctx = await browser.newContext()
  const vp = await vctx.newPage()
  await loginMemberToProjects(vp, viewer, MEMBER_PASSWORD)
  await vp.getByTestId('notification-bell').click()
  // WAIT for the invitation row, then wait for the accept to LAND — the same two waits
  // `viewer-readonly.spec.ts` documents, for the same reason. The bell popover fetches its list,
  // so a blind `.first().click()` can fire before the row exists; and the accept is a request, so
  // navigating on the click alone races it. Observed here as the deep-link route rendering
  // "You don't have access to this project's artifacts" with the bell still reading 1 unread —
  // a spec failing at its own precondition and looking like a permission regression.
  const accept = vp.locator('[data-testid^="notification-accept-"]').first()
  await accept.waitFor({ state: 'visible', timeout: 20_000 })
  await accept.click()
  await expect(accept).toHaveCount(0, { timeout: 20_000 })
  await vp.goto(`/projects/${id}/artifacts/run/${runId}`)
  await expect(vp.getByTestId('artifact-detail-route')).toBeVisible({ timeout: 20_000 })
  await expect(vp.locator('[data-testid^="artifact-detail-review-card-"]').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(vp.getByTestId('artifact-detail-review-delete')).toHaveCount(0)
  await vctx.close()
})
