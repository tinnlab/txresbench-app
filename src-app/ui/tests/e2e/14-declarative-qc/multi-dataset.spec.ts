import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  seedProjectDataset,
  awaitFilterSurface,
  addCriterionRow,
  pickCriterionColumn,
  chooseSurfaceDataset,
  expectCriteriaColumns,
  CF,
  CF_DATASET,
  CFRow,
} from './_seed'

// TEST-E6 (e2e) [covers: ITEM-9, ITEM-10] — TWO datasets in one project, driving the SAME declared
// surface, and each one building its OWN criteria.
//
// ── WHAT THIS SPEC USED TO PROVE, AND WHY IT WAS NOTHING ────────────────────────────────
//
// It seeded two datasets, waited for the surface, added a criterion and watched the shared canvas
// flip. It never CHOSE a dataset — and with two candidates the `artifact_ref` picker deliberately
// pre-selects nothing (`ArtifactRefWidget`: pre-selection happens only at exactly one candidate,
// visibly, because guessing between several is the invisible resolution the widget replaced). So
// `$state.expression` stayed empty and the criterion column picker had nothing to offer.
//
// That was survivable for as long as the builder's columns came from a PROJECT-WIDE report
// artifact, because then they did not depend on the choice at all — which is exactly what the
// view declared until the slice became an axis relation anchored on the picker's own value
// (`axis_columns { of: $state.expression, … }`; the view file records the move and its reason).
// From that day the unchosen dataset was fatal here, and invisible everywhere else in this
// directory: every other spec seeds ONE candidate, so pre-selection answers for them.
//
// So the spec's subject — two datasets, each building its own criteria — was never once observed,
// in either regime. Adding the missing click would have made it green while leaving that hole
// open, so the assertions are about the property instead:
//
//   · the picker offers BOTH and pre-selects NEITHER (the precondition, pinned — otherwise every
//     assertion below could hold on a project with one dataset);
//   · with dataset A chosen, the criteria builder offers EXACTLY A's columns — not B's, not both;
//   · switching to B RE-ANCHORS it: exactly B's columns, and A's distinct column is gone.
//
// TWO MORE, added when the spec's own shape turned out to be hiding them:
//
//   · WITH NO DATASET CHOSEN, an added criterion row states WHY its column picker offers
//     nothing, at the picker. "Add criterion" is enabled, so that row is one click from the
//     surface's opening state; the Run footer names the cause four controls below, and a user
//     pokes the empty picker rather than the footer.
//   · SWITCHING WITH A CRITERION STILL BUILT keeps it and marks it. The spec used to REMOVE the
//     criterion before switching, which is precisely why it never saw that nothing reconciles
//     the criteria on a switch: a criterion built on A survived onto B naming a column B does
//     not have, and the row then drew no control and no reason.
//
// The two datasets are seeded with a column the other one does not have, because that is what
// makes the third bullet an observation at all: with identical column sets, "the builder read the
// dataset I chose" and "the builder read whatever is in the project" produce the same list.
//
// PURE — two datasets seeded directly; the per-instance store + canvas resolution run for real.
// Headless GL cannot paint, so the canvas half is asserted structurally (`data-viz-framework`),
// not GL pixels.

/** A per-dataset column, present on ONE of the two datasets. Values are a plain ramp — what
 *  matters is the NAME (the discriminator) and that it is numeric, so it reads as a range
 *  criterion like the shared metric columns beside it. */
const rampColumn = (name: string, nRows: number): { name: string; values: number[] } => ({
  name,
  values: Array.from({ length: nRows }, (_, i) => i % 37),
})

const N_ROWS = 200

test.describe('two datasets drive the same declared surface with no leakage (TEST-E6)', () => {
  test('each dataset builds its OWN criteria; switching datasets re-anchors the builder', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Multi Dataset ${Date.now()}`)
    // Two REAL project-attached datasets, each with a `single-cell/expression` artifact and one
    // per-row column the other does not carry.
    const a = await seedProjectDataset(request, id, `Aorta ${Date.now()}`, N_ROWS, [
      rampColumn('only_on_a', N_ROWS),
    ])
    const b = await seedProjectDataset(request, id, `Brain ${Date.now()}`, N_ROWS, [
      rampColumn('only_on_b', N_ROWS),
    ])
    await openWorkbench(page, id)

    // The declarative filter surface auto-mounts (its `single-cell/expression` availability holds
    // for the project's datasets).
    await awaitFilterSurface(page)
    const host = page.getByTestId('workbench-canvas-host')
    await expect(host).toBeAttached({ timeout: 20_000 })
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })

    // ── THE PRECONDITION, pinned ────────────────────────────────────────────────────────
    //
    // Two candidates ⇒ a real picker with NOTHING chosen. Without this the assertions below
    // could all hold on a one-dataset project, where the picker pre-selects and there is no
    // choice being made at all — which is exactly how this spec came to pass without ever
    // exercising its subject.
    await expect(
      page.getByTestId(CF_DATASET.select),
      'two datasets ⇒ the dataset picker is a real control, not a sole-candidate summary',
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(CF_DATASET.summary)).toHaveCount(0)
    await expect(page.getByTestId(CF_DATASET.empty)).toHaveCount(0)

    // ── WHAT AN EMPTY CRITERION ROW SAYS, BEFORE A DATASET IS CHOSEN ────────────────────
    //
    // "Add criterion" is enabled here on purpose, so this row is reachable in one click from
    // the surface's opening state. The Run footer already names the cause — its requirement
    // list says "Dataset — …" and Run is disabled — but that is four controls below, and a
    // user pokes the empty picker, not the footer. So the picker itself has to say what it is
    // about; the engine's generic "No options yet" names only the symptom, at the user's own
    // hand.
    await addCriterionRow(page)
    const emptyPicker = page.getByTestId(CFRow.col(0))
    await expect(emptyPicker).toBeVisible({ timeout: 20_000 })
    await expect(emptyPicker, 'nothing to offer ⇒ the picker is disabled, not a blank box').toBeDisabled()
    // The sentence is asserted where a KEYBOARD/AT user can reach it: the trigger is disabled
    // (out of the tab order) and carries its own row-naming aria-label, so its contents are
    // exactly what such a user never hears — the note beside it is the readable copy, and it is
    // also the only one a single table column is wide enough to show in full.
    const emptyNote = page.getByTestId(`${CFRow.col(0)}-empty`)
    await expect(emptyNote).toHaveText(/columns to filter on/i)
    await expect(emptyNote, 'the sentence points at the control that causes the emptiness').toHaveText(
      /dataset chosen above/i,
    )
    await expect(emptyPicker).toHaveAttribute('aria-describedby', /-empty$/)
    // Group-by is the same emptiness with a different set behind it, and says so in its own words.
    await expect(page.getByTestId(`${CF.groupBy}-field`)).toContainText(/categorical column to group by/i)
    // …and back to the opening state, so the flow below is unchanged.
    await page.getByTestId(CFRow.remove(0)).click()

    // ── DATASET A ───────────────────────────────────────────────────────────────────────
    await chooseSurfaceDataset(page, a.expression_artifact_id)
    await addCriterionRow(page)
    await expectCriteriaColumns(
      page,
      0,
      a.column_names,
      'the criteria builder is anchored on the CHOSEN dataset: exactly the columns seeded on ' +
        'A, and none of B’s — a resolver that unioned the project would show both sets, and a ' +
        'resolver anchored on the wrong dataset would show the other one',
    )
    // Build the criterion on A's OWN column — the one B does not have, so it can only have come
    // from the dataset that was chosen.
    await pickCriterionColumn(page, 0, { column: 'only_on_a' })
    await expect(host).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })
    // The precondition for the switch below: on A this form is complete and the run is offered.
    // Without it, "Run is disabled after the switch" could be a constant rather than a change.
    await expect(page.getByTestId(CF.run), 'the form is launchable on A').toBeEnabled({ timeout: 20_000 })

    // ── SWITCHING DATASETS WITH THE CRITERION STILL THERE ───────────────────────────────
    //
    // This spec used to REMOVE the criterion before switching, which is why the defect it now
    // pins was never observed: the picker's own setter writes ONE field and nothing reconciles
    // the criteria, so a criterion built on A survives onto B naming a column B does not carry.
    // The launch was always protected (`inputs_from` errors on an unresolvable column); the
    // gap was the FORM in between — `controlByColumn[$row.column]` is undefined for an
    // off-axis column, which is the gate both bound arms, the keep-set AND the canvas series
    // read, so the row drew its column name over three empty slots and plotted nothing.
    await chooseSurfaceDataset(page, b.expression_artifact_id)

    // 1. The criterion is KEPT — not silently deleted. A user switching to compare and
    //    switching back must find their work, not a blank builder.
    await expect(
      page.getByTestId(CFRow.col(0)).locator('[data-value="only_on_a"]'),
      'the switch discarded the criterion the user built',
    ).toBeVisible({ timeout: 20_000 })

    // 2. …and it now says why it is unusable, ON THE ROW, naming the dataset change. Polled,
    //    because the anchored frame is fetched: for a beat after the switch the builder is
    //    still answering about the dataset the user left (a known transient — see the report).
    const rowMessage = page.getByTestId(`${CFRow.col(0)}-error`)
    await expect(rowMessage, 'the row plots nothing and explains nothing').toBeVisible({ timeout: 30_000 })
    await expect(rowMessage).toHaveText(/no column by this name/i)
    await expect(rowMessage).toHaveText(/switching datasets/i)
    await expect(rowMessage).toHaveAttribute('role', 'alert')

    // 3. …and the run is refused at the FORM, before the user presses anything.
    await expect(page.getByTestId(CF.run), 'a criterion the run cannot bind left Run pressable').toBeDisabled()

    // 4. …and the pane it drives is honest about having nothing to show for that criterion.
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })

    // ── DATASET B — the same surface, re-anchored ───────────────────────────────────────
    //
    // Asked of a FRESH row, deliberately. The marked row STILL DISPLAYS `only_on_a`, and a
    // closed set prepends the value it is bound to rather than swapping it for something the
    // user did not choose (`ClosedSetSelect`) — so that row's option list carries one entry
    // that is a fact about the ROW, not about the axis. This question is about the AXIS, and
    // asking it where the answer is polluted is how a set assertion stops meaning anything.
    await addCriterionRow(page)
    await expectCriteriaColumns(
      page,
      1,
      b.column_names,
      'switching the dataset re-anchors the builder — B’s columns, and A’s distinct column is ' +
        'gone. A builder that kept offering `only_on_a` here would be reading state belonging ' +
        'to a dataset the user has moved off',
    )
    await page.getByTestId(CFRow.remove(1)).click()

    // …and the marked row keeps its unresolvable value ON OFFER, so the remedy is a re-pick in
    // place rather than a delete-and-retype: the value is never silently swapped for a column
    // the user did not choose.
    await expect(
      page.getByTestId(CFRow.col(0)).locator('[data-value="only_on_a"]'),
      'the marked row stopped showing what it holds',
    ).toBeVisible()
    await pickCriterionColumn(page, 0, { column: 'only_on_b' })
    await expect(rowMessage, 'the mark outlived the condition that produced it').toHaveCount(0)
    await expect(page.getByTestId(CF.run)).toBeEnabled({ timeout: 20_000 })
    await expect(host).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })

    await page.getByTestId(CFRow.remove(0)).click()
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })
  })
})
