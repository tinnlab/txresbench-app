// TEST-84 (visualize-pane ITEM-2 / ITEM-3) — **THE PANE IS THE PROJECT'S, AND SO IS ITS DATA.**
//
// Every section this round ships declares `permission: projects::use`, and every slice it reads
// goes through the project-scoped catalog. Neither fact is worth anything unless a user who
// cannot reach the PROJECT also cannot reach the pane or what it would have shown.
//
// ── the positive control is not bookkeeping ───────────────────────────────────────────────────
//
// "The Visualize pane is not visible to a restricted user" passes VACUOUSLY whenever the page did
// not load at all — a failed route, a login bounce, a render crash, a blank shell all satisfy
// "the affordance is not there". A real spec in this repo was confounded exactly that way and
// would have passed with its permission gate DELETED. So the same spec asserts BOTH halves: the
// permitted user sees the sections POPULATE, and the restricted user is refused while still being
// a logged-in user who reaches the app.

import { expect, test } from '@playwright/test'

import {
  createRestrictedUser,
  loginAsOwner,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'
import { BACKEND } from '../_owner'
import { createProject } from '../14-workbench/_dock'
import { CATEGORICAL_COLUMN, categoricalColumn, frameThePane, openVisualize, seedAnchoredProject } from './_visualize'

test.describe('the Visualize pane is gated on the project (ITEM-3)', () => {
  test('POSITIVE CONTROL: the owner reaches the pane and its sections POPULATE', async ({ page, request }) => {
    const projectId = await createProject(request, `visualize-access-ok ${Date.now()}`)
    await seedAnchoredProject(request, projectId, [categoricalColumn('cat-col', CATEGORICAL_COLUMN)])
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // Not merely "the stack rendered": the sections answered with this project's data. A pane that
    // mounted and showed nothing would satisfy a visibility-only assertion.
    //
    // § COORDINATES ANSWERS FIRST, AND ON ITS OWN. It is the pane's first block and it lists the
    // project's 2-D coordinate sets with nothing chosen — so THIS assertion is made before any
    // gesture, which is the half that proves the pane is not blank on open.
    const coordinates = page.getByTestId('widget-coordinatePicker-radio')
    await expect(coordinates).toBeVisible({ timeout: 30_000 })
    await expect(coordinates.getByRole('radio').first()).toBeVisible({ timeout: 30_000 })

    // ── § COLOUR BY POPULATES ON OPEN, BECAUSE A FRAME IS CHOSEN ON OPEN (ledger #24) ─────
    //
    // REWRITTEN. This asserted the section held NOTHING until a gesture, on the rule that a
    // frame is never picked for the user. The owner reversed that rule for this control —
    // *"Always select the first … please"*, of the thing § Coordinates offers — and the reversal is narrow: the selection
    // is visible in a radio, marked `auto`, and one click from any other, which is a different
    // act from the invisible binding the old rule was written against.
    //
    // What this test is FOR is unchanged: the pane, reached by an owner, populates. It is now
    // asserted in the state the user actually meets, with no gesture at all.
    await expect(page.getByRole('button', { name: `Plot ${CATEGORICAL_COLUMN}`, exact: true })).toHaveCount(1, {
      timeout: 30_000,
    })
    // …and an explicit pick of the DECLARED frame leaves it populated — the gesture is still
    // available and still scopes the section, which is what makes the opening state a default
    // rather than a lock.
    await frameThePane(page)
    await expect(page.getByRole('button', { name: `Plot ${CATEGORICAL_COLUMN}`, exact: true })).toHaveCount(1, {
      timeout: 30_000,
    })
  })

  test('a user without projects::use reaches the app but NOT the pane or its data', async ({
    browser,
    request,
  }) => {
    const admin = await ownerToken(request)
    const projectId = await createProject(request, `visualize-access-denied ${Date.now()}`)
    await seedAnchoredProject(request, projectId, [categoricalColumn('cat-col', CATEGORICAL_COLUMN)])

    const username = `vizrestricted${Date.now()}`
    await createRestrictedUser(request, admin, username)

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await loginViaUi(page, username, MEMBER_PASSWORD)
      // THE CONTROL, first: this user is genuinely logged in and off the login screen. Everything
      // below is about a permission, not about a session that never started.
      await waitUntilOffLoginScreen(page)

      // The deep link to the project's workbench is REFUSED — not silently blank.
      await page.goto(`/projects/${projectId}/workbench`)
      await expect(page.getByTestId('section-stack-visualize')).toHaveCount(0)
      await expect(page.getByRole('radiogroup', { name: 'Coordinates' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: `Plot ${CATEGORICAL_COLUMN}`, exact: true })).toHaveCount(0)

      // …and the DATA is refused at the source, not merely hidden in the UI. The pane populates
      // from the project catalog; a UI-only gate would leave this open.
      const token = await page.evaluate(() => {
        const raw = window.localStorage.getItem('auth-storage') ?? ''
        const m = /"token"\s*:\s*"([^"]+)"/.exec(raw)
        return m ? m[1] : ''
      })
      expect(token, 'the restricted user holds no session token — the API check below would be vacuous').not.toBe('')
      const r = await request.get(`${BACKEND}/api/projects/${projectId}/artifacts`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(
        [401, 403, 404],
        `the catalog answered ${r.status()} to a user without projects::use`,
      ).toContain(r.status())
    } finally {
      await ctx.close()
    }
  })
})
