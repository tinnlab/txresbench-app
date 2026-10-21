import { expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { awaitQcSurface, seedProjectDataset } from './_seed'

// The project's ARTIFACT SET changes from OUTSIDE this browser context, and the workbench's
// `artifact_ref` picker updates WITHOUT a reload.
//
// ── Why this spec exists ─────────────────────────────────────────────────────────────
//
// `catalogEpoch` — the trigger every declarative input picker re-reads the project catalog
// on — used to advance ONLY through hand-maintained `refreshCatalog()` call sites. Attaching
// or detaching a dataset was not one of them, so the project's artifact set changed (the
// workbench catalog unions `project_id = $1` with the artifacts of its ATTACHED datasets)
// while every picker kept offering the old rows, with no error to show for it. Adding
// attach/detach as one more call site would have reproduced the defect at the next mutation.
//
// The epoch is now DERIVED from the realtime `sync:` channel, so this asserts the property
// that distinguishes a real mechanism from a local nudge: the mutation happens on a
// DIFFERENT client entirely (a bare API context — no browser, no shared connection), and
// the mounted workbench learns anyway. Follows the `project/sync-live.spec.ts` two-client
// convention.
//
// The assertion is the picker's own rendered CONTROL, which `ArtifactRefWidget` chooses by
// candidate count: exactly one candidate renders a read-only `-summary` <output> ("Only one
// match — selected automatically"), two or more render a real `-select`. So a picker that
// learned CHANGES SHAPE; one that did not stays a summary. That is a user-visible fact, not
// an internal counter.

test.describe('the workbench picker learns of an artifact-set change from the sync channel', () => {
  test('a dataset attached by ANOTHER client updates the picker with no reload', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const target = await createProject(request, `Picker Sync ${Date.now()}`)
    // A second project is only a PARKING place: it gives us a dataset carrying a real
    // artifact of the analysable matrix type WITHOUT linking it to the project under test,
    // so the attach below is the one thing that changes the target project's artifact set.
    const parking = await createProject(request, `Picker Sync Parking ${Date.now()}`)

    const attached = await seedProjectDataset(request, target, `Attached ${Date.now()}`)
    const incoming = await seedProjectDataset(request, parking, `Incoming ${Date.now()}`)

    await openWorkbench(page, target)

    // The shipped declarative view AUTO-MOUNTS as a pane (`placeViews`) once its declared
    // applicability holds — which the seed satisfies. Its matrix picker is an `artifact_ref`
    // over that declared type: the exact surface the defect was reported on. No launcher
    // affordance is driven, so this asserts the pane the user
    // actually sees rather than the run pane's fallback form.

    // MOUNTED IS NOT VISIBLE, and this spec was reading the difference as a defect. The picker
    // below belongs to ONE of the two shipped declarative surfaces; both declare the SAME
    // inspected datatype, so the seed auto-mounts BOTH as sibling tabs of one region — and only
    // the ACTIVE tab renders a body. The other one came up active, so the control this spec
    // waits for was never going to be in the DOM: it timed out after 30 s and reported a broken
    // realtime channel that was working the whole time.
    //
    // Activating a TAB is not a reload and re-reads no catalog: it is the same `setActive` a
    // user performs by clicking, and it happens BEFORE the mutation below. The subject is
    // therefore untouched — everything after the attach is asserted against this same mounted,
    // never-reloaded, never-renavigated page. Verified by breaking the realtime subscription and
    // confirming this spec then fails at the POST-ATTACH assertion, not at this wait.
    await awaitQcSurface(page)

    // ONE candidate ⇒ the sole-candidate summary. This also pins the precondition: if the
    // picker were already a select here, the assertion after the attach would be vacuous.
    const summary = page.getByTestId('widget-matrixPicker-summary')
    const select = page.getByTestId('widget-matrixPicker-select')
    await summary.waitFor({ state: 'visible', timeout: 30_000 })
    await expect(select).toHaveCount(0)
    expect(attached.expression_artifact_id, 'the seeded dataset produced an expression artifact').toBeTruthy()

    // ── The mutation, from a client that is NOT this browser context ────────────────
    const token = await ownerToken(request)
    const r = await request.post(`${BACKEND}/api/projects/${target}/datasets/${incoming.dataset_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(r.ok(), 'the attach succeeded').toBeTruthy()

    // ── The property: the mounted page updates itself. No reload, no navigation. ────
    // Two candidates now ⇒ the picker must have become a real select offering both.
    await expect(select).toBeVisible({ timeout: 30_000 })
    await expect(summary).toHaveCount(0)

    // And the DETACH direction, which is the half a "refetch after my own write" nudge
    // would never cover: the artifacts leave the catalog and the picker collapses back.
    const d = await request.delete(`${BACKEND}/api/projects/${target}/datasets/${incoming.dataset_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(d.ok(), 'the detach succeeded').toBeTruthy()
    await expect(summary).toBeVisible({ timeout: 30_000 })
    await expect(select).toHaveCount(0)
  })
})
