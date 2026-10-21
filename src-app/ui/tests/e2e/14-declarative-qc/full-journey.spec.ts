import { readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BACKEND, loginAsOwner, openDatasetsPane, ownerToken } from '../project/_helpers'
import {
  findDatasetRow,
  gotoDatasets,
  singleFileTypeTitle,
  waitForTerminalProcessingStatus,
} from '../datasets/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import { awaitQcSurface, runQcToCompletion } from './_seed'
import { DT } from './_fixtures'

// ════════════════════════════════════════════════════════════════════════════════════════
//  THE ONE END-TO-END JOURNEY: real bytes in through the UI → a real run → a real result.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY THIS FILE EXISTS (what the existing layers structurally cannot catch) ────────────
//
// Every layer under this one is honest about ONE joint and blind to the seams beside it:
//
//   • `datasets/vertical-slice.spec.ts` drives the real upload wizard and watches the
//     on-ingest converter finish — then STOPS at the detail page. Nothing it asserts
//     depends on the produced artifact ever reaching a project, a picker, or a run.
//   • `artifact-picker-*.spec.ts` prove the picker populates and re-shapes — over artifacts
//     planted by the debug seed engine. A seeded artifact is a fixture's idea of one; the
//     picker could be perfectly right about a shape the real importer never writes.
//   • `declarative-processor-ui.spec.ts` and its live-loop sibling in this directory drive a
//     real run — from a HELPER-seeded input (`seedRunnableExpression`), with the input
//     auto-chosen for them, so neither the act of PICKING an input nor the path from a file
//     to a pickable one is under test.
//
// So the suite proves upload→import, and proves picker→run, and never once proves they
// meet. That seam is exactly where a defect is invisible-by-construction: an importer that
// writes a subtly different artifact than the seed engine plants still passes every
// picker spec, and still passes every run spec, because no test carries one side's OUTPUT
// into the other side's INPUT. This spec is the only one that does — the file a person
// chose is the bytes the run consumes, with no seed, no API upload, and no state-poking
// anywhere along the way.
//
// It also asserts the thing a toast cannot: what the run PRODUCED. A toast fires when the
// declared action body reaches its last step, which is equally true of a run that produced
// a full table and one that produced an empty one.
//
// ── THE GATING SPLIT, AND WHY IT FALLS WHERE IT DOES ────────────────────────────────────
//
// The on-ingest converter is ITSELF a sandbox run (the upload enqueues it; `SandboxJobRunner`
// hands it to the bwrap backend). So "upload → the import COMPLETES" is not compute-free,
// however much it looks like plumbing, and a test that asserts `Ready` on a host without
// bwrap + a staged runtime image is asserting the host, not the product.
//
// The split is therefore drawn at the point where a real compute must SUCCEED, not at the
// point where the UI stops being involved:
//
//   TEST 1 — UNGATED, in the DEFAULT run. Everything that needs no compute to be TRUE:
//     the wizard genuinely ingests the chosen file, the library lists it, the detail page
//     opens it, the import is REPORTED (a badge naming one of the four real states — the
//     honest claim; which state it reaches is the host's business), and the dataset can be
//     attached to a project through the UI and is then listed by that project. Every one of
//     those is a real product behaviour that a sandbox-less host can genuinely falsify.
//
//   TEST 2 — GATED on `CYTO_E2E_REAL_COMPUTE`, tagged `@acceptance`. Everything downstream
//     of a conversion that must actually SUCCEED: the import reaching `Ready` with a
//     populated lineage graph, the produced artifact arriving in the picker with no reload,
//     the click that chooses it, the run it launches, and the run's OUTPUT.
//
//     It carries `@acceptance` because it belongs in `just verify-acceptance`: that
//     invocation runs on a sandbox-executable host, so the test cannot self-exempt there —
//     it must PASS — and the recipe hard-fails on `skipped > 0` / `tests == 0`. Without the
//     tag a describe-skipped test is reachable by no invocation at all, which is the trap
//     `../14-workbench/_analysis.ts` measured at 16 of 17 specs.
//
// The gate is a describe-level `test.skip(!REAL_COMPUTE, …)` — collected unconditionally,
// REPORTED as skipped with the env var to set, short-circuiting before the fixtures. NEVER
// a module-level `if (REAL_COMPUTE) { … }`, which reports "1 passed" having run nothing.
//
// ── HOUSE RULES OBSERVED ────────────────────────────────────────────────────────────────
//
// No `page.route()` mocking anywhere: the real backend, driven through the real UI. Every
// helper here is the one the owning suite already exports (`datasets/_helpers` for the
// library + wizard, `_dock` for the workbench, `_seed` for the declarative surface), so a
// selector change lands in one place. Datatype ids come from `_fixtures`' `DT` table rather
// than being re-typed as literals — the same move `_seed.ts` makes, and the reason this file
// adds almost nothing to the contributed-vocabulary ratchet
// (`scripts/lint-no-domain-in-builtin.mjs`).

const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed small upload fixture. Its EXTENSION drives the wizard's type choice and the
 *  uploaded file name, so both are derived from this one path instead of being restated. */
const FIXTURE = resolve(HERE, 'fixtures/tiny_counts.h5ad')
const FIXTURE_EXT = extname(FIXTURE)
const BYTES = () => readFileSync(FIXTURE)

/** The dependent picker's sole-candidate arm. Waiting for it is NOT cosmetic: the run's
 *  default metric set contains PATTERN metrics, and the compute REFUSES a name-source list
 *  that cannot be paired one-to-one with the chosen inputs — it exits 2 with a diagnostic
 *  naming both counts. Choosing an input CLEARS that list, so a Run clicked before this
 *  picker has re-anchored fails the JOB, not the assertion, and reads as an unexplained
 *  run failure rather than as the race it is. */
const NAME_SOURCE_SUMMARY = 'widget-geneNamesPicker-summary'

/** The input picker's three arms — one per candidate cardinality (`ArtifactRefWidget`).
 *
 *  This journey is the reason `@ziee/kit`'s `MultiSelect` has `stopFromTagClose`. Its trigger
 *  fills with TAGS once something is chosen, and the tags used to swallow every gesture aimed at
 *  them (a blanket guard meant for the `×` alone) — so `picker.click()` here landed on the tag
 *  the auto-chosen first input had left behind, focused the control, and did not open it. Nothing
 *  else in the suite reached that state: every other picker spec clicks an EMPTY trigger. */
const PICKER = {
  empty: 'widget-matrixPicker-empty',
  summary: 'widget-matrixPicker-summary',
  select: 'widget-matrixPicker-select',
} as const

/** One row of `GET /api/projects/{id}/artifacts` (a flattened artifact + source-dataset fields). */
type ListedArtifact = {
  id: string
  output_id: string
  datatype: string
  source_dataset_id?: string
}

/** The project's catalogued artifacts, straight off the REST surface the workbench reads. */
async function artifactsOf(
  request: APIRequestContext,
  projectId: string,
): Promise<ListedArtifact[]> {
  const token = await ownerToken(request)
  const r = await request.get(`${BACKEND}/api/projects/${projectId}/artifacts`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(r.ok(), `list artifacts -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return (await r.json()) as ListedArtifact[]
}

/**
 * Upload ONE file through the REAL type-first wizard and return the created dataset's id.
 *
 * This is the step the whole spec exists for, so it is deliberately the LONG way round:
 * `setInputFiles` on the wizard's own revealed input, submitted by the wizard's own button.
 * No `uploadDatasetApi`, no seed plan. The upload is also what ENQUEUES the on-ingest
 * converter — there is no separate import affordance to press.
 *
 * The id is read off the detail page's URL, i.e. from where the UI actually navigated,
 * rather than from a list call that would have to re-find the row by name.
 */
async function uploadThroughWizard(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<{ id: string; name: string }> {
  const token = await ownerToken(request)
  // The wizard's option label is DERIVED from the registry for this extension — never
  // written down (a title is data, and a spec that hardcodes one breaks on a rename).
  const typeTitle = await singleFileTypeTitle(request, token, FIXTURE_EXT)

  await gotoDatasets(page)
  // One owner + one persistent DB for the whole directory, so the uploaded name is
  // uniquified — a fixed one collides across specs and across re-runs.
  const name = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${FIXTURE_EXT}`

  await page.getByTestId('datasets-upload-button').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeVisible()
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: typeTitle, exact: true }).click()
  await page
    .locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
    .setInputFiles([{ name, mimeType: 'application/octet-stream', buffer: BYTES() }])
  await page.getByTestId('dataset-upload-submit').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeHidden({ timeout: 90_000 })

  // The library row, then its own link — the route a person takes.
  const row = await findDatasetRow(page, name)
  await row.getByRole('link', { name }).click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dataset-detail-name')).toHaveText(name)

  const id = /\/datasets\/([0-9a-f-]{36})/i.exec(page.url())?.[1]
  expect(id, `the detail page URL names the created dataset (${page.url()})`).toBeTruthy()
  return { id: id as string, name }
}

/**
 * Attach the dataset whose detail page is OPEN to `projectName`, through the page's own
 * "Attach to project" affordance.
 *
 * A UI path exists, so no API shortcut is taken here. The dialog lists page 1 of the
 * owner's projects newest-first (`created_at DESC`, 50 per page) and filters CLIENT-side,
 * so the search box is filled first: the suite's shared owner accumulates projects, and
 * filtering keeps the lookup independent of how many other specs created one.
 */
async function attachFromDetailPage(
  page: Page,
  projectId: string,
  projectName: string,
): Promise<void> {
  await page.getByTestId('dataset-detail-attach').click()
  await expect(page.getByTestId('dataset-attach-dialog')).toBeVisible()
  await page.getByTestId('dataset-attach-search').fill(projectName)
  const attach = page.getByTestId(`dataset-attach-project-${projectId}`)
  await expect(attach).toBeVisible({ timeout: 20_000 })
  await attach.click()
  // The row's own confirmation — the button becomes a disabled "Attached".
  await expect(attach).toBeDisabled({ timeout: 20_000 })
  await page.getByTestId('dataset-attach-done').click()
  await expect(page.getByTestId('dataset-attach-dialog')).toBeHidden()
}

// ════════════════════════════════════════════════════════════════════════════════════════
//  TEST 1 — UNGATED. In the DEFAULT run.
// ════════════════════════════════════════════════════════════════════════════════════════

test('a file chosen in the wizard becomes a library row, a REPORTED import, and a project input', async ({
  page,
  request,
}) => {
  // A real multipart upload plus the library + detail + attach legs; the config's 120 s
  // per-test budget is tight for that on a busy box.
  test.setTimeout(240_000)

  await loginAsOwner(page)
  // Project creation is not the subject of this spec, so it goes through the API helper —
  // `project/` owns its own UI coverage.
  const projectName = `Journey Ungated ${Date.now()}`
  const projectId = await createProject(request, projectName)

  const uploaded = await uploadThroughWizard(page, request, 'journey-ungated')

  // ── The import is REPORTED, honestly. ────────────────────────────────────────────────
  //
  // The badge is derived server-side from the on-ingest job the upload enqueued, so its
  // mere presence is the product claim this leg can make without a compute host: the
  // conversion was queued and the UI says so. WHICH of the four states it settles on
  // depends on whether the host can run the sandbox — that is TEST 2's business, and
  // asserting `Ready` here would be asserting the host.
  //
  // The membership check is not a weakened equality: it fails on a badge showing a raw
  // backend token, an empty tag, or a state outside the vocabulary the component renders.
  const badge = page.getByTestId('dataset-processing-status')
  await expect(badge).toBeVisible({ timeout: 30_000 })
  await expect(
    badge,
    'the badge must name one of the four states `ProcessingStatusBadge` renders — anything ' +
      'else means an unmapped backend status reached the screen verbatim',
  ).toHaveText(/^(Queued|Processing|Failed|Ready)$/)

  // ── The dataset can be attached to a project THROUGH THE UI, and the project lists it. ─
  await attachFromDetailPage(page, projectId, projectName)

  await openDatasetsPane(page, projectId)
  await expect(
    page.getByTestId(`project-dataset-row-${uploaded.id}`),
    'the project the user attached it to lists the dataset they uploaded',
  ).toBeVisible({ timeout: 30_000 })
})

// ════════════════════════════════════════════════════════════════════════════════════════
//  TEST 2 — GATED on a sandbox-executable host. Tagged @acceptance.
// ════════════════════════════════════════════════════════════════════════════════════════

test.describe('the full journey, over real compute', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('an uploaded file converts, reaches the picker with no reload, is CHOSEN by click, and the run it launches produces a real table @acceptance', async ({
    page,
    request,
  }) => {
    // Two real conversions plus a real compute run. `runQcToCompletion` adds its own budget
    // on top of this ADDITIVELY, so this number is the floor, not a ceiling it can lower.
    test.setTimeout(600_000)

    await loginAsOwner(page)
    const projectName = `Journey Real ${Date.now()}`
    const projectId = await createProject(request, projectName)

    // ── 1. The first file, all the way through the real converter. ──────────────────────
    const first = await uploadThroughWizard(page, request, 'journey-first')
    const firstState = await waitForTerminalProcessingStatus(page)
    expect(
      firstState,
      'the committed fixture must convert on a sandbox-executable host — a failure here is a ' +
        'real regression in the import path, not an environment skip. The badge is the UI’s ' +
        'own report of the on-ingest job; check the job’s error on the detail page first.',
    ).toBe('Ready')

    // The user-visible proof that the conversion produced something: the forward graph.
    await page.getByRole('tab', { name: 'Lineage' }).click()
    await expect(page.getByTestId('dataset-lineage')).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('[data-testid^="dataset-lineage-run-status-"]').first(),
    ).toHaveText('completed', { timeout: 30_000 })
    await expect(page.getByTestId('dataset-lineage-outputs')).toBeVisible()
    await expect(
      page.locator('[data-testid^="dataset-lineage-output-type-"]').first(),
      'the run the upload enqueued catalogued at least one typed output',
    ).toBeVisible()

    await attachFromDetailPage(page, projectId, projectName)

    // ── 2. A SECOND file, converted but deliberately NOT attached yet. ──────────────────
    //
    // Two candidates is what turns the picker from a read-only sole-candidate summary into
    // a control there is something to CLICK — and, more to the point, into one where
    // choosing the wrong row is possible. A journey that never offers a choice cannot show
    // that the run consumes the row the person picked.
    const second = await uploadThroughWizard(page, request, 'journey-second')
    const secondState = await waitForTerminalProcessingStatus(page)
    expect(secondState, 'the second import must convert too').toBe('Ready')

    // ── 3. The workbench, with ONE attached input. ──────────────────────────────────────
    await openWorkbench(page, projectId)
    await awaitQcSurface(page)

    // The precondition, pinned: exactly one candidate ⇒ the sole-candidate summary. Without
    // this the "it became a select" assertion below would pass vacuously on a picker that
    // was already a select.
    await expect(page.getByTestId(PICKER.summary)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(PICKER.select)).toHaveCount(0)
    await expect(page.getByTestId(PICKER.empty)).toHaveCount(0)

    // ── 4. Attach the second dataset from INSIDE the workbench — no reload, no navigation ─
    await openDatasetsPane(page)
    await page.getByTestId('project-attach-select').click()
    await page.getByRole('option', { name: second.name }).click()
    await page.getByTestId('project-attach-button').click()
    await expect(page.getByTestId(`project-dataset-row-${second.id}`)).toBeVisible({
      timeout: 30_000,
    })

    // ── 5. The produced artifact reaches the picker WITHOUT a reload. ───────────────────
    //
    // The page has not been reloaded or navigated since step 3; the catalog epoch the picker
    // re-reads on is driven off the realtime channel. Two candidates now ⇒ the picker must
    // have CHANGED SHAPE into a real control. That shape change is a user-visible fact, not
    // an internal counter.
    await awaitQcSurface(page)
    await expect(
      page.getByTestId(PICKER.select),
      'the artifact produced by the second import must reach the picker with no reload — a ' +
        'picker still showing the sole-candidate summary here is offering a catalog that ' +
        'stopped updating the moment the page mounted',
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId(PICKER.summary)).toHaveCount(0)

    // ── 6. CHOOSE the second one, by CLICKING. ──────────────────────────────────────────
    //
    // The candidates are identified by the ids the REST catalog reports for each dataset, so
    // the click targets a specific row rather than a position. The first input was
    // auto-chosen while it was the only candidate, so the sequence is: add the second, then
    // remove the first — ending on exactly one chosen input, chosen by hand.
    const catalogued = await artifactsOf(request, projectId)
    const inputOf = (datasetId: string): string => {
      const rows = catalogued.filter(
        a => a.datatype === DT.expression && a.source_dataset_id === datasetId,
      )
      expect(
        rows.map(r => r.id),
        `the import of dataset ${datasetId} catalogued exactly one artifact of the type this ` +
          'picker accepts — zero makes the run unlaunchable and two make the choice ambiguous',
      ).toHaveLength(1)
      return rows[0].id
    }
    const firstInput = inputOf(first.id)
    const secondInput = inputOf(second.id)

    const picker = page.getByTestId(PICKER.select)
    await picker.click()
    // The list is OPEN before anything is read off it. `evaluateAll` below is a ONE-SHOT query
    // with no retry, and the rows mount a tick after the click — so without this the read can
    // land in the gap and report an empty list. Waiting on `aria-expanded` rather than on a row
    // is deliberate: it is the precondition (the list is showing) and not the answer (what is in
    // it), so a genuinely EMPTY list still fails loudly at the assertion instead of here.
    await expect(picker, 'the click opened the list').toHaveAttribute('aria-expanded', 'true', {
      timeout: 20_000,
    })

    // WHAT THE OPEN LIST OFFERS — asserted as a SET, before anything is clicked.
    //
    // Two properties, neither of which the click sequence below can carry:
    //
    //  · It is the ONLY thing that says the two rows about to be clicked are the two RAW-COUNT
    //    matrices this project imported, AND THE ONLY TWO. `-opt-<id>.click()` proves an option
    //    exists; it says nothing about what ELSE is in the list, so a picker that started
    //    offering something its source never selected — a lost `excludes`, a widened type
    //    filter — would still be clicked through to a green run. (Measured: with the widget
    //    mutated to emit one extra option per candidate, the click sequence alone still passed
    //    and this line failed, naming the two ids that should not have been there.)
    //  · When the list is EMPTY it fails HERE, naming the emptiness, instead of hanging on a
    //    row that will never exist. That is not a cosmetic difference: an option click has no
    //    action timeout of its own, so it burns the whole test budget and reports a locator.
    const offered = await page
      .locator(`[role="option"][data-testid^="${PICKER.select}-opt-"]`)
      .evaluateAll(
        (nodes, prefix) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(prefix.length)),
        `${PICKER.select}-opt-`,
      )
    expect(
      offered.filter(Boolean).sort(),
      'the open picker offers exactly the two imported raw-count matrices — one per attached ' +
        'dataset, and nothing else',
    ).toEqual([firstInput, secondInput].sort())

    await page.getByTestId(`${PICKER.select}-opt-${secondInput}`).click()
    await page.getByTestId(`${PICKER.select}-opt-${firstInput}`).click()
    await page.keyboard.press('Escape')

    // What is chosen is what is shown: one tag, for the row that was clicked on.
    await expect(page.getByTestId(`${PICKER.select}-tag-${secondInput}`)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByTestId(`${PICKER.select}-tag-${firstInput}`)).toHaveCount(0)

    // The dependent picker re-anchors on the newly-chosen input. REQUIRED before Run — see
    // NAME_SOURCE_SUMMARY.
    await expect(
      page.getByTestId(NAME_SOURCE_SUMMARY),
      'the dependent picker must re-anchor on the chosen input before Run: choosing clears ' +
        'its list, and the compute REFUSES a list it cannot pair with the chosen inputs',
    ).toBeVisible({ timeout: 30_000 })

    // The BEFORE picture, so what the run adds can be told from what the imports already put
    // there. Only the report type is genuinely absent beforehand; the imports catalogue columns
    // of their own, which is why the cross-check at the end differences the two lists rather
    // than counting the project.
    const before = await artifactsOf(request, projectId)
    expect(
      before.filter(a => a.datatype === DT.qcReport),
      'the project has no completed analysis run yet',
    ).toHaveLength(0)

    // ── 7. Run it, for real, from the surface's own control. ────────────────────────────
    //
    // `runQcToCompletion` clicks the real Run button and races the declared success toast
    // against an error toast, so an unavailable sandbox fails with its own message instead
    // of an unexplained locator timeout. The toast is a WAYPOINT — the assertions that
    // matter are below it.
    const analysisId = await runQcToCompletion(page)

    // ── 8. THE RESULT — read out of the produced artifact's own bytes. ──────────────────
    const produced = await artifactsOf(request, projectId)
    const reports = produced.filter(a => a.datatype === DT.qcReport)
    expect(
      reports.length,
      'the completed run catalogued its report artifacts',
    ).toBeGreaterThanOrEqual(1)

    // The run emits two report artifacts; the per-row table is the one carrying a `columns`
    // list. Selected by SHAPE rather than by output id, so this keeps working if the ids are
    // renamed — and fails loudly if neither carries a table at all.
    const token = await ownerToken(request)
    let table: { columns?: unknown } | null = null
    for (const row of reports) {
      const r = await request.get(`${BACKEND}/api/artifacts/${row.id}/data`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(r.ok(), `read artifact ${row.id} -> ${r.status()} ${await r.text()}`).toBeTruthy()
      const payload = (await r.json()) as { columns?: unknown }
      if (Array.isArray(payload.columns)) table = payload
    }
    expect(
      table,
      'one of the produced report artifacts carries the per-row table the surface reads',
    ).not.toBeNull()

    const columns = (table as { columns: string[] }).columns
    // An id column plus at least the two always-computed metric columns. A run that
    // completed having produced nothing lands here with a length of 1 — and toasts
    // identically to one that worked, which is the silent success this assertion exists for.
    expect(
      columns.length,
      `the run produced only ${columns.length} column(s) (${columns.join(', ')}) — a completed ` +
        'run that computed nothing is not a successful run, and it reports success identically',
    ).toBeGreaterThanOrEqual(3)

    // Cross-check the run's own self-report against what was CATALOGUED: every metric column
    // in the table must exist as an addressable artifact. A table that describes columns
    // nothing catalogued is a report about work that did not land.
    //
    // THE RUN'S OWN, by differencing against the before-picture. Counting every column artifact
    // in the project compares the run's 4 against 10 — the two imports catalogue columns too,
    // and they are not this run's work. Measured: this comparison read `10 !== 4` and blamed the
    // run, which is the assertion being wrong about its subject rather than the product being
    // wrong about anything.
    const beforeIds = new Set(before.map(a => a.id))
    const runColumns = produced.filter(
      a => a.datatype === DT.metadataColumn && !beforeIds.has(a.id),
    )
    expect(
      runColumns.length,
      `the table names ${columns.length - 1} metric column(s) but the run catalogued ` +
        `${runColumns.length} new column artifact(s) — the report and the catalog disagree ` +
        'about what THIS run produced',
    ).toBe(columns.length - 1)

    // ── 9. …and the run REACHED THE SCREEN, on the surface that launched it. ───────────
    //
    // This step asserted the shared CANVAS: `data-viz-framework="true"`, on the claim that "the
    // declared series iterate the run's own emitted columns". This analysis declares NO canvas
    // and has not for some time — its view file says so at length and gives the reason (a
    // distribution plot exists to support a threshold DECISION, so the plotting belongs to the
    // analysis that HAS criteria; this one's job ends at producing the columns those criteria
    // are built on). So the assertion was about capability the product deliberately removed, and
    // it could only ever have passed by that capability coming back.
    //
    // Its INTENT — "the result reached the surface, not just the API" — is kept, restated about
    // the readout this view does own: the run appears in the pane's own run list, live. No
    // reload and no navigation since the Run click, so the row arriving is the feedback path
    // working end to end, which is the last leg of the journey this file exists to prove.
    await awaitQcSurface(page)
    await expect(
      page.locator(`[data-testid="analysis-runs-${analysisId}"] [data-testid^="analysis-run-"]`),
      'the completed run must appear in the analysis pane’s own run list without a reload — ' +
        'the result reaching the API and never reaching the screen is exactly the gap this ' +
        'journey exists to close',
    ).toHaveCount(1, { timeout: 60_000 })
    await expect(
      page.getByTestId(`analysis-runs-${analysisId}-empty`),
      'a pane that has just completed a run must stop saying it has never run',
    ).toHaveCount(0)
  })
})
