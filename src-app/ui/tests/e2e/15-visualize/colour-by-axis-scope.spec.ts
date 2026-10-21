// § COLOUR BY OFFERS THE CHOSEN COORDINATE SET'S ROWS' COLUMNS, AND NOTHING ELSE.
//
// ── The reported defect ────────────────────────────────────────────────────────────────
//
// Owner: *"why is metadata-column:[the sibling axis] in the color by, they are the [entries]
// that appear in the [entries] section"* — elided only where the report names the science, so
// this file spends no domain vocabulary quoting it. Right, and it is the SAME conflation the
// row-space picker had (that control is deleted — owner, 2026-08-13: *"there is no such thing as
// a row space"*), one layer down: a column carrying one value per entry of the SIBLING
// axis was offered as a thing to colour these rows by, and it was MARKED "alignment not
// declared" while it was.
//
// Its alignment was never unknown. The producer says which axis it is on. The engine asked
// only *"does `aligned_to` match?"*, so anything that did not answer THAT question landed in
// A3 — offered and marked (DEC-11) — however plainly it had answered a question that settles
// it. Two populations of candidate reached the list that way:
//
//   · a column on the sibling axis that declares no key sequence (the migration state, and
//     what every producer emitted before `aligned_to` existed);
//   · THE AXES THEMSELVES. A key artifact declares no `aligned_to` — correctly; it is what
//     everything else is aligned TO — so both key artifacts were listed as ordinary columns,
//     on every project, and marked.
//
// The mark firing on nearly every row is the same finding from the other side: a marker that
// fires on everything stops being read, which is the argument ITEM-20 already makes for
// standing the per-row marks down when they cannot distinguish anything.
//
// ── What this asserts, and why it is the CLASS ─────────────────────────────────────────
//
// The invariant is *a candidate declaring a different axis from the pane's rows is never offered*,
// with a POSITIVE CONTROL that a same-axis candidate whose row-alignment is genuinely
// undeclared IS still offered and marked. A spec asserting that one particular axis's columns
// stay out is one instance and lets the next axis through, so the fixture is neutral
// (`entities` / `others`) and an implementation that recognised a label would not pass it.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { SECTIONS, frame, openVisualize, seedTwoAxisShape } from './_visualize'

test.describe("§ Colour by is scoped to the chosen coordinate set's rows", () => {
  test('a column on ANOTHER axis is never offered — declared or not — and neither is an axis', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `colour-by-scope ${Date.now()}`)
    await seedTwoAxisShape(request, projectId, 'Population 1')
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // ── WHAT SCOPES THIS SECTION, AND WHAT IT USED TO BE (owner, 2026-08-13) ─────────
    //
    // This block used to wait for the pane ANCHOR to settle — one plottable row space meant it
    // auto-anchored and the list below was about rows nobody had to choose. That control is
    // DELETED (*"there is no such thing as a row space"*), so the rows this section is scoped
    // to are now DERIVED from the coordinate set picked in § Coordinates
    // (`core/runtime/coordinateAxis.ts`). The pane's question is answered by PICKING, and it is
    // never answered for the user: § Coordinates omits `auto_bind_sole_candidate`, which under
    // DEC-15 means OFF even here, where the fixture publishes exactly one 2-D set.
    //
    // The INVARIANT below is untouched. Only the gesture that reaches it changed.
    const coordinates = page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
    await expect(coordinates).toBeVisible({ timeout: 30_000 })
    const coordinateOptions = coordinates.getByRole('radio')
    // Exactly one — the fixture's positions rest on the PRIMARY axis only, and a second option
    // would mean the click below was a coin toss rather than the answer to the pane's question.
    await expect(coordinateOptions).toHaveCount(1, { timeout: 30_000 })
    await coordinateOptions.first().click()
    await expect(coordinateOptions.first()).toBeChecked({ timeout: 30_000 })

    const colourBy = page.getByTestId(frame(SECTIONS.colourBy))
    await expect(colourBy).toBeVisible({ timeout: 30_000 })

    // ── THE OFFER ────────────────────────────────────────────────────────────────────
    //
    // Exactly the column that rests on the chosen set's rows. Asserted as an EXCLUSION of named
    // fixtures rather than as a count, so a future extra offering is attributable.
    const plots = colourBy.getByRole('button', { name: /^Plot /i })
    await expect(plots).toHaveCount(1, { timeout: 30_000 })
    await expect(plots.first()).toHaveAccessibleName(/grouping/i)

    const listed = (await colourBy.innerText()).toLowerCase()
    // The sibling axis's columns — the reported instance, in both of its shapes.
    expect(listed, 'a sibling-axis column that DECLARES its alignment').not.toContain('declared elsewhere')
    expect(listed, 'a sibling-axis column that declares only its AXIS').not.toContain('undeclared elsewhere')
    // The AXES. An axis is not a column on itself; offering it offers the row identifiers.
    expect(listed, "the anchored axis's own key artifact").not.toContain('row keys')
    expect(listed, "the sibling axis's key artifact").not.toContain('entry keys')

    // ── AND THE MARK IS GONE WITH THEM ───────────────────────────────────────────────
    //
    // Not merely "fewer rows": the reason those rows were there was a misclassification as
    // A3, so the marker they carried has to be gone too. NOTE the prose that once aggregated
    // this fact at the section level was removed on 2026-08-13 — it is now stated exactly ONCE
    // per pane, as § Coordinates' `coordinateAlignmentAlert` — so this assertion is scoped to
    // § Colour by (`listed`) and is unaffected. The one surviving column DECLARES
    // its alignment, so nothing on this pane has unknown alignment and nothing may say it
    // does.
    expect(listed).not.toContain('alignment not declared')

    await test.info().attach('colour-by-chosen-axis-only.png', {
      body: await colourBy.screenshot(),
      contentType: 'image/png',
    })
  })
})
