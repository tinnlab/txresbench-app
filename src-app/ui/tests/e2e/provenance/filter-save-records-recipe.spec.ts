import { expect, test, type APIRequestContext } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  awaitFilterSurface,
  addCriterion,
  CFRow,
  runQcToCompletion,
  seedRunnableExpression,
  CF,
} from '../14-declarative-qc/_seed'

import { BACKEND, ownerToken } from './_helpers'

/** The criterion this spec filters on — a column the upstream run really produces on the
 *  matrix's own axis, not a fixture name. Named once: it is asserted twice below (the
 *  recipe, and the lineage detail), and two literals is two chances to update one. */
const FILTER_COLUMN = 'total_counts'

// TEST-26 (e2e) [acceptance] [invariant: INV-8] [covers: ITEM-13]
//
// **This spec was enumerated in TESTS.md, credited to ITEM-13, counted in "e2e 2"
// — and did not exist** (FINDING 6). Its absence mattered more than a missing
// test usually does: TEST-25, the integration test wearing INV-8's `[acceptance]`
// label, POSTs `/provenance/selections` DIRECTLY. Everything ABOVE that POST —
// `runBtn` → `cf.run` → `run_processor` → `wait_for` → `call_action
// provenance.record-selection` → `Stores.Provenance.recordCapture` — was
// unexercised by ANY test, so a save path that never fires (or fires with the
// wrong `input_artifact_id`, or under an action type whose emitter rejects the
// recipe) left the whole suite green. INV-8 is discharged HERE, not there.
//
// Drives the REAL app against the REAL backend — no `page.route()` mocking. The
// commit is a genuine `cell.filter` sandbox run, so the spec needs a
// sandbox-executable host (bwrap + a staged analysis rootfs).
//
// HOST-CAPABILITY GATE — the `@acceptance` TAG in the first test's title. It needs a
// sandbox-executable host (bwrap + a staged analysis rootfs) to commit a genuine
// `cell.filter` run, so `playwright.config.ts` excludes that tag from a DEFAULT run via
// `grepInvert`, and `just verify-acceptance` positively selects it (`--grep @acceptance`,
// with TXR_E2E_REAL_COMPUTE=1 dropping the exclusion).
//
// Two earlier levers, kept on the record because the reasoning is load-bearing:
//
//  - R3-114: a file-level `testIgnore` removed this spec from COLLECTION, which is
//    undetectable in the run output — worker E measured 224 tests collected by default vs
//    241 with `TXR_E2E_REAL_COMPUTE=1`, and nothing in the repo set the flag, so this
//    file (the plan's own `[acceptance][INV-8]` spec and the ONLY test exercising the
//    frontend save path) had never run in any gate while the run still read green. Its
//    rationale — "an in-body skip reports ok having executed nothing" — is true of Rust
//    libtest but NOT of Playwright, whose conditional skip is reported as SKIPPED with its
//    reason and is never counted as passed. So `testIgnore` was the WRONG lever.
//  - Round 4 therefore used an in-body conditional skip. Honest in the output, but it left
//    the ACCEPTANCE host able to self-exempt, and hid the condition inside the spec.
//
// The tag beats both: the exclusion is in the config + the invocation (one greppable
// place), this test cannot opt out where it matters, and an empty selection cannot read as
// green — `verify-acceptance` parses its JUnit report fail-closed and fails on tests == 0.

/** The project's recorded provenance runs, straight off the REST surface the UI reads. */
async function runsOf(request: APIRequestContext, admin: string, projectId: string) {
  const r = await request.get(
    `${BACKEND}/api/provenance/runs?project_id=${projectId}&per_page=50`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(r.ok(), `list runs -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return (await r.json()).runs as Array<Record<string, unknown>>
}

test.describe('committing a filter records a durable, replayable recipe (TEST-26 / INV-8)', () => {
  test('the SAVE path reaches the capture chokepoint and persists a criteria-specific code_sha256 @acceptance', async ({
    page,
    request,
  }) => {
    // A real import (the seed) plus a real `cell.filter` run, and the toast below is waited on
    // for 180 s — well past the config's 120 s per-test budget, so without this the test died
    // before its own expect could fire. (`seedRunnableExpression` adds its import budget on top.)
    test.setTimeout(300_000)

    const admin = await ownerToken(request)
    await loginAsOwner(page)
    const projectId = await createProject(request, `Filter Save Provenance ${Date.now()}`)
    // The commit is a GENUINE `cell.filter` run, and `cell-filter.py::read_matrix` refuses any
    // `expression` input that does not DECLARE `kind: "sparse_csc"` in its group `zarr.json` —
    // so the sole `single-cell/expression` must be a genuinely imported CSC store, not
    // `seed-qc`'s opaque JSON placeholder (and not raw `.h5ad` bytes: the retired claim here was
    // that this script does `ad.read_h5ad(...)`, which it has not for some time).
    //
    // THE SEEDING THIS REPLACES, and why it could not work. It was
    // `seedQcDataset({ annotated: true, expression: false })` + `seedRunnableExpression`: opt the
    // obs seed out of supplying a matrix, and let the import supply it, so the slot still sees
    // EXACTLY ONE candidate. Sound while the criteria builder read a project-wide report
    // artifact. `c6a2e01a` moved it to the AXIS of the CHOSEN dataset, and `siblingsOnAxis`
    // deliberately refuses to fall back to project-wide (it would offer columns belonging to a
    // different dataset). The two seeds are two DATASETS by construction — a `qc-seed-*` holding
    // the obs and the import holding the matrix — so under the axis relation the chosen matrix
    // has no columns and the criterion picker is disabled, no matter how obs-aligned the row
    // counts are. `nCells: TINY_COUNTS_CELLS` was buying alignment that stopped being the
    // question.
    //
    // So the columns are PRODUCED on the matrix's own axis, by really running the upstream
    // analysis over it — which is also the honest frame for a spec about recording what a
    // filter was built from. Same shape as the sibling that survived `c6a2e01a` because it
    // was in a tier that runs (the live commit-outcome spec in `14-declarative-qc/`).
    await seedRunnableExpression(request, projectId, 'Filter save matrix')
    await openWorkbench(page, projectId)
    await runQcToCompletion(page)

    // Nothing FILTER-related recorded yet — the delta below is attributable to THIS commit.
    // Taken AFTER the upstream run on purpose: that run records provenance of its own, and a
    // baseline read before it would fold it into the delta this test attributes to the save path.
    const before = await runsOf(request, admin, projectId)

    await awaitFilterSurface(page)

    // Build a real, CONSTRAINING criterion through the declarative surface (a
    // continuous column yields the min/max controls), then commit.
    //
    // `FILTER_COLUMN` is what the upstream run actually EMITS, and the column the sibling spec
    // asserts is offered. The name this replaced was a seed-fixture one; it survives only as a
    // compute-side entry in `METRIC_ALIASES`, which resolves it back to this column — so it is
    // not a name any picker offers. `min` rather than the old `max: 100000`: the sibling
    // calibrates 42 to keep a strict subset of this same fixture, where a ceiling that high
    // keeps everything and the criterion would constrain nothing.
    await addCriterion(page, 0, { column: FILTER_COLUMN })
    await page.getByTestId(CFRow.min(0)).fill('42')
    await page.getByTestId(CFRow.min(0)).blur()
    await page.getByTestId(CF.label).fill('lowqc')
    await page.getByRole('button', { name: 'Commit keep-mask' }).click()

    // The declared success toast — which `cf.run` reaches ONLY if the preceding
    // `call_action provenance.record-selection` did not reject (FINDING 8).
    await expect(page.getByText('Keep-mask committed', { exact: false })).toBeVisible({
      timeout: 180_000,
    })

    // ── the acceptance assertion: a SELECTION run was recorded by the chokepoint ──
    await expect
      .poll(async () => (await runsOf(request, admin, projectId)).length, { timeout: 60_000 })
      .toBeGreaterThan(before.length)

    const after = await runsOf(request, admin, projectId)
    const selection = after.find(
      r => String(r.generator_id) === 'provenance.selection' && !before.some(b => b.run_id === r.run_id),
    )
    expect(
      selection,
      `the SAVE path must mint a run through the capture chokepoint; got:\n${JSON.stringify(
        after.map(r => ({ kind: r.kind, generator: r.generator_id })),
        null,
        2,
      )}`,
    ).toBeTruthy()

    // 1. it carries a REAL, criteria-specific code hash (not a placeholder script).
    const sha = String(selection!.code_sha256 ?? '')
    expect(sha, 'the recorded selection carries an emitted code blob').toMatch(/^sha256:|^[0-9a-f]{64}$/)

    // 2. the run is stored under the action type whose emitter can actually reproduce a
    //    criteria list. `subset.filter` is the `action_registry` arm that reads
    //    `recipe["criteria"]` as an array and emits through `emit_criteria_script`; the
    //    `selection.column` arm this used to be posted under requires string `col`/`op`/
    //    `val` fields a criteria list does not have, so every capture answered
    //    `MalformedRecipe` and nothing was ever recorded. The run's `kind` IS the action
    //    type it was captured under, so this assertion is what pins the route + type.
    expect(
      selection!.kind,
      'the capture lands on the criteria emitter, not the flat-comparator one',
    ).toBe('subset.filter')

    // 3. the stored recipe is the run's CRITERIA — the ONE encoding of the filter, the
    //    same list the kernel filtered on — naming the column the user actually used.
    //
    //    ITEM-4: this used to assert a VERSIONED envelope (`recipe.predicate` +
    //    `recipe.dslVersion` + `recipe.inputs[].contentHash`) built by lifting the
    //    criteria into a DSL. That second encoding is deleted; a flat `{criteria}`
    //    recipe is what the chokepoint now stores.
    const recipe = (selection!.params as Record<string, unknown>)?.recipe as Record<string, unknown>
    expect(recipe, `the run stores its recipe: ${JSON.stringify(selection!.params)}`).toBeTruthy()
    expect(JSON.stringify(recipe.criteria)).toContain(FILTER_COLUMN)
    // INV-10: the action type carries "what kind of action this was" — a `kind` inside
    // the recipe would be a second encoding of the same fact, free to disagree with the
    // type the run is actually stored under.
    expect(recipe.kind, 'the recipe does not re-encode the action type').toBeUndefined()
    expect(recipe.predicate, 'no second encoding rides along').toBeUndefined()

    // 4. the `used` edge is present — the chokepoint's own signature.
    expect((selection!.inputs as unknown[]).length).toBeGreaterThan(0)

    // 5. …and the UI reflects it WITHOUT a reload (the store's `reloadCurrent()`
    //    path fires from the capture, which is the wiring TEST-25 cannot see).
    const add = page.getByTestId('region-add-pane-right')
    await add.click()
    await page.getByTestId('region-add-pane-item-reproducibility').click()
    const detail = page.getByTestId(`workbench-lineage-detail-${selection!.run_id}`)
    await expect(detail).toBeVisible({ timeout: 30_000 })
    // R3-92: `toBeVisible()` alone was the whole UI assertion — an empty detail line
    // satisfies it. The surface exists to answer "what was this run filtered on?", so
    // it must NAME the column. (If this fails, see the same diagnosis spelled out in
    // `provenance-predicate.spec.ts`: `predicateText` has no VERSIONED-recipe arm and
    // its `JSON.stringify` fallback truncates before the alphabetically-last
    // `predicate` key. The renderer is `criteriaPreview.ts` now, and its
    // recorded-selection arm reads `recipe.criteria`.)
    await expect(detail, 'the lineage detail names the filtered column').toContainText(FILTER_COLUMN)
  })

  // ITEM-4 — the NEGATIVE control that stood here is DELETED, and its deletion is the
  // point rather than a loss of coverage.
  //
  // It asserted that a CATEGORICAL keep-set — a criterion the recipe DSL could not
  // express, because `in` is a numeric membership test — must NOT render the success
  // toast, since lifting it would have recorded a predicate reproducing the EMPTY
  // selection. That whole failure mode was an artefact of the second encoding: there is
  // now nothing to lift a categorical keep-set INTO, so it records like any other
  // criterion and there is no "cannot be faithfully recorded" state left to control for.
  // The positive replacement is a unit test — `provenance/actions.test.ts`'s "records a
  // CATEGORICAL keep-set, which the DSL encoding could not express".
})
