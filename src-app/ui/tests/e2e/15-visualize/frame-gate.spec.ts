// TEST-21 (visualize-pane ITEM-13) — **THE PANE OPENS ASKING, AND § COORDINATES IS THE QUESTION.**
//
// ── WHAT THIS FILE WAS, AND WHY IT IS NOT THAT ANY MORE (owner, 2026-08-13) ───────────────────
//
// This spec used to be `anchor.spec.ts`. Its subject was the pane's FIRST BLOCK: a control that
// asked WHICH ROWS the pane was about — an "anchor" over the project's row spaces, rendered as a
// radio, with `data-anchored` / `data-anchor-origin` attributes and a `row-space-anchor` testid.
// The spec drove a project with TWO row spaces and asserted that the pane opened unanchored,
// plotted nothing, and lit up when the question was answered.
//
// The owner ruled that control out of existence: *"there is no such thing as a row space"*, and
// picking between two of a dataset's axes is not a choice that exists (the owner's own phrasing
// names the two populations; this file spends no domain vocabulary quoting it).
// `RowSpaceAnchor.tsx` and its unit test are deleted;
// none of those testids or attributes are in the tree. A spec addressing them would fail for the
// wrong reason — "the selector matched nothing" is not "the pane asked a question it should not".
//
// ── THE PROPERTY THAT SURVIVED, WORD FOR WORD ─────────────────────────────────────────────────
//
// The RULE this file exists for was never about the anchor. It is:
//
//     NOTHING in the pane can be plotted before the pane's question is answered, and
//     everything lights up the moment it is.
//
// That rule is untouched. What moved is WHICH question: the pane's first block is now
// § Coordinates, it lists the project's 2-D coordinate sets immediately with nothing chosen, and
// the rows every other section is scoped to are DERIVED from the set the user picks
// (`core/runtime/coordinateAxis.ts`). So the gate is the same gate, re-aimed at the control that
// now holds it — and the file is renamed to say what it gates rather than which control it once
// poked.
//
// ── REWRITTEN AGAIN: THE PANE NO LONGER OPENS UNCHOSEN (owner, ledger #24) ────────────────────
//
// *"Always select the first … please"*, of the thing § Coordinates offers. Everything below used to assert the opposite —
// that every radio is unchecked on open, that § Colour by lists nothing, and that the frame's ▶
// refuses — and it asserted it because a SILENTLY guessed binding once painted pictures of the
// wrong population. That reasoning is about an INVISIBLE binding. The owner's instruction is a
// different act: the selection is in a radio they are looking at, it carries the `auto` origin
// mark, and it is one click from any other.
//
// So the rule this file gates is restated, not dropped, and it is the half that was ever load-
// bearing: **WHICH coordinate set is chosen decides what every other section lists, and nothing
// is scoped to a population the pick did not name.** The fixture — two populations carrying a
// column of the SAME NAME — is what makes that assertable: a pane scoped to the wrong rows lists
// a column that reads identically, so only the identity can tell the two apart.
//
// INV-3's `[0]` refusal is untouched and is still what the second half of this spec proves: the
// pane does not resolve columns from "the project's first anything" — it resolves them from the
// SELECTED set, which is why changing the selection changes the list. `auto_bind_sole_candidate`
// remains ABSENT from § Coordinates: that is the INVISIBLE-binding affordance, and it is a
// different thing from a visible, marked, changeable radio selection.
//
// ── THE STATE THIS SPEC EXISTS FOR ────────────────────────────────────────────────────────────
//
// TWO source datasets, each publishing its own rows, its own 2-D coordinate set and a column of
// the SAME NAME. `mockup-conformance.spec.ts` proves the block is first, lists immediately, hides
// >2-D sets and draws one heading per dataset; what IT cannot see is what the REST OF THE PANE
// does in the unchosen state, because the rest of the pane is other sections resolving their own
// slices against `$scope.axis`. The failure mode is not "§ Coordinates is wrong" — it is a
// section that answers ANYWAY: a column table listing something, a ▶ that can be pressed. Either
// is `[0]` wearing a costume, and each lives in a different section from the picker.
//
// So the assertion is the whole pane at once, in both states.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { coordinateEmits, openVisualize, seedPopulations, SECTIONS } from './_visualize'

/** The two seeded populations. Their ROW COUNTS differ, which is what makes their coordinate
 *  sets tellable apart in the offer (the option's coverage line reads `<n> rows · 2D`) — and
 *  their names are what the group headings show. */
const POPULATIONS = [
  { name: 'population-alpha', rows: 60 },
  { name: 'population-beta', rows: 40 },
] as const

/** The column name BOTH populations carry (`seedPopulations` writes it on each). It is the
 *  `[0]` tripwire: a pane scoped to the wrong rows — or to no rows but answering anyway —
 *  would list two of these, or one belonging to the population that was not chosen. */
const SHARED_COLUMN = 'metric one'

test.describe("§ Coordinates is the pane's first question (ITEM-13)", () => {
  test('the pane opens with the FIRST set chosen, and the pick is what scopes every other section', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-frame-gate ${Date.now()}`)
    await seedPopulations(request, projectId, POPULATIONS)
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // ── IT LISTS, AND THE FIRST IS CHOSEN (ledger #24) ──────────────────────────────────
    const coordinates = page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
    await expect(coordinates).toBeVisible({ timeout: 30_000 })
    const options = coordinates.getByRole('radio')
    await expect(options).toHaveCount(POPULATIONS.length, { timeout: 30_000 })
    // EXACTLY ONE is checked, and it is the FIRST. Asserted as a count as well as a position:
    // "the first is checked" is satisfied by a control that checked them all.
    await expect(options.first()).toBeChecked({ timeout: 30_000 })
    for (let i = 1; i < POPULATIONS.length; i++) await expect(options.nth(i)).not.toBeChecked()
    // One heading per source dataset, because there is more than one: which population a
    // coordinate set belongs to is a HEADING over the sets, never a question asked before them.
    await expect(coordinates.getByTestId(/widget-coordinatePicker-group-/)).toHaveCount(
      POPULATIONS.length,
      { timeout: 30_000 },
    )

    // ── AND THE PANE IS SCOPED TO THAT ONE, NOT TO "THE PROJECT" ────────────────────────
    //
    // This is INV-3's `[0]` tripwire, and the fixture is what arms it: both populations carry a
    // column of the SAME NAME on DIFFERENT rows, so a pane that resolved columns project-wide —
    // or from whichever population happened to be listed first in the catalog rather than from
    // the SELECTION — would list two rows reading alike. Exactly one may be listed.
    const colourBy = page.locator(`[data-section-id="${SECTIONS.colourBy}"]`)
    await expect(colourBy).toBeVisible({ timeout: 30_000 })
    await expect(
      colourBy.getByRole('button', { name: `Plot ${SHARED_COLUMN}`, exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })

    // ── CHANGING THE SELECTION RE-SCOPES THE PANE ───────────────────────────────────────
    //
    // The positive control that makes the count above mean "derived from the pick" rather than
    // "there happens to be one". The SECOND population's set is addressed by the option's
    // COVERAGE (`<n> rows · 2D`) — the declared fact that tells the two apart, since their
    // producer-declared names are identical on purpose.
    const second = coordinates.getByRole('radio', {
      name: new RegExp(`\\b${POPULATIONS[1].rows.toLocaleString()}\\b`),
    })
    await expect(second).toHaveCount(1)
    await second.click()
    await expect(second).toBeChecked({ timeout: 30_000 })

    // …and the first stops being chosen: this control holds exactly ONE value (DEC-10 — the
    // coordinate is the FRAME), so two selections would mean the pane is drawing in two frames.
    await expect(
      coordinates.getByRole('radio', { name: new RegExp(`\\b${POPULATIONS[0].rows.toLocaleString()}\\b`) }),
    ).not.toBeChecked()

    // § Colour by now lists the CHOSEN population's columns — exactly ONE by the shared name,
    // because the other population carries a column of the same name on different rows and a
    // name did not fetch it. This is the assertion that proves `$scope.axis` was DERIVED from
    // the coordinate set rather than defaulted.
    await expect(page.getByRole('button', { name: `Plot ${SHARED_COLUMN}`, exact: true })).toHaveCount(1, {
      timeout: 30_000,
    })

    // EVERY coordinate row carries its own ▶ (ledger #27) — the single foot-of-card control
    // this spec used to address is gone, and with it the pane-wide refusal it carried. A row's
    // ▶ is about that row, so there is one per option and none of them is ever gated on a
    // selection.
    //
    // (`NO_COORDINATE_REFUSAL` is not asserted here any more because the pane can no longer be
    // driven into it through the UI: with the first set selected on open, a rendered pane always
    // has a coordinate. The constant and its rows-side gate stay covered by
    // `rowSpaceColumns.test.ts`.)
    await expect(coordinateEmits(page)).toHaveCount(POPULATIONS.length, { timeout: 30_000 })
  })
})
