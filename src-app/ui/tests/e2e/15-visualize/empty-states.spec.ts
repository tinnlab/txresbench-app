// TEST-78 (visualize-pane ITEM-63) — the Visualize pane's emptinesses SAY WHICH ONE THEY ARE.
//
// ── the failure this is written against ─────────────────────────────────────────────
//
// A pane that answers every kind of nothing with the same "no data" is a pane that tells a
// user with a fixable situation to go away. So an empty § Coordinates must say, in its own
// sentence, ON the control, what is missing and what would fix it — not an engine's generic
// wording somewhere else on the screen (INV-5: the view cannot observe candidate availability
// at all, so the sentence has to be DECLARED by the view).
//
// The canvas half matters for the same reason, and its SCOPE here is narrowed deliberately —
// see the note at the assertion: with nothing emitted this pane mounts no canvas surface, so
// what is asserted is the half that is this pane's own claim, that a project which is merely
// NEW never reads as broken. A red surface on a new project is the single most misleading
// state this pane can be in.
//
// ── HOW THIS EMPTINESS IS REACHED NOW, AND WHAT IT USED TO BE (owner, 2026-08-13) ───
//
// § Coordinates used to have TWO shapes of zero, because its source was `aligned_to:
// "$scope.axis"` — the list was empty until the pane's FIRST BLOCK, a control asking WHICH
// ROWS, had been answered. So the two zeros were "no row space anchored" and "a row space
// anchored, but nothing declaring positions aligned to it", the shipped sentence named BOTH
// remedies, and this spec reached the second by anchoring a row space that had no positions.
//
// The owner ruled that control out of existence: *"there is no such thing as a row space"*.
// § Coordinates is now the pane's first block and its source is PROJECT-WIDE
// (`{capabilities: [plottable-xy], dims: 2}`), so:
//
//   · the ANCHOR zero is GONE — not descoped, not untested: there is no anchor, no gesture
//     that could precede this list, and therefore no state in which the list is empty
//     *because something above it is unanswered*. What replaced it is the single zero
//     asserted below. (The gate that the pane asks no such question at all, in any branch, is
//     `mockup-conformance.spec.ts`; it is not restated here.)
//   · the remaining zero is the honest one: THE PROJECT DECLARES NO 2-D PLOTTABLE ARTIFACT.
//     One line, one remedy, and it is the view's own sentence.
//
// ── what the fixture is, and why it is not the obvious one ──────────────────────────
//
// The obvious fixture — a project with NOTHING plottable — does not reach this state, and
// finding that out is half of what this spec pins. The SECTION's `applies_to` is a capability
// selector (`plottable-xy`), so with nothing plottable anywhere the section is unavailable and
// never renders: the pane is silent rather than empty, which is a different (and correct)
// behaviour.
//
// The state the sentence is written for needs the two narrowings to DISAGREE: an artifact that
// carries the capability (so the section is available) but declares MORE than two components
// (so the picker's `dims: 2` does not offer it). That is a real project — a decomposition is
// the ordinary case, and the pane draws a picture in two dimensions — and it is a CONTROLLED
// negative: same datatype, same capability, same axis as an offered set; the only difference
// is the declared width. Offering it would mean a component picker or a silent "first two",
// which is `layouts[0]` wearing a default.
//
// Per ITEM-66/phase-4, the remedy here is STATED, not offered — there is no "produce
// positions for me" button. The absence is asserted, so re-adding the affordance re-opens
// the decision instead of sliding in.
import { expect, test } from '@playwright/test'

import { createProject } from '../14-workbench/_dock'
import { loginAsOwner } from '../project/_helpers'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import { DT, ENTITY_AXIS, entityColumnArtifact, zarrEmbeddingArtifact } from '../14-declarative-qc/_fixtures'
import { openVisualize, SECTIONS, frame, stack } from './_visualize'

const ROWS = 24
const KEY_DIGEST = 'e2e-empty-states-row-space'
/** The declared component count of the ONE plottable artifact this project holds. Anything
 *  but 2: the picker declares `dims: 2`, so this is what makes the section AVAILABLE and its
 *  offer EMPTY at the same time. */
const WIDE_COMPONENTS = 50

/** The view's own sentence for this zero, split at the dash so neither half depends on which
 *  dash character survives the round trip. Taken from the DECLARATION
 *  (the contributing package's `ui/coordinates.yaml`, `empty_text:`) rather than invented here —
 *  a spec that spelled its own wording would pass against a pane that says something else. */
const EMPTY_TEXT = {
  what: /No 2-D coordinates in this project yet/i,
  remedy: /run an analysis that produces some/i,
} as const

test.describe('§ Coordinates states WHICH emptiness it is, and the canvas invites (TEST-78 / ITEM-63)', () => {
  test('a project whose only plottable artifact is wider than 2-D: the picker states the remedy; the canvas is not an error', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const projectId = await createProject(request, `INV5 empty ${Date.now()}`)

    // ── the fixture, in ONE plan ─────────────────────────────────────────────────────
    //
    //  · a KEY artifact — the rows everything else declares itself against.
    //  · ONE plottable artifact, aligned, and FIFTY components wide. It is what makes
    //    § Coordinates available (the capability) and what the picker refuses to offer (the
    //    declared width). The member payload is the shared builder's, with only the declared
    //    shape widened — the member PATH is the reader's, not this fixture's to restate.
    //  · a metadata column, so § Colour by is available and the PANE renders — without it the
    //    pane could be empty for an unrelated reason and prove nothing.
    const keyValues = Array.from({ length: ROWS }, (_, i) => i)
    const key = entityColumnArtifact('row keys', keyValues, ENTITY_AXIS)
    const col = entityColumnArtifact('metric one', keyValues, ENTITY_AXIS)
    const wide = zarrEmbeddingArtifact(ROWS)
    await postSeedPlan(request, projectId, {
      dataset: { name: `empty-states-${Date.now()}`, datatype: DT.expression },
      artifacts: [
        {
          output_id: 'rows-index',
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...key.structure, key: 'values', key_sequence_digest: KEY_DIGEST },
          meta: { ...key.meta, is_axis_index: true },
          content: { encoding: 'members', members: key.members },
        },
        {
          output_id: 'wide-positions',
          datatype: DT.embedding,
          scope: 'dataset',
          structure: {
            ...wide.structure,
            aligned_to: KEY_DIGEST,
            arrays: (wide.structure.arrays as Array<Record<string, unknown>>).map(a => ({
              ...a,
              shape: [ROWS, WIDE_COMPONENTS],
            })),
          },
          meta: { name: 'decomposition', n_dims: WIDE_COMPONENTS },
          content: { encoding: 'members', members: wide.members },
        },
        {
          output_id: 'col-0',
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...col.structure, aligned_to: KEY_DIGEST },
          meta: { ...col.meta, kind: 'continuous', min: 0, max: ROWS - 1, n: ROWS },
          content: { encoding: 'members', members: col.members },
        },
      ],
    })

    await openVisualize(page, projectId)

    // ── the emptiness, as a SENTENCE, on the control ─────────────────────────────────
    //
    // Reached with NO gesture at all, which is itself the change: this list is the pane's
    // first block and nothing precedes it, so what is on screen here is what a user meets on
    // open.
    const coordinates = page.getByTestId(frame(SECTIONS.coordinates))
    await expect(coordinates, 'the Coordinates section must render — it is available').toBeVisible({
      timeout: 30_000,
    })

    // POSITIVE CONTROL, and it is the clause that keeps this test honest: the section must
    // genuinely be OFFERING NOTHING. Without it, "the sentence is on screen" could be true
    // of a section that also has candidates, and the emptiness would never have been reached.
    await expect
      .poll(async () => coordinates.getByRole('radio').count(), { timeout: 30_000 })
      .toBe(0)
    // …and the emptiness is the ARTIFACT PICKER's own arm, not a section that failed to
    // render: the control is there, and it is holding nothing.
    await expect(coordinates.getByTestId('widget-coordinatePicker-empty')).toBeVisible({
      timeout: 30_000,
    })

    // The DECLARED sentence — one line, one remedy (owner feedback #6: a ~300px rail is not
    // the place for a paragraph). Both halves, so a sentence that names the problem and drops
    // the remedy fails here.
    //
    // Read off the PICKER'S OWN FIELD rather than the whole section: `empty_text` is declared
    // on the control and rendered as its description, and a section-wide read would pass on a
    // pane that printed the sentence somewhere else entirely — which is the ITEM-63 defect
    // ("the view's own sentence, on the control") rather than the fix.
    const text = (await coordinates.getByTestId('widget-coordinatePicker-field').innerText()).replace(
      /\s+/g,
      ' ',
    )
    expect(text, 'the emptiness must say WHAT is missing').toMatch(EMPTY_TEXT.what)
    expect(text, 'the emptiness must name the remedy').toMatch(EMPTY_TEXT.remedy)
    // NOT the engine's generic fallback. `empty_text` is declared by the view precisely so the
    // reader gets the view's sentence, and a declaration that stopped being read would leave
    // this string in its place while everything above still passed.
    expect(text, "the engine's generic emptiness replaced the view's own sentence").not.toMatch(
      /No artifact in this project matches what this input accepts/i,
    )
    // The ANCHOR remedy is GONE, and asserted gone rather than dropped in silence: the pane no
    // longer has a question above this list, so a sentence telling the user to answer one
    // would name a control that does not exist (owner, 2026-08-13).
    expect(text, 'the emptiness still names the deleted anchor as a remedy').not.toMatch(/anchor/i)

    // ── ITEM-66: the remedy is STATED, not offered ───────────────────────────────────
    const buttons = coordinates.getByRole('button')
    const labels = await buttons.allInnerTexts()
    const offers = labels.filter(l => /run|produce|create|make|generate/i.test(l))
    expect(
      offers,
      '§ Coordinates offers a "make me one" affordance — ITEM-66 descoped it; the remedy is ' +
        'stated. Re-open the decision rather than re-adding it.',
    ).toEqual([])

    // ── the canvas does not FAIL ─────────────────────────────────────────────────────
    //
    // SCOPE, stated rather than implied. TEST-78's enumeration reads "the canvas shows the
    // opening sentence rather than an error". Only the SECOND half is asserted here, because
    // the first is not this pane's state: with nothing emitted the Visualize pane does not
    // mount a canvas surface at all, so `workbench-canvas-empty` is legitimately absent (it
    // is asserted visible, on the surfaces that DO mount it, by
    // `14-workbench/canvas-host-height.spec.ts` and `14-workbench/canvas-gridworkspace.spec.ts`).
    // Asserting it here would have meant asserting a state the app does not enter.
    //
    // What IS this pane's claim, and what the whole section is written against, is that a
    // project which is merely NEW never reads as broken.
    await expect(page.getByTestId('workbench-canvas-error')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const paneText = (await page.getByTestId(stack).innerText()).replace(/\s+/g, ' ')
    expect(
      paneText,
      'the pane reads as an ERROR on a project that is merely new',
    ).not.toMatch(/error|failed|failure|something went wrong/i)
  })
})
