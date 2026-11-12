import { expect, test, type APIRequestContext } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import { openArtifactsPane } from '../workstore/_artifacts'
import {
  seedQcDataset,
  seedRunnableExpression,
  awaitFilterSurface,
  addCriterion,
  CF,
  CFRow,
  // The number of rows the shared fixture seeds. Aliased AT THE IMPORT so this file has ONE name
  // for the quantity: the assertions below are about rows a pane resolved and rows a run reported,
  // and both read better — and diff more honestly against each other — under one spelling.
  TINY_COUNTS_CELLS as SEEDED_ROWS,
  runQcToCompletion,
} from './_seed'

// TEST-E2 (e2e) [covers: ITEM-9, ITEM-10, ITEM-13] — opening Cell filter (the auto-mounted
// declarative `ui/cell-filter.yaml` surface), adding a criterion + picking a column → the
// before/after pair appears on the ONE canvas (`when: $c.column` → the declared `canvas` block drives
// `VizController.setOption`), and the criterion's threshold control re-derives the client-side
// `$derived.keptMask` LIVE (the shared-store input↔plot link, no refetch); Run commits ONE immutable
// keep-mask column.
//
// PURE for the live add→canvas→reshape→remove loop (seeds obs directly; the client-side keep-mask
// + the canvas structural flip run for real). Headless Chromium cannot paint the deck.gl grid, so the
// live loop is asserted via the STRUCTURAL canvas flip (`data-viz-framework`) + a clean interpreter/
// store/viz console (the derive→re-render loop ran without throwing), not GL pixels. The Run COMMIT
// (`cf.run` → real `run_processor`→`wait_for`) is REAL-compute — gated on TXR_E2E_REAL_COMPUTE.
//
// SEEDING — the two halves need DIFFERENT things, so each seeds its OWN project, coherently:
//   • the PURE half needs obs COLUMNS to drive the min/max controls and the live mask, and no
//     compute at all. One annotated seed gives a single
//     dataset carrying an expression placeholder AND its obs columns.
//   • the REAL half needs a genuinely runnable matrix AND columns that a real producer wrote,
//     so it imports the matrix and RUNS the upstream analysis to produce them.
//
// Both used to seed the SAME pair — `seedQcDataset(expression: false)` plus
// `seedRunnableExpression` — which is TWO datasets in one project. `run_processor` needs exactly
// one compatible artifact per required slot, so opting the obs seed out of its placeholder was
// the right fix for THAT constraint; what it missed is that cell-filter resolves its criteria
// columns on the anchor's own dataset (`siblingsOnAxis`). Columns on dataset A can never be
// offered for a matrix on dataset B, so the criteria builder was empty and both halves died at
// the column picker. The arrangement was coherent only while the obs slice read a project-wide
// report artifact; it did not survive the move to `axis_columns`, and the fixture did not follow.
//
// The REAL half's threshold still means what it meant: the compute resolves `nCount` through its
// METRIC_ALIASES to `total_counts` and derives it from the matrix via `ensure_metric` — the same
// quantity the upstream run emits under that name — so filtering on its OWN column selects the same subset.
//
// SEED BUG — FIXED (was: verified broken 2026-08-04). The paragraph that used to sit here said
// the REAL half needs a real matrix "because `cell-filter.py` does `ad.read_h5ad(...)`". It does
// not, and has not for some time: `compute/cell-filter.py::read_matrix` refuses any `expression`
// input whose declared `structure.kind` is not `"sparse_csc"`, and `compute/qc-10x.py` does the
// same. `seedRunnableExpression` used to post the raw `tiny_counts.h5ad` bytes as ONE opaque blob
// (`SeedBytes::Input => SeedBlob::Single`) with no `structure`, so both computes exited 2 on it —
// and every other real-compute spec seeded that way was equally unrunnable, unnoticed, because
// they all sit behind `TXR_E2E_REAL_COMPUTE`. `seedRunnableExpression` now IMPORTS the fixture
// through the deployment's own on-ingest converter, so what lands is the CSC Zarr store the real
// producer writes (see its header for why a committed or generated FIXTURE cannot serve). The
// assertions below were written against the correct behaviour and are unchanged.
// ── THERE IS NO CANVAS-NOISE ALLOWANCE (a `KNOWN_CANVAS_NOISE` regex used to sit here) ────────────
// It read:
//   /VizController\.setOption failed|encode binds|not a (categorical|value) column|value `primary`|Cannot parse `id`/i
// and it was described as "known, non-regression headless-canvas noise". It was not. Traced to
// source, its five alternatives are two things and neither is noise:
//
//   · `VizController.setOption failed` is the ONE `console.error` this app raises when the canvas
//     REFUSES an option (`CanvasView.tsx`). `encode binds` and `not a … column` are the parse error
//     that failure CARRIES, so all three swallow the same event. A chart the canvas refused draws
//     nothing — which is exactly what a broken chart looks like — and this spec would still have
//     reported a clean console. It is how a broken chart looks healthy. (Measured elsewhere: on
//     `04cf7fe0` the runtime gate found 30 gating HIGH across 5 surfaces, every one of them this
//     message, while it landed and survived five more landings.)
//   · ``value `primary` `` matches nothing in the tree at all, and ``Cannot parse `id` `` is a string
//     thrown by one vitest FIXTURE (`ownedData.test.ts`) and by no shipped code. They were allowances
//     for events that cannot occur — which is how the other three kept their cover.
//
// The infrastructural filter below (`Failed to load resource` / `favicon`) is about the HARNESS
// fetching things a dev server does not serve, and is unrelated.

// ── the commit's EXPECTED OUTCOME, verified against the real compute ──────────────────
//
// `fixtures/tiny_counts.h5ad` holds 120 cells whose `total_counts` (what the processor's
// `METRIC_ALIASES` resolves `nCount` to, computed from the matrix by `ensure_metric`) span
// 27..66. Running `packages/cell-filter/compute/cell-filter.py` directly over that fixture,
// staged as the CSC store `read_matrix` reads, gives:
//
//     criteria [{column: nCount, min: 42}]  →  n_cells_in 120, n_cells_out 65   ← a real subset
//     criteria [{column: nCount, min: 0}]   →  n_cells_in 120, n_cells_out 120  ← kept EVERY cell
//     criteria [{column: nCount, max: -1}]  →  n_cells_in 120, n_cells_out 0    ← kept NONE
//
// The middle threshold is the one that tells a working filter apart from both degenerate
// modes, which is why the assertions below pin it rather than merely checking the run ended.
/** The column the criterion is built on — emitted BY the upstream run this spec performs, not seeded.
 *  It is the same quantity the compute's own alias path derives for `nCount`, which is why the
 *  MIN_COUNT/EXPECTED_KEPT calibration below still holds against the real matrix. */
const PRODUCED_COLUMN = 'total_counts'

const MIN_COUNT = 42
const EXPECTED_KEPT = 65

// ── the PURE half's live-reshape calibration ────────────────────────────────────────────────────
// The thresholded column is seeded as the ramp `1000 + 12i` over the whole seeded frame (see
// `_fixtures.ts::metricRamps`), and `keep_range`'s bounds are INCLUSIVE, so `max = 1300` keeps
// `12i <= 300`, i.e. `i` in `0..25` — 26 of the 120 seeded rows. A strict subset, chosen over the
// old `max = -1` (which kept NONE) because a keep-nothing outcome is indistinguishable from
// several ways of being broken.
const MAX_COUNT = 1300
const EXPECTED_KEPT_UNDER_MAX = 26

/** The column the PURE half builds its criterion on. Named ONCE, then reused by the criterion it
 *  drives AND by the title assertion below — so the assertion reads "the pane is titled for the
 *  column I actually picked" and cannot drift from it. */
const THRESHOLD_COLUMN = 'nCount'

/** The canvas coordIds the shipped view spec gives the FIRST criterion's before/after violin pair
 *  (`"before-violin-$i"` / `"after-violin-$i"` at `$i == 0`). */
const BEFORE_PANE = 'before-violin-0'
const AFTER_PANE = 'after-violin-0'

// ── what a canvas PANE resolved, read off the shipped `window.__canvasPanes` seam ──────────────
//
// The grid is deck.gl/WebGL2 and headless Chromium cannot paint it, so the reshape step below
// cannot assert pixels. It must NOT therefore fall back to asserting that nothing crashed — that
// is exactly what it used to do (fill `max`, then re-assert `data-viz-framework="true"`), and it is
// why a completely dead before/after link shipped green: the attribute says a canvas is mounted,
// which was equally true when the "after" pane was frozen on the first data it ever resolved.
//
// The seam reports each pane's row count out of the DatasetStore entry the grid renders from — one
// step BELOW the derived keep-mask. `window.__declarativeStores.keptCount` (already asserted by the
// scatter-thinning spec under `14-workbench/`) would not do here: under the bug it moved correctly
// on every keystroke while the plot did not, so an assertion on it certifies the wiring that was
// never broken.
//
// It also reports WHICH dataset entry that count came from. The reshape can be bought either by
// re-resolving the dataset in place or by publishing a new one, and the row count reads identically
// under both — while only the first keeps the identity (and therefore the selection space) the pane
// had. Reading the key is the difference.

/** One pane as the canvas resolved it. `rows: null` ⇒ no dataset bound, or its catalog has not
 *  landed yet — distinguishable from a genuine zero. */
interface CanvasPane {
  id: string
  kind: string
  title: string | null
  switchTo: string[] | null
  rows: number | null
  datasetKey: string | null
}

async function canvasPanes(page: import('@playwright/test').Page): Promise<CanvasPane[]> {
  return page.evaluate(() => {
    const seam = (window as unknown as { __canvasPanes?: () => CanvasPane[] }).__canvasPanes
    return seam ? seam() : []
  })
}

/** The row count the pane at `coordId` resolved, or `null` while it has not resolved one. */
async function paneRows(
  page: import('@playwright/test').Page,
  coordId: string,
): Promise<number | null> {
  return (await canvasPanes(page)).find(p => p.id === coordId)?.rows ?? null
}

/** The dataset identity the pane at `coordId` is bound to — the key viz files its entry under. */
async function paneDatasetKey(
  page: import('@playwright/test').Page,
  coordId: string,
): Promise<string | null> {
  return (await canvasPanes(page)).find(p => p.id === coordId)?.datasetKey ?? null
}

/** One row of `GET /api/projects/{id}/artifacts` (a flattened `Artifact` + source-dataset fields). */
type ListedArtifact = { id: string; output_id: string; datatype: string; status?: string }

/** The project's catalogued artifacts, straight off the REST surface the Artifacts pane reads. */
async function artifactsOf(
  request: APIRequestContext,
  projectId: string,
): Promise<ListedArtifact[]> {
  const admin = await ownerToken(request)
  const r = await request.get(`${BACKEND}/api/projects/${projectId}/artifacts`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(r.ok(), `list artifacts -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return (await r.json()) as ListedArtifact[]
}

/** What `cell-filter.py` recorded about the commit: `{n_cells_in, n_cells_out, n_removed,
 *  mask_column, …}`, read out of the `filter-report` artifact's own bytes. This is the run's
 *  self-report of the OUTCOME — the number a user judges a filter by. */
async function filterReport(
  request: APIRequestContext,
  projectId: string,
): Promise<Record<string, number | string>> {
  const rows = (await artifactsOf(request, projectId)).filter(a => a.output_id === 'filter-report')
  expect(
    rows,
    'the completed run catalogued exactly one `filter-report` (cell-filter.py emits it beside the mask)',
  ).toHaveLength(1)
  const admin = await ownerToken(request)
  const r = await request.get(`${BACKEND}/api/artifacts/${rows[0].id}/data`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(r.ok(), `read filter-report -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return (await r.json()) as Record<string, number | string>
}

test.describe('cell-filter live before/after loop (TEST-E2)', () => {
  test('adding a criterion drives the before/after canvas + reshapes live; removing it clears it', async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = []
    const keep = (t: string) => {
      if (!/Failed to (load resource|fetch)|favicon/i.test(t)) consoleErrors.push(t)
    }
    page.on('console', m => {
      if (m.type() === 'error') keep(m.text())
    })
    page.on('pageerror', e => keep(String(e)))

    await loginAsOwner(page)
    const id = await createProject(request, `CellFilter Live ${Date.now()}`)
    // obs columns only (no opaque placeholder) + the REAL runnable matrix as the sole
    // `single-cell/expression` — so BOTH halves of this spec have what they need.
    // ONE dataset carrying BOTH the expression placeholder and its obs columns.
    //
    // This used to be two seeds — the annotated columns from one helper and the
    // matrix from `seedRunnableExpression` — which are two SEPARATE datasets in one project.
    // cell-filter anchors on the matrix and `siblingsOnAxis` scopes columns to the anchor's own
    // dataset, so the criteria builder saw NOTHING and this spec died at the column picker. The
    // pairing was coherent only while that slice read a project-wide report artifact; when it
    // moved to `axis_columns` the fixture stayed behind. A real import puts a matrix and the
    // columns describing it on ONE dataset, so the fixture now does too.
    await seedQcDataset(request, id, { annotated: true, nCells: SEEDED_ROWS, expression: true })
    await openWorkbench(page, id)
    await awaitFilterSurface(page)

    // No criteria yet → the canvas is its honest empty hero.
    const host = page.getByTestId('workbench-canvas-host')
    await expect(host).toBeAttached({ timeout: 20_000 })
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })

    // Add a criterion on a CONTINUOUS column → the before/after VIOLIN pair drives the ONE canvas
    // grid, and the column yields the min/max threshold controls the reshape step drives.
    await addCriterion(page, 0, { column: THRESHOLD_COLUMN })
    await expect(host).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })

    // ── the criteria builder is CONTAINED by the dock pane it lives in ────────────────────────
    // REPORTED: the builder was wider than its pane, so the last heading and the row action were
    // cut off. It was not scrolling — it was OVERFLOWING, and the difference is the whole bug:
    // the grid measured identically at every pane width because the pane was never an input to
    // it. The gallery measures this at both ends of the pane's clamp; this measures it once on
    // the REAL surface, at the width the pane actually opens at, because that is the thing that
    // was reported.
    //
    // The rule is the repo's: wide content scrolls INSIDE ITS OWN CONTAINER, never past the
    // pane. So an element outside an x-scrollable ancestor is a spill; one inside is reachable.
    const spills = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="widget-criteriaTable"]')
      if (!table) return ['the criteria builder did not render']
      const pane = table.closest('[data-region]')
      if (!pane) return ['the criteria builder is not inside a dock region']
      const limit = pane.getBoundingClientRect().right + 1
      const scrolls = (el: Element): boolean => {
        const ox = getComputedStyle(el).overflowX
        return ox === 'auto' || ox === 'scroll'
      }
      const out: string[] = []
      for (const el of [table, ...Array.from(table.querySelectorAll('*'))]) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.right <= limit) continue
        let scroller: Element | null = null
        for (let a = el.parentElement; a && a !== pane; a = a.parentElement) {
          if (scrolls(a)) { scroller = a; break }
        }
        if (scroller) continue
        out.push(
          `<${el.tagName.toLowerCase()}> ${el.getAttribute('data-testid') ?? '(no testid)'} ` +
            `right=${Math.round(r.right)} > pane ${Math.round(limit)}`,
        )
      }
      return out
    })
    expect(spills, `the criteria builder spills its dock pane:\n  ${spills.join('\n  ')}`).toEqual([])

    // Both panes resolve the whole seeded frame first: an unconstrained criterion keeps every row,
    // so "before" and "after" start equal. That equality is the baseline the reshape moves off.
    await expect.poll(() => paneRows(page, BEFORE_PANE), { timeout: 20_000 }).toBe(SEEDED_ROWS)
    await expect.poll(() => paneRows(page, AFTER_PANE), { timeout: 20_000 }).toBe(SEEDED_ROWS)

    // Each pane SAYS which column and which side it is — derived from the criterion, so it follows
    // whatever column the user picked (there is no per-criterion literal to write). Asserted
    // against the SAME constant the criterion was built from, so a drift between what was picked
    // and what the header claims is a failure rather than two literals agreeing by habit.
    const titled = await canvasPanes(page)
    expect(titled.find(p => p.id === BEFORE_PANE)?.title).toBe(`${THRESHOLD_COLUMN} (before)`)
    expect(titled.find(p => p.id === AFTER_PANE)?.title).toBe(`${THRESHOLD_COLUMN} (after)`)
    // …and its kind switcher offers only other readings of THIS distribution.
    expect(titled.find(p => p.id === AFTER_PANE)?.switchTo?.slice().sort()).toEqual([
      'box',
      'histogram',
      'violin',
    ])

    // ── Reshape "after" LIVE — the assertion this spec exists for ─────────────────────────────
    // A `max` of 1300 over the seeded ramp (1000 + 12i, i < 120) keeps i ≤ 25 — a STRICT SUBSET,
    // deliberately not a degenerate one: a link that resolved to zero rows for an unrelated
    // reason, or one that never re-resolved at all, both fail this number.
    // The identity the pane is bound to BEFORE the edit — see the stability assertion below.
    const keyBeforeEdit = await paneDatasetKey(page, AFTER_PANE)
    expect(keyBeforeEdit, 'the AFTER pane is bound to a dataset before the edit').not.toBeNull()

    const max = page.getByTestId(CFRow.max(0))
    await max.fill(String(MAX_COUNT))
    await max.blur()
    await expect
      .poll(() => paneRows(page, AFTER_PANE), {
        timeout: 20_000,
        message:
          'the AFTER pane did not follow the criterion. `$derived.keptMask` re-deriving is NOT ' +
          'enough — check that the pane\'s dataset was re-RESOLVED. Viz reuses a dataset by id ' +
          'and re-resolves only when the option gives it a new `VizDataset.rev`, so the feed must ' +
          'publish a revision that tracks the mask content.',
      })
      .toBe(EXPECTED_KEPT_UNDER_MAX)
    // The BEFORE pane is what makes the pair a comparison: it must NOT move.
    expect(await paneRows(page, BEFORE_PANE), 'the BEFORE side never masks').toBe(SEEDED_ROWS)

    // …and it reshaped UNDER THE SAME IDENTITY. Re-resolving by minting a new dataset id passes
    // every row assertion above while retiring the identity on each keystroke — and a resolved
    // dataset is also a selection space, so a brush/gate in that pane would be discarded every
    // time the user nudges a bound. The row count cannot see that; this is what does.
    expect(
      await paneDatasetKey(page, AFTER_PANE),
      'the AFTER pane changed dataset identity when its content changed — the content digest ' +
        'belongs in `rev`, not in the id',
    ).toBe(keyBeforeEdit)

    // Relaxing the same bound brings the rows BACK — a one-way narrowing would pass the step above
    // while still being a broken live link (e.g. a cache that only ever tightens).
    await max.fill('')
    await max.blur()
    await expect.poll(() => paneRows(page, AFTER_PANE), { timeout: 20_000 }).toBe(SEEDED_ROWS)

    // Remove the criterion → the before/after pair clears (canvas returns to the empty hero).
    await page.getByTestId(CFRow.remove(0)).click()
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })

    expect(consoleErrors, `console errors during the live loop:\n${consoleErrors.join('\n')}`).toEqual([])
  })
})

// ── the Run COMMIT, over the REAL compute ────────────────────────────────────────────────
//
// This was the tail of the test above, wrapped in a module-level `if (REAL) { … }`. Two things
// were wrong with it, and they compounded:
//
//  1. `14-workbench/_analysis.ts` documents, at length and from measurement, that the
//     `if (REAL_COMPUTE) { … }` wrapper is the WRONG lever ("NEVER as a module-level
//     `if (REAL_COMPUTE) { … }` wrapper"): under Playwright a conditional skip is REPORTED as
//     skipped with its reason, whereas a block that silently does not execute is indistinguishable
//     from one that ran. On every default run this spec passed having exercised no compute at all,
//     and its report said "1 passed".
//  2. What the block DID assert, when it ran, was a TOAST. `cf.run`'s declared body ends with
//     `toast: {success: "Keep-mask committed"}`, so the toast proves the action body reached its
//     last step — not that the mask means anything. A cell-filter that kept every cell, or none,
//     emits exactly the same toast. That is verbatim the "rc=0, green report" failure this branch
//     exists to remove, and `annotation_integrate`'s own new unit coverage documents it as the bug.
//
// So: a describe-level skip (collected, reported, short-circuits before the fixtures), the
// `@acceptance` TAG the config's `grepInvert` keys off so `just verify-acceptance` positively
// SELECTS it — without the tag a describe-skipped test is reachable by no invocation at all, the
// exact trap `_analysis.ts` measured at 16 of 17 specs — and assertions on the RESULT.
test.describe('cell-filter commit outcome (TEST-E2 · real compute)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('committing a keep-mask keeps a VERIFIED SUBSET of cells — not every cell, not none @acceptance', async ({
    page,
    request,
  }) => {
    // The commit is a real sandbox run; the config's per-test budget is 120s, so the 180s waited
    // on below has to be granted explicitly or the test dies before its own expect can.
    test.setTimeout(300_000)

    await loginAsOwner(page)
    const id = await createProject(request, `CellFilter Commit ${Date.now()}`)

    // ── THE CHAIN: the upstream analysis PRODUCES the column, this one CONSUMES it ──────
    //
    // This is the seam nothing covered, and every defect found by hand lived in it. Those
    // columns used to be FABRICATED (the annotated seed helper, whose own
    // comment says it "mirrors" what a real run emits) — a hand-written stand-in for the
    // producer. A mirror cannot show a divergence from the thing it mirrors, so:
    //
    //   · the fixture named each member after its column; the real writer names them ALL
    //     `values`, and every column on an axis collapsed onto that one key.
    //   · the fixture had no string columns at all; a real import carries per-row identifiers,
    //     which were offered as groupings and as filter criteria.
    //   · the fixture always had a column chosen, so a blank row displaying the first option
    //     as though it were selected was never observed.
    //
    // So the matrix is imported for real, the producing analysis is RUN for real, and the criterion is built on a
    // column that run itself produced. Nothing about the frame is fabricated.
    //
    // The calibration survives the switch: the compute resolves `nCount` through its own
    // METRIC_ALIASES to `total_counts` and derives it from the matrix, which is the same
    // quantity the upstream run emits under that name — so the same threshold selects the same subset, and
    // MIN_COUNT/EXPECTED_KEPT keep their meaning.
    await seedRunnableExpression(request, id, 'CellFilter matrix')
    await openWorkbench(page, id)
    await runQcToCompletion(page)

    // Baseline: no FILTER run has happened, so any `filter-report` below is attributable to
    // THIS commit. (The upstream analysis has run — that is the point — and emits no `filter-report`.)
    expect(
      (await artifactsOf(request, id)).filter(a => a.output_id === 'filter-report'),
      'the project has no filter run yet',
    ).toHaveLength(0)

    await awaitFilterSurface(page)

    // ── what the picker OFFERS, before anything is chosen ───────────────────────────────
    await page.getByTestId(CF.add).click()
    const col = page.getByTestId(CFRow.col(0))
    await col.waitFor({ state: 'visible', timeout: 20_000 })
    // POLLED, not read once: the catalog refresh that carries a finished run's new artifacts is
    // event-driven, so the options can arrive after the success toast. A single read here is a
    // race, and a race that resolves to "empty" is indistinguishable from a real absence.
    //
    // The picker is a POPOVER, so its rows do not exist in the DOM until it is opened — "what
    // does it offer" is open → read → close, not an `option` query. Opening is idempotent (the
    // poll re-enters this) and the close is awaited, so a run of the poll can never read the
    // PREVIOUS iteration's still-open list.
    const optionValues = async (): Promise<string[]> => {
      if ((await col.getAttribute('aria-expanded')) !== 'true') await col.click()
      const prefix = `${CFRow.col(0)}-opt-`
      const values = await page
        .locator(`[role="option"][data-testid^="${prefix}"]`)
        .evaluateAll((nodes, p) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(p.length)), prefix)
      await page.keyboard.press('Escape')
      await expect(col).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 })
      return values.filter(Boolean)
    }

    // The produced columns arrive under the names the producer gave them. `values` is the CONSTANT
    // member path every single-column store writes under, so seeing it here means the frame
    // keyed on the container instead of the producer and collapsed every column into one.
    await expect
      .poll(optionValues, {
        timeout: 60_000,
        message:
          'the criteria picker never offered the columns the upstream run produced. This is the seam ' +
          'the spec exists for: they were emitted, and the analysis that consumes them cannot see ' +
          'them. Check the produced artifacts\' dataset scope against the anchor matrix — ' +
          '`siblingsOnAxis` requires them to MATCH.',
      })
      .toContain(PRODUCED_COLUMN)
    const values = await optionValues()
    expect(values, 'a column named for its container is the collapse, not a column').not.toContain('values')

    // A per-row identifier names rows; it does not group or threshold them. Offering one is a
    // choice that cannot produce a meaningful filter.
    for (const identifier of ['cells_index', 'cell_id']) {
      expect(values, `"${identifier}" is a per-row identifier, not a criterion`).not.toContain(identifier)
    }

    // A freshly added row has chosen NOTHING, and says so. A control that renders its first
    // option for an unmatched value claims a choice the state does not hold — the divergence
    // that hid the missing min/max inputs. The trigger names what it holds on a `data-value`
    // node, so "names nothing" is the popover form of the native `value === ''`.
    expect(
      await col.locator('[data-value]').count(),
      'a new criterion row starts unchosen — the control must show its placeholder, not a column',
    ).toBe(0)

    // A criterion that keeps a STRICT SUBSET (see MIN_COUNT/EXPECTED_KEPT above).
    await addCriterion(page, 0, { column: PRODUCED_COLUMN })
    const min = page.getByTestId(CFRow.min(0))
    await min.fill(String(MIN_COUNT))
    await min.blur()
    // The mask NAME. `fill` REPLACES the field's default (`keep`) rather than appending to
    // it — which matters now that the field ships defaulted: an `type()` here would commit
    // `keepstrict`, and every assertion below would still read consistently.
    await page.getByTestId(CF.label).fill('strict')
    await page.getByRole('button', { name: 'Commit keep-mask' }).click()

    await expect(
      page.getByText('Keep-mask committed', { exact: false }),
      'the `cf.run` body ran to completion. A TIMEOUT here means the RUN failed, not the UI — the ' +
        'first thing to check is the expression input: `cell-filter.py::read_matrix` refuses any ' +
        '`expression` artifact that does not declare `kind: "sparse_csc"`. `seedRunnableExpression` ' +
        'asserts that declaration on what it imported, so if that assertion passed and this one ' +
        'times out, the matrix is fine and the fault is downstream. Reproduce off Playwright by ' +
        'running compute/cell-filter.py directly with the imported store on the `expression` slot.',
    ).toBeVisible({ timeout: 180_000 })

    // ── THE OUTCOME — what the toast could never tell us ────────────────────────────────
    const report = await filterReport(request, id)
    // VERBATIM: what was typed IS the column. There is no `keep_` prefix and no slug — the
    // whole point of the naming rule is that this assertion can be the literal keystrokes.
    expect(report.mask_column, 'the committed column IS the name the user typed').toBe('strict')
    expect(report.n_cells_in, 'the run saw the whole seeded matrix').toBe(SEEDED_ROWS)
    expect(
      report.n_cells_out,
      `the filter kept NONE of the ${SEEDED_ROWS} cells — a mask that empties the dataset is ` +
        'not a successful filter, and it toasts identically to one that works',
    ).toBeGreaterThan(0)
    expect(
      report.n_cells_out,
      `the filter kept EVERY one of the ${SEEDED_ROWS} cells — the criterion was not applied ` +
        '(this is the silent no-op the toast has always passed over)',
    ).toBeLessThan(SEEDED_ROWS)
    expect(
      report.n_cells_out,
      `nCount >= ${MIN_COUNT} selects a specific subset of tiny_counts.h5ad, verified against the ` +
        'real compute; a different number means the threshold did not reach the matrix intact',
    ).toBe(EXPECTED_KEPT)
    expect(report.n_removed).toBe(SEEDED_ROWS - EXPECTED_KEPT)

    // The mask itself is catalogued as a real, addressable artifact (not just a report about one).
    const masks = (await artifactsOf(request, id)).filter(
      a => a.output_id === 'metadata-column:strict',
    )
    expect(masks, 'the commit catalogued the keep-mask column').toHaveLength(1)
    expect(masks[0].datatype).toBe('metadata-column')

    // …and the user can see it: the Artifacts pane is where a committed mask surfaces.
    await openArtifactsPane(page)
    await expect(page.getByTestId('project-artifacts-list')).toContainText('metadata-column:strict')
  })
})
