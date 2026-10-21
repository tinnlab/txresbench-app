// TEST-A9 [acceptance] — **AN UNDECLARED-ALIGNMENT ARTIFACT IS OFFERED, AND NOTHING TELLS THE
// USER ABOUT IT.**
//
// ── what this file used to assert, and why it inverted (owner, ledger #28 + #29) ──────────────
//
// It was the INV-9 spec: *"an unverified assumption travels as far as the code can carry it. If a
// plot's colouring or coordinates rest on an A3 artifact, the fact is carried in the picker, the
// plot chrome and the legend — three surfaces that exist today."* Its whole point was the word
// SIMULTANEOUSLY: three green unit tests are exactly what a build shows on the day the emit path
// stops forwarding the note, so only a spec driving the real chain and reading all three at once
// could see it.
//
// The owner retired the rule, in two messages:
//
//   #28  *"remove the 'Alignment not declared — these coordinates may not line up with the
//        anchored rows. Plots made from them carry the mark.' warning please"*
//   #29  *"remove the alignment not declared in the plot too"*
//
// The first took the section alert; the second took the mark the emitted plot carried, which is
// the plot-chrome and legend legs. Together there is no surface left for the fact to be carried
// ON, so INV-9's *"three surfaces at once"* has no subjects.
//
// ── why the file is REWRITTEN and not deleted ─────────────────────────────────────────────────
//
// Because the half of DEC-11 the owner did NOT withdraw is the half that is easy to lose by
// accident. *"Unknown alignment is OFFERED but marked"* had two clauses; only the second went.
// The obvious wrong reading of "remove the alignment not declared" — and the one a fix would
// reach for first — is to stop OFFERING the undeclared artifact, or to refuse its ▶, or to draw
// a picture from it that silently falls back to something else. Every one of those would be
// invisible to a unit test of a resolver that no longer has the field.
//
// So each test below keeps its fixture, keeps its journey, and inverts its assertion: the
// candidate is offered, it is choosable, its ▶ draws a real picture with real points, and no
// surface anywhere on the page says a word about alignment. The two fixtures are kept for the
// same reason they were built — a MIXED offer and an ALL-undeclared one are different states,
// and a spec that seeded one would prove half of it.

import { expect, test, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import {
  ANCHORED_COORDINATE,
  ANCHORED_KEY_DIGEST,
  ANCHORED_ROWS,
  CATEGORICAL_COLUMN,
  canvasPanesFull,
  categoricalColumn,
  coordinateEmits,
  openVisualize,
  seedAnchoredProject,
} from './_visualize'
import { DT, zarrEmbeddingArtifact } from '../14-declarative-qc/_fixtures'
import type { SeedArtifactSpec } from '../14-declarative-qc/_seed'

/**
 * A second set of positions that DOES declare alignment to the anchored row space — so the frame
 * offer is MIXED and the picker must distinguish the two rather than mark both.
 *
 * It lives in this spec rather than in `_visualize.ts` on the house rule the domain baseline
 * states: a SHARED HELPER may not carry a domain token, because one token in a helper is a token
 * in every spec that imports it. A positions fixture has to name a datatype, so it stays with the
 * one spec that needs it.
 */
function alignedCoordinates(outputId: string, label: string): SeedArtifactSpec {
  const positions = zarrEmbeddingArtifact(ANCHORED_ROWS)
  return {
    output_id: outputId,
    datatype: DT.embedding,
    scope: 'dataset',
    structure: { ...positions.structure, aligned_to: ANCHORED_KEY_DIGEST },
    meta: { name: label, title: label },
    content: { encoding: 'members', members: positions.members },
  }
}

/** The words the retired mark was spelled in. It is kept as a constant, and every assertion
 *  below counts it to ZERO: the app no longer exports the string, so a spec that stopped naming
 *  it could not tell "the mark is gone" from "I stopped looking". Matched case-insensitively
 *  against the whole PANE rather than against a testid, because a mark that came back on a
 *  different element would still be the thing the owner asked to remove — and against the pane
 *  rather than the whole page because an unrelated surface renders a manifest KEY named
 *  `alignment` (see the scope note in `pane-legibility.spec.ts`). */
const MARK = /alignment/i

/** The label of the frame this fixture declares ALIGNED. The other frame — the shared plottable
 *  seed's positions — declares no alignment, which is what makes it the A3 candidate; it is
 *  identified by the mark rather than by a label, because the mark is the thing under test. */
const ALIGNED_FRAME_LABEL = 'aligned positions'

/**
 * § Coordinates' picker, addressed by the CONTROL'S OWN STABLE TESTID.
 *
 * It used to be `getByRole('radiogroup', { name: 'Coordinates' })`. That broke when the offer
 * learned to group by source dataset: each group is its own radiogroup, Playwright matches an
 * accessible name as a case-insensitive SUBSTRING, and every group therefore answered to
 * "Coordinates" — a strict-mode violation on three tests at once. The control now carries ONE
 * name (on the group box that holds the per-dataset radiogroups) and ONE testid, and
 * `artifactRefWidget.test.tsx`'s addressing invariant pins BOTH across every offer shape.
 * Addressing it by the testid is the shape-independent way, which is the point of that testid.
 */
const coordinatesGroup = (page: Page) => page.getByTestId('widget-coordinatePicker-radio')
/** The ▶ of a named colour-by row — named for its ROW (ITEM-30). */
const plotButton = (page: Page, column: string) =>
  page.getByRole('button', { name: `Plot ${column}`, exact: true })
// BOTH surfaces are addressed by ONE attribute, `data-provenance-note`, and told apart by the
// element the host renders them on: the chrome is a text span, the legend is a 2D canvas (it is
// DRAWN, so the attribute is its only DOM witness — the drawn geometry stays asserted in
// `legendRender.test.ts`). One spelling for one fact is the point: a reader that had to know two
// different testids to check "both at once" would be one rename away from checking neither.
/** The plot-CHROME leg: a persistent line under the pane's title, for as long as it is open. */
const chromeNotes = (page: Page) => page.locator('span[data-provenance-note]')
/** The LEGEND leg — the one that survives a screenshot. */
const legendNotes = (page: Page) => page.locator('canvas[data-provenance-note]')

test.describe('undeclared alignment is OFFERED, and never told about (ledger #28 + #29)', () => {
  test('a MIXED offer OFFERS the undeclared frame, draws from it, and says nothing about it', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-a3-mixed ${Date.now()}`)
    await seedAnchoredProject(request, projectId, [
      // The second frame — ALIGNED, so the offer is mixed and the picker has something to
      // distinguish.
      alignedCoordinates('positions-aligned', ALIGNED_FRAME_LABEL),
      // The categorical colouring. Continuous columns render a visual map; only a categorical one
      // renders a LEGEND, which is the leg that survives a screenshot.
      categoricalColumn('cat-col', CATEGORICAL_COLUMN),
      // `declaredFrame: false` — the fixture's OWN frame carries no `aligned_to`, so this offer
      // genuinely holds an A3 candidate beside the A1 one, which is what "MIXED" means.
      //
      // With the DEFAULT (declared) frame there was no A3 candidate that could still derive its
      // rows: the only undeclared option left was the shared plottable seed's positions, which
      // sit in a dataset with no key artifact at all — so choosing them derives no rows and the
      // colouring the later legs need is correctly absent. Rung 2 is what makes this work: no
      // `aligned_to`, and the rows still resolve from the dataset + declared axis label.
    ], undefined, { declaredFrame: false })
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // ── THE OFFER — the clause the owner did NOT withdraw ────────────────────────────────
    const group = coordinatesGroup(page)
    await expect(group).toBeVisible({ timeout: 30_000 })
    const options = group.getByRole('radio')
    // THREE: the fixture's own frame (declaration withheld), this test's aligned extra, and the
    // shared plottable seed's undeclared positions. One of them is aligned and two are not, and
    // ALL THREE are offered — which is the whole of what survives DEC-11.
    await expect(options).toHaveCount(3, { timeout: 30_000 })
    const alignedOption = group.getByRole('radio', { name: new RegExp(ALIGNED_FRAME_LABEL, 'i') })
    await expect(alignedOption).toHaveCount(1)

    // Choose the UNDECLARED frame. It is offered, not hidden, and it is choosable — the two
    // things a fix that "removed the alignment not declared" too enthusiastically would take.
    const undeclaredFrame = group.getByRole('radio', { name: new RegExp(ANCHORED_COORDINATE, 'i') })
    await expect(undeclaredFrame).toHaveCount(1)
    await undeclaredFrame.click()
    await expect(coordinateEmits(page).first()).toBeVisible({ timeout: 30_000 })

    // ── IT DRAWS A REAL PICTURE ──────────────────────────────────────────────────────────
    //
    // Read from the app's own pane seam and asserted on ROWS, not on pane count: a pane with
    // zero rows is exactly what "the frame was quietly refused" looks like from the outside,
    // and it is the failure the owner reported once already (ledger #21).
    const play = plotButton(page, CATEGORICAL_COLUMN)
    await expect(play).toHaveCount(1, { timeout: 30_000 })
    await play.click()
    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 60_000 }).toBe(1)
    await expect.poll(async () => (await canvasPanesFull(page))[0]?.rows ?? null, { timeout: 60_000 }).toBe(
      ANCHORED_ROWS,
    )

    // ── AND NOTHING TELLS THE USER ABOUT ALIGNMENT ───────────────────────────────────────
    //
    // All three former surfaces in ONE poll, exactly as the original asserted them together —
    // the claim has inverted, not weakened. The page-wide text count is the fourth: a mark that
    // moved to a new element would still be the thing the owner asked to remove.
    await expect
      .poll(
        async () => ({
          pane: await page.getByTestId('section-stack-visualize').getByText(MARK).count(),
          chrome: await chromeNotes(page).count(),
          legend: await legendNotes(page).count(),
        }),
        { timeout: 60_000 },
      )
      .toEqual({ pane: 0, chrome: 0, legend: 0 })

    // …and it stays silent through a RE-RENDER. A second emit re-resolves every pane, which is
    // where a mark stamped once at click time would reappear (or, before, vanish).
    await play.click()
    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 60_000 }).toBe(2)
    await expect
      .poll(
        async () => ({
          pane: await page.getByTestId('section-stack-visualize').getByText(MARK).count(),
          chrome: await chromeNotes(page).count(),
          legend: await legendNotes(page).count(),
        }),
        { timeout: 60_000 },
      )
      .toEqual({ pane: 0, chrome: 0, legend: 0 })
  })

  test('an ALL-undeclared offer is offered whole, and the pane says nothing at all', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-a3-all ${Date.now()}`)
    // No aligned frame this time — the default state of a real project. The column is unaligned
    // too, so § Colour by's own aggregate arm is in the same state.
    await seedAnchoredProject(request, projectId, [
      categoricalColumn('cat-col', CATEGORICAL_COLUMN, { aligned: false }),
      // `declaredFrame: false` — WITHOUT it this fixture is not all-A3 at all. The default
      // frame declares its alignment, which would put an ALIGNED candidate in an offer whose
      // entire premise is that none is, and the test would then be asserting the opposite of
      // its own name. The rows are still derived (rung 2: same dataset, same declared axis
      // label, no `aligned_to` needed), so the pane stays usable and every candidate is A3.
    ], undefined, { declaredFrame: false })
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    const group = coordinatesGroup(page)
    await expect(group).toBeVisible({ timeout: 30_000 })
    // TWO, and BOTH undeclared: this fixture's own frame (declaration withheld) and the shared
    // plottable seed's positions. That is what "all-A3" means here.
    await expect(group.getByRole('radio')).toHaveCount(2, { timeout: 30_000 })

    // ── NOTHING IS MARKED, AND NOTHING IS SAID (owner, ledger #28 + #29) ────────────────
    //
    // This test has been rewritten twice and the direction is the record. It first REQUIRED the
    // control to state the all-undeclared fact once in its own prose. That prose was deleted
    // when the pane turned out to be saying the same sentence in three places, and the
    // assertion became "the control says it nowhere, the pane says it exactly once". The owner
    // has now removed the one — so it is ZERO, asserted over the whole rendered pane rather
    // than over any surface, because the previous two rewrites both moved the sentence rather
    // than removing it and a per-surface count would have passed through either move.
    await expect(page.getByTestId('section-stack-visualize').getByText(MARK)).toHaveCount(0)
    await expect(coordinatesGroup(page).getByText(MARK)).toHaveCount(0)

    // The POSITIVE CONTROL, and it carries the whole weight now that the marks are gone: this
    // project's frames really are undeclared, and an explicit pick still yields a working pane
    // with a real picture in it. Without it, "nothing says anything about alignment" is also
    // satisfied by a pane that offered nothing and drew nothing.
    await group.getByRole('radio').first().click()
    await expect(coordinateEmits(page).first()).toBeVisible({ timeout: 30_000 })
    const play = plotButton(page, CATEGORICAL_COLUMN)
    await expect(play).toHaveCount(1, { timeout: 30_000 })
    await play.click()
    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 60_000 }).toBe(1)
    await expect.poll(async () => (await canvasPanesFull(page))[0]?.rows ?? null, { timeout: 60_000 }).toBe(
      ANCHORED_ROWS,
    )
    // …drawn from an artifact nobody declared an alignment for, and still silent about it, on
    // every surface the mark ever reached.
    await expect
      .poll(
        async () => ({
          pane: await page.getByTestId('section-stack-visualize').getByText(MARK).count(),
          chrome: await chromeNotes(page).count(),
          legend: await legendNotes(page).count(),
        }),
        { timeout: 60_000 },
      )
      .toEqual({ pane: 0, chrome: 0, legend: 0 })
  })

  test('an ALIGNED frame and column also carry no mark — the control that is now a constant', async ({ page, request }) => {
    // It used to be the NEGATIVE control: without it, every assertion above was satisfied by an
    // app that marked unconditionally. With the marks retired it proves something weaker but
    // still worth having — that the aligned path draws the same picture the undeclared one
    // does, so the two are genuinely one path now rather than two that happen to agree.
    const projectId = await createProject(request, `visualize-a3-clean ${Date.now()}`)
    await seedAnchoredProject(request, projectId, [
      alignedCoordinates('positions-aligned', ALIGNED_FRAME_LABEL),
      categoricalColumn('cat-col', CATEGORICAL_COLUMN),
    ])
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    const group = coordinatesGroup(page)
    await expect(group).toBeVisible({ timeout: 30_000 })
    await group.getByRole('radio', { name: new RegExp(ALIGNED_FRAME_LABEL, 'i') }).click()
    // Ledger #27 — the frame's ▶ is on the coordinate ROW now, one per set; the single
    // foot-of-card control this used to address no longer exists.
    await expect(coordinateEmits(page).first()).toBeVisible({ timeout: 30_000 })

    const play = plotButton(page, CATEGORICAL_COLUMN)
    await expect(play).toHaveCount(1, { timeout: 30_000 })
    await play.click()
    // The picture exists — read from the app's own pane seam rather than a title testid, so the
    // negative below cannot pass merely because nothing rendered.
    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 60_000 }).toBe(1)
    // …and carries no mark on either surface, because there is no unverified assumption in it.
    await expect(chromeNotes(page)).toHaveCount(0)
    await expect(legendNotes(page)).toHaveCount(0)
    expect(ANCHORED_ROWS).toBeGreaterThan(0) // the fixture's row space is real
  })
})
