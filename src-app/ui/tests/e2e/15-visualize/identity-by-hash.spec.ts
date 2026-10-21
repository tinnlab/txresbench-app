// TEST-A1 [acceptance, INV-1] (visualize-pane ITEM-10 / ITEM-12) — **AN IDENTITY IS NOT A NAME.**
//
// INV-1, quoted (R10, §8.0 — the design's lead rule): *"Nothing resolves a column, a coordinate
// set, an axis, an artifact or an entry by display name. Identity is `(artifact, selector)`. A
// picker may SHOW a name; nothing may KEY on one."*
//
// ── WHAT THIS SPEC USED TO DRIVE, AND WHY IT NOW DRIVES § COORDINATES ─────────────────────────
//
// This spec used to reach its subject through the pane's first block: a control asking WHICH
// ROWS, over two same-labelled row spaces, which it anchored and then renamed underneath. The
// owner deleted that control on 2026-08-13 — *"there is no such thing as a row space"* — so the
// gesture is gone. The PROPERTY is not: identity is the content hash, not the displayed name, and
// renaming a dataset must not move what is chosen or what an open picture plots.
//
// It survives in § Coordinates, which is now the pane's first block and lists PROJECT-WIDE: two
// coordinate sets from two source datasets, carrying the SAME producer-declared name, told apart
// only by their GROUP HEADING (the dataset) and their coverage (their row count). The heading is
// a display string and it is exactly what the rename moves — which makes this fixture a better
// instrument for INV-1 than the old one, not a weaker one: the name under test is now the only
// thing separating two otherwise identical options.
//
// ── why this spec, when every leg is unit-covered ─────────────────────────────────────────────
//
// `axisSource.test.ts` proves a `$`-ref resolving to `null` does not take a same-named
// substitute, and `candidateGroups.test.ts` proves two datasets sharing a name stay separate
// groups. Both are true of pure functions over a hand-built catalog, and both stay green under
// the failure this rule exists to prevent — because that failure is not in either function. It is
// the possibility that SOMETHING between the picker and the pixels carries a name forward: a
// title, a cache key, a dataset identity, a re-resolve on catalog change. The only way to see it
// is to change a NAME on a live project, with a picture already on screen, and watch what the
// picture does.
//
// So the subject is a RENAME. It is done through the shipped affordance (`Dataset.rename`), which
// publishes `Dataset`/`Update`; the workbench turns that into a live catalog re-read, so the pane
// relabels itself WITHOUT a reload — and a reload would have destroyed the very thing under test,
// since "an already-open pane" cannot survive one.
//
// ── the fixture ───────────────────────────────────────────────────────────────────────────────
//
// TWO populations, each its own dataset, each publishing its own rows, ONE 2-D coordinate set
// under the same declared name, and a column of the SAME name. By name alone nothing in this
// project is distinguishable. They differ only where identity is allowed to live: the key
// sequence (hence the `content_hash`), the provenance, and the LENGTH.
//
// It is seeded HERE rather than through `_visualize.ts`'s `seedPopulations` for one reason: this
// spec has to RENAME one of the datasets, so it needs the ids back, and the shared helper returns
// none. The plan is otherwise the same three declarations per population.

import { expect, test, type APIRequestContext } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import { DT, DT_POSITIONS, ENTITY_AXIS, entityColumnArtifact, positionsArtifact } from '../14-declarative-qc/_fixtures'
import {
  SECTIONS,
  canvasPanesFull,
  coordinateEmits,
  openVisualize,
  renameDataset,
} from './_visualize'

const ORIGINAL_NAME = 'alpha-provenance'
const OTHER_NAME = 'beta-provenance'
const RENAMED = 'renamed-in-place'

/** The two lengths. UNEQUAL on purpose: the length is the column that proves two same-labelled
 *  options are different things (§7.5.2), and it is the one number that tells the two open
 *  pictures apart afterwards. */
const ROWS_A = 60
const ROWS_B = 40
/** The declared display name BOTH coordinate sets carry, and the column name BOTH populations
 *  carry. Contested on purpose: a name must fetch nothing. */
const SHARED_COORDINATE = 'projection'
const SHARED_COLUMN = 'metric one'

/** Seed one population — its rows, one 2-D coordinate set aligned to them, one column aligned to
 *  them — and hand back the dataset id, which is what the rename needs. */
async function seedPopulation(
  request: APIRequestContext,
  projectId: string,
  name: string,
  rows: number,
  digest: string,
): Promise<string> {
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const column = entityColumnArtifact(SHARED_COLUMN, Array.from({ length: rows }, (_, k) => k % 10), ENTITY_AXIS)
  const positions = positionsArtifact(rows)
  const seeded = await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'keys',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'positions',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...positions.structure, aligned_to: digest },
        meta: { name: SHARED_COORDINATE },
        content: { encoding: 'members', members: positions.members },
      },
      {
        output_id: 'column',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...column.structure, aligned_to: digest },
        meta: { ...column.meta, kind: 'continuous', min: 0, max: 9, n: rows },
        content: { encoding: 'members', members: column.members },
      },
    ],
  })
  return seeded.dataset_id as string
}

test.describe('identity is (artifact, selector), never a name (INV-1)', () => {
  test('renaming a label in place moves no choice and does not change what an open pane plots', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-identity ${Date.now()}`)
    const chosenDatasetId = await seedPopulation(request, projectId, ORIGINAL_NAME, ROWS_A, 'e2e-identity-a')
    await seedPopulation(request, projectId, OTHER_NAME, ROWS_B, 'e2e-identity-b')
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // ── THE OFFER: two options a NAME cannot tell apart ──────────────────────────────────
    const coordinates = page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
    await expect(coordinates).toBeVisible({ timeout: 30_000 })
    const options = coordinates.getByRole('radio')
    // REWRITTEN (ledger #24): the pane opens with the FIRST set selected — visibly, marked
    // `auto`, and changeable. What this spec is about is untouched and is asserted below: the
    // two options are told apart by IDENTITY, never by their (identical) declared name, so the
    // selection must survive a rename of the dataset heading and must not migrate to the option
    // that happens to read most like the old one.
    await expect(options).toHaveCount(2, { timeout: 30_000 })
    await expect(options.first()).toBeChecked({ timeout: 30_000 })
    await expect(options.nth(1)).not.toBeChecked()
    // Their DECLARED names are identical, which is what makes the heading load-bearing.
    for (let i = 0; i < 2; i++) {
      await expect(options.nth(i)).toHaveAccessibleName(new RegExp(SHARED_COORDINATE, 'i'))
    }

    // ── THE GROUP HEADINGS ARE WHAT SEPARATE THEM ───────────────────────────────────────
    //
    // One `RadioGroup` per source dataset, each named `<control> — <dataset>`, so the heading
    // reaches a sighted reader and a screen-reader user as one fact. Addressed through the
    // ACCESSIBLE NAME rather than through `widget-coordinatePicker-group-<i>`: the index is the
    // order candidates happened to arrive in, and keying on it would be this spec resolving a
    // group by position — one bad habit away from resolving it by name.
    const headings = coordinates.getByTestId(/widget-coordinatePicker-group-/)
    await expect(headings).toHaveCount(2, { timeout: 30_000 })
    // THE GROUP IS NAMED BY ITS DATASET ALONE (owner, 2026-08-13). Each per-dataset radiogroup
    // used to be called `Coordinates — <dataset>`, which made EVERY group answer to the
    // control's name and broke three specs on a strict-mode violation. The control's name now
    // lives once, on the group box that holds them, and the nesting carries what the
    // concatenated string was reaching for — which is also what a screen reader announces.
    const chosenGroup = page.getByRole('radiogroup', { name: ORIGINAL_NAME })
    const otherGroup = page.getByRole('radiogroup', { name: OTHER_NAME })
    await expect(chosenGroup).toBeVisible({ timeout: 30_000 })
    await expect(otherGroup).toBeVisible()
    // …and each holds exactly one option, of its own length — the declared fact that proves the
    // two headings are over two different things and not two names for one.
    await expect(chosenGroup.getByRole('radio')).toHaveCount(1)
    await expect(chosenGroup.getByRole('radio')).toHaveAccessibleName(
      new RegExp(`\\b${ROWS_A.toLocaleString()}\\b`),
    )
    await expect(otherGroup.getByRole('radio')).toHaveAccessibleName(
      new RegExp(`\\b${ROWS_B.toLocaleString()}\\b`),
    )

    // ── CHOOSE ONE, and see the OTHER's same-named column stay out of the offer ──────────
    await chosenGroup.getByRole('radio').click()
    await expect(chosenGroup.getByRole('radio')).toBeChecked({ timeout: 30_000 })
    // Ledger #27 — the frame's ▶ is on the coordinate ROW now, one per set; the single
    // foot-of-card control this used to address no longer exists.
    await expect(coordinateEmits(page).first()).toBeVisible({ timeout: 30_000 })

    // EXACTLY ONE row by the CONTESTED name is offered, though the project holds two columns
    // carrying it. The other belongs to a population that was not chosen, and a name did not
    // fetch it. This is also the proof that `$scope.axis` was DERIVED from the coordinate set.
    const play = page.getByRole('button', { name: `Plot ${SHARED_COLUMN}`, exact: true })
    await expect(play).toHaveCount(1, { timeout: 30_000 })

    // ── THE OPEN PANE ───────────────────────────────────────────────────────────────────
    await play.click()
    await expect.poll(async () => (await canvasPanesFull(page)).length, { timeout: 60_000 }).toBe(1)
    // Wait for the pane to actually RESOLVE — `rows: null` means "not resolved yet", and a
    // before/after comparison of two unresolved panes would compare nothing.
    await expect.poll(async () => (await canvasPanesFull(page))[0]?.rows ?? null, { timeout: 60_000 }).toBe(
      ROWS_A,
    )
    const before = (await canvasPanesFull(page))[0]
    expect(before.datasetKey, 'the pane binds no dataset identity').toBeTruthy()
    // NOT `bindings`, and the reason is recorded rather than left as a silent omission: the seam's
    // `resolvedPaneBindings` stays `null` for this pane under a headless WebGL2 context (it is
    // viz's answer AFTER a mounted chart overlays its catalog defaults, and no chart mounts where
    // nothing paints). Polling it for 60s never resolved. Asserting a field that is `null` on both
    // sides would be the empty comparison — so the identity is compared through the three fields
    // that DO resolve here (`datasetKey`, `rows`, `id`), each of which would move if a name had
    // been the key: the viz dataset identity a pane is filed under, its row count — which is the
    // one number that tells the two contested populations apart — and the pane's own id.
    // The title SHOWS the name — that is allowed, and it is what makes the rename observable.
    expect(before.title).toContain(ORIGINAL_NAME)
    expect(before.title).toContain(SHARED_COLUMN)

    // ── RENAME THE LABEL, IN PLACE ──────────────────────────────────────────────────────
    await renameDataset(request, chosenDatasetId, RENAMED)

    // POSITIVE CONTROL, and it must come first: the rename really did reach this page, live. A
    // test whose "nothing changed" passes because nothing HAPPENED is the vacuous form of this
    // assertion, and it is the easy one to write by accident.
    const renamedGroup = page.getByRole('radiogroup', { name: RENAMED })
    await expect(renamedGroup).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('radiogroup', { name: ORIGINAL_NAME })).toHaveCount(0)

    // ── WHICH ONE IS CHOSEN: UNCHANGED ──────────────────────────────────────────────────
    //
    // The heading moved; the selection did not follow it. The chosen option is still the one
    // under the renamed group — and still the one whose coverage is this population's length —
    // while the other population's same-named option is still unchosen. A picker keying on a
    // display string would have dropped the selection here (the value it matched is gone) or
    // moved it to the option that now reads most like the old one.
    await expect(renamedGroup.getByRole('radio')).toBeChecked()
    await expect(renamedGroup.getByRole('radio')).toHaveAccessibleName(
      new RegExp(`\\b${ROWS_A.toLocaleString()}\\b`),
    )
    await expect(otherGroup.getByRole('radio')).not.toBeChecked()
    await expect(coordinates.getByRole('radio')).toHaveCount(2)

    // ── WHAT THE OPEN PANE PLOTS: UNCHANGED ─────────────────────────────────────────────
    //
    // Not "the pane is still there" — the pane count would survive a pane silently re-resolving
    // onto the other population. What is compared is the identity the grid renders FROM: the viz
    // dataset key it is filed under and the row count. Both are downstream of
    // `(artifact, selector)`; either would move if a name had been the key anywhere in the chain.
    // And the OFFER is re-checked below: after the rename the pane must still list exactly ONE
    // column by the contested name.
    const after = (await canvasPanesFull(page))[0]
    expect(after.datasetKey).toBe(before.datasetKey)
    expect(after.rows).toBe(before.rows)
    expect(after.id).toBe(before.id)
    // …and specifically NOT the other population, whose column carries the same name.
    expect(after.rows).not.toBe(ROWS_B)

    // The pane is still exactly one pane — a re-resolve that appended or replaced would show here.
    expect(await canvasPanesFull(page)).toHaveLength(1)

    // Pressing ▶ again still plots the SAME thing under the new label: the offer re-resolved
    // through the renamed catalog and landed on the same artifact — and it is still exactly ONE
    // row by that name, so the rename did not make the other population's same-named column
    // resolvable.
    const playAgain = page.getByRole('button', { name: `Plot ${SHARED_COLUMN}`, exact: true })
    await expect(playAgain).toHaveCount(1)

    // ── WHY THIS IS AN EMIT-POLL AND NOT A CLICK-THEN-ASSERT ────────────────────────────
    //
    // A pane is born with the frame it was born in and KEEPS it (ITEM-57), so the title of an
    // already-emitted pane never catches up — the only way to observe the section's re-resolved
    // frame is to EMIT again and read the new pane. And the picker relabelling (asserted above)
    // does NOT imply the section has: they are separate consumers of the same catalog epoch,
    // re-resolving independently. Asserting on a single click therefore races the section's own
    // slice — it passed twice and then failed on the third run, which is exactly the shape of a
    // latent race rather than a behaviour change.
    //
    // So the claim is stated as what it actually is — *eventually* a NEWLY born pane carries the
    // new label — and the poll emits to observe it. Pane count is not asserted afterwards,
    // because the number of emits is now a function of how fast the epoch propagated.
    await expect
      .poll(
        async () => {
          const panes = await canvasPanesFull(page)
          const newest = panes[panes.length - 1]
          if (newest && newest.title?.includes(RENAMED)) return newest.title
          await playAgain.click()
          return (await canvasPanesFull(page))[(await canvasPanesFull(page)).length - 1]?.title ?? ''
        },
        { timeout: 60_000, intervals: [500, 1000, 2000, 3000] },
      )
      .toContain(RENAMED)

    // Every pane on the canvas plots the CHOSEN population — the rename moved a label and not
    // one binding. This is the clause that would break if a re-resolve had drifted onto the other
    // population, whose column carries the same name and whose length differs.
    for (const pane of await canvasPanesFull(page)) {
      expect(pane.rows === null || pane.rows === ROWS_A, `pane ${pane.id} plots ${pane.rows} rows`).toBe(true)
    }
    // The FIRST pane still reads the name it was born with (ITEM-57) — two display strings over
    // one identity, which is exactly the separation INV-1 asserts.
    expect((await canvasPanesFull(page))[0].title).toContain(ORIGINAL_NAME)
  })
})
