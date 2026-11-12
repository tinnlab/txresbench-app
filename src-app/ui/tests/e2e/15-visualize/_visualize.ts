// Shared helpers for the Visualize-pane specs (visualize-pane, TESTS.md §15-visualize).
//
// Underscore-prefixed, so the routing gate's "every `*.spec.ts` is owned by exactly one
// config" rule ignores it and the runner never collects it as a suite.

import { expect, type APIRequestContext, type Page } from '@playwright/test'

import { openWorkbench } from '../14-workbench/_dock'
import {
  postSeedPlan,
  seedPlottableProject,
  seedQcDataset,
  type SeedArtifactSpec,
  type SeedEngineResponse,
} from '../14-declarative-qc/_seed'

/** The two shipped sections' ids — the manifest's, so a rename fails here rather than in
 *  four specs. They are the pane's DEFAULT arrangement order (`order: 10`, `order: 20`). */
export const SECTIONS = {
  coordinates: 'sc.viz.coordinates',
  colourBy: 'sc.viz.colour-by',
  entries: 'sc.viz.entries',
} as const

export const stack = 'section-stack-visualize'
export const frame = (id: string) => `section-frame-${id}`
export const handle = (id: string) => `section-drag-handle-${id}`

/**
 * Seed a project that satisfies BOTH shipped sections' `applies_to`.
 *
 * Coordinates declares a capability-only selector (`plottable-xy`) and Colour by declares
 * `metadata-column`, so the two need different artifacts present — which is the point:
 * availability is per section, and a project holding one kind and not the other must list
 * one section and not the other. Both are seeded here so the ARRANGEMENT specs have two
 * sections to arrange; the availability halves are unit-pinned.
 */
export async function seedTwoSectionProject(request: APIRequestContext, projectId: string): Promise<void> {
  await seedPlottableProject(request, projectId)
  await seedQcDataset(request, projectId, { annotated: true })
}

/** Open the workbench and wait for the Visualize pane's section stack to paint.
 *
 *  It POLLS rather than waiting once: the sections' availability is computed against the
 *  project's produced type ids, which arrive one catalog round-trip after the shell mounts,
 *  and the registries hold no subscribers — so the stack legitimately renders its empty
 *  state first and re-renders when the catalog resolves. */
export async function openVisualize(page: Page, projectId: string): Promise<void> {
  await openWorkbench(page, projectId)
  const tab = page.getByTestId('region-tab-p-visualize')
  if (await tab.count()) await tab.click().catch(() => {})
  await expect(page.getByTestId(stack)).toBeVisible({ timeout: 30_000 })
}

/** The section ids currently rendered, top to bottom — read from the DOM, so it is the
 *  ARRANGEMENT the user sees rather than any store's idea of it. */
export async function renderedOrder(page: Page): Promise<string[]> {
  return page.locator(`${'[data-section-id]'}`).evaluateAll(els =>
    els.map(e => e.getAttribute('data-section-id') ?? ''),
  )
}

/**
 * Drag one section's handle onto another's box.
 *
 * NOT `locator.dragTo()`: the reorder is a POINTER-event drag with a 4px movement threshold
 * and an `elementFromPoint` drop resolution (`regions/pointerDrag.ts`, the same primitive
 * the region tab strip uses), so it needs real intermediate moves — a single jump would
 * either miss the threshold or land with no move recorded, and the drop is a no-op unless
 * `moved` is true.
 */
export async function dragSectionOver(page: Page, fromId: string, ontoId: string): Promise<void> {
  const grip = page.getByTestId(handle(fromId))
  const target = page.locator(`[data-section-id="${ontoId}"]`)
  const a = await grip.boundingBox()
  const b = await target.boundingBox()
  expect(a, `no drag handle for ${fromId}`).toBeTruthy()
  expect(b, `no section box for ${ontoId}`).toBeTruthy()
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2)
  await page.mouse.down()
  // Past the threshold first, then onto the target in steps, so every intermediate position
  // is a real pointermove the drag can observe.
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2 + 12, { steps: 4 })
  await page.mouse.move(b!.x + b!.width / 2, b!.y + 8, { steps: 12 })
  await page.mouse.up()
}

// ── THE ANCHORED PROJECT (the emit model's fixture) ──────────────────────────────────────────
//
// Everything above seeds a project that makes the sections LIST. Emitting a plot needs the whole
// frame to resolve, which is three declarations the other seeds have no reason to carry:
//
//   · a KEY artifact — the thing that IS a row space. `derive_axes` publishes an axis only for an
//     artifact declaring `meta.is_axis_index`, so without one the anchor offers nothing and every
//     section renders A0 ("no row space anchored"), which is exactly what it should do and is not
//     what this fixture is for.
//   · `structure.aligned_to` on the coordinates and the columns, naming the key's own
//     `key_sequence_digest`. The offering predicate is a JOIN on that value (a producer cannot
//     declare a `content_hash` — ingest mints it after the fact), so an unaligned artifact is A3:
//     offered and marked, but the point here is the un-marked path.
//   · a producer SUMMARY (`meta.kind` + range) on each column, because a row states its shape
//     from `meta` alone and refuses nothing without one.
//
// The columns are CONTINUOUS: the seeded bytes are f32, and a categorical colouring over a
// numeric column is a binding viz correctly refuses. Nothing about the emit model turns on which
// kind it is.

import { entityColumnArtifact, ENTITY_AXIS, DT } from '../14-declarative-qc/_fixtures'

/** The digest the key artifact declares and every aligned artifact names. Any stable string
 *  works — the engine JOINS on it and never interprets it. */
const KEY_DIGEST = 'e2e-visualize-row-space'
/** The row count the shared plottable seed writes its positions for. The columns below MUST
 *  match it: a column of a different length is a different row space, and the canvas would draw
 *  a picture of two populations. */
export const ANCHORED_ROWS = 60

export interface AnchoredSeed {
  columns: readonly string[]
  n_rows: number
  /** The dataset the key artifact + the columns were seeded into. It is this dataset's NAME that
   *  the anchor control renders as the row space's PROVENANCE, so a spec exercising a rename
   *  needs its id. */
  dataset_id: string
}

/**
 * The columns § Colour by will list. TWO, so *"the ▶ I pressed"* is distinguishable from
 * *"a ▶"* — and NAMED rather than positional, because the specs read them by name: a declared
 * collection promises nothing about order, so `columns[0]` would be asserting against whichever
 * one this file happened to write first.
 */
export const ANCHORED_COLUMN = { first: 'metric one', second: 'metric two' } as const
const ANCHORED_COLUMNS = [ANCHORED_COLUMN.first, ANCHORED_COLUMN.second] as const

/** The declared display NAME of the frame this fixture is meant to be framed on — the one whose
 *  alignment to {@link KEY_DIGEST} is DECLARED, and therefore the only one of the project's two
 *  coordinate sets that can scope the sections below. Named so `frameThePane` picks it by the
 *  producer's own declaration rather than by list position. */
export const ANCHORED_COORDINATE = 'anchored projection'

export async function seedAnchoredProject(
  request: APIRequestContext,
  projectId: string,
  /** Extra artifacts to seed INTO THE SAME DATASET. Not a plan of their own: the sibling-axis
   *  join is scoped by SOURCE DATASET (widening it to the project would silently offer another
   *  row space's entries), so an artifact seeded in a separate plan is correctly invisible to
   *  this anchor — a real rule, and a confusing way to discover it. */
  extra: ReadonlyArray<SeedArtifactSpec> = [],
  /** The dataset NAME — i.e. the provenance § Coordinates groups this frame under. Defaults to
   *  a unique generated one; a spec that reads or renames the provenance names it. */
  datasetName?: string,
  /**
   * WITHHOLD the frame's `aligned_to` declaration, leaving its alignment UNKNOWN (A3).
   *
   * The frame is still seeded into the dataset that carries the keys, so the pane STILL derives
   * which rows it is about — through rung 2 of `coordinateAxis.ts` (same source dataset, same
   * declared axis label), which needs no `aligned_to` at all. That combination is the point:
   * a fixture that is genuinely all-A3 *and* still usable.
   *
   * It exists because seeding a DECLARED frame by default silently destroyed the premise of the
   * all-A3 test — an aligned candidate in an offer that is supposed to have none. Bumping that
   * test's expected count would have hidden the contradiction instead of fixing it.
   *
   * It also means the e2e tier exercises the undeclared-alignment path at all, which is THE
   * OWNER'S OWN DATA (imported before the importer stamped `aligned_to`). A previous fix to this
   * pane passed every test and changed nothing on their screen precisely because every fixture
   * was well-declared.
   */
  /**
   * `rows` / `chunkRows` are the same parameters {@link seedOwnerImportedShape} already carries,
   * and for the same reason: the streaming specs need to control ARRIVAL, and a fixture pinned at
   * 60 rows in one chunk cannot express a multi-chunk read at all. Defaults preserved deliberately
   * — every existing caller reads {@link ANCHORED_ROWS}, so changing the default here would move
   * assertions in files that have nothing to do with streaming.
   */
  opts: { declaredFrame?: boolean; rows?: number; chunkRows?: number } = {},
): Promise<AnchoredSeed> {
  const declaredFrame = opts.declaredFrame !== false
  const n = opts.rows ?? ANCHORED_ROWS
  // The shared plottable seed still runs — several specs need its expression / clustering /
  // mask artifacts — but it is NO LONGER what this fixture frames on. Its positions live in a
  // dataset of their own that publishes NO key artifact, so nothing declares which rows they
  // are about.
  //
  // ── WHY THAT STOPPED BEING USABLE (owner, 2026-08-13) ─────────────────────────────────
  //
  // It used to be, because the pane's first block let the USER assert the bridge: they anchored
  // the row space seeded below and the positions above were then offered against it (A3 —
  // alignment unknown, offered and marked). That control is deleted, and with it the ability to
  // assert a link no declaration supports. Painting THIS dataset's columns on THAT dataset's
  // coordinates, with nothing in the data connecting them, is the exact failure the pane exists
  // against — so the pane now correctly refuses it, and a fixture that depended on it was
  // depending on the defect.
  //
  // So the frame this fixture uses is seeded INTO the dataset that carries the keys, DECLARING
  // its alignment — which is what a real import writes and what the owner's own data looks
  // like. The cross-dataset case is not lost: `seedDeclaredCrossDatasetFrame` covers the
  // legitimate shape, where an integration DECLARES the link.
  await seedPlottableProject(request, projectId)
  const framePositions = positionsArtifact(n, opts.chunkRows)
  const keyValues = Array.from({ length: n }, (_, i) => i)
  const key = entityColumnArtifact('row keys', keyValues, ENTITY_AXIS)
  const seeded = await postSeedPlan(request, projectId, {
    dataset: { name: datasetName ?? `anchored-${Date.now()}`, datatype: DT.expression },
    artifacts: [
      {
        // THE ROW SPACE. It declares its own key sequence; everything aligned names that value.
        output_id: 'rows-index',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...key.structure, key: 'values', key_sequence_digest: KEY_DIGEST },
        meta: { ...key.meta, is_axis_index: true },
        content: { encoding: 'members', members: key.members },
      },
      {
        // THE FRAME, in the SAME dataset as the keys and DECLARING the key sequence. Rung 1 of
        // the derivation resolves on this, so picking it scopes the sections below to these rows.
        output_id: 'frame-positions',
        datatype: DT_POSITIONS,
        scope: 'dataset' as const,
        structure: declaredFrame
          ? { ...framePositions.structure, aligned_to: KEY_DIGEST }
          : { ...framePositions.structure },
        meta: { name: ANCHORED_COORDINATE },
        content: { encoding: 'members' as const, members: framePositions.members },
      },
      ...ANCHORED_COLUMNS.map((name, ci) => {
        const values = Array.from({ length: n }, (_, i) => (i % 10) + ci)
        const col = entityColumnArtifact(name, values, ENTITY_AXIS)
        return {
          output_id: `col-${ci}`,
          datatype: DT.metadataColumn,
          scope: 'dataset' as const,
          structure: { ...col.structure, aligned_to: KEY_DIGEST },
          // The producer's declared SUMMARY — what a row states before it is pressed.
          meta: { ...col.meta, kind: 'continuous', min: ci, max: 9 + ci, n },
          content: { encoding: 'members' as const, members: col.members },
        }
      }),
      ...extra,
    ],
  })
  return { columns: ANCHORED_COLUMNS, n_rows: n, dataset_id: seeded.dataset_id as string }
}

/**
 * Put the pane in a state where a picture is possible: a coordinate set chosen.
 *
 * ── ONE GESTURE, WHERE THERE USED TO BE TWO (owner, 2026-08-13) ──────────────────────────────
 *
 * This helper used to answer the pane's first block — a control asking WHICH ROWS — and then
 * pick a coordinate set. That control is DELETED (*"there is no such thing as a row space"*), so
 * there is exactly one thing to answer: § Coordinates is the pane's first block, it lists the
 * project's 2-D coordinate sets immediately, and the rows every other section is scoped to are
 * DERIVED from the set picked here (`core/runtime/coordinateAxis.ts`).
 *
 * It is never chosen FOR the user, not even when the project holds exactly one:
 * `auto_bind_sole_candidate` is opt-IN (DEC-15 — absence is OFF) and § Coordinates deliberately
 * declines it, because *"a frame picked for you is a picture you did not ask a question about."*
 * So a gesture is always required here, which is why this helper exists at all.
 */
/**
 * The per-row EMIT controls in § Coordinates (ledger #27) — one per coordinate set, replacing
 * the single wide button at the foot of the card that every spec here used to address as
 * `widget-plotFrame`.
 *
 * Addressed by the testid STEM rather than by the artifact id, because a spec that knows which
 * row it means says so with the row's accessible NAME; a spec that only means "the frame can be
 * drawn" takes the first.
 */
export function coordinateEmits(page: Page) {
  return page
    .locator('[data-section-id="sc.viz.coordinates"]')
    .locator('[data-testid^="widget-coordinatePicker-emit-"]')
}

export async function frameThePane(page: Page, opts: { coordinateRows?: number } = {}): Promise<void> {
  // § Coordinates declares `control: radio` (DEC-10: *"Coordinates are RADIO — one active
  // choice"*), so this is a radiogroup whose options are all on screen — and it is asserted as
  // ONE control rather than as "a radiogroup or a combobox", which is a disjunction both the
  // fixed and the broken implementation satisfy. Addressed by the widget's own testid rather
  // than by role name: with more than one source dataset the control splits into one radiogroup
  // PER DATASET (each named `<control> — <dataset>`), so a locator pinned to the bare name would
  // silently match nothing on exactly the projects that have a choice to make.
  const picker = page.getByTestId(/^widget-coordinatePicker-radio(-\d+)?$/)
  await expect(picker.first()).toBeVisible({ timeout: 30_000 })

  // WHICH one. A caller whose fixture offers more than one says so by the COVERAGE the option
  // states (`<n> rows · 2D`) — the declared fact that tells two same-named sets apart, and one
  // this helper can name without spending the package's axis vocabulary. A caller that says
  // nothing gets the first, which is honest only because the specs that do so seed exactly one.
  //
  // ── WHICH ONE, AND WHY THE DECLARED FRAME WINS EVEN OVER AN EXPLICIT `coordinateRows` ──
  //
  // A project may legitimately offer a coordinate set whose rows NO declaration identifies —
  // the shared plottable seed writes exactly one, in a dataset with no key artifact. Framing on
  // THAT one leaves every dependent section correctly empty, which reads downstream like a
  // product defect and is not one.
  //
  // `coordinateRows` cannot be the primary selector, and the reason is a trap this helper walked
  // into once already: `ANCHORED_ROWS` and the plottable seed's row count are BOTH 60, so a
  // row-count regex matches BOTH sets and `.first()` picks by list position. It then passed the
  // witness below — because the bare-frame ▶ now enables on the COORDINATE alone (positions are
  // positions), which is correct product behaviour and precisely why the ▶ stopped witnessing
  // that the ROWS were derived. So the count NARROWS the declared frames; it does not choose
  // between a declared one and an undeclared one.
  //
  // ── AND `coordinateRows` MAY NOT NARROW THE ROWS BY ROW TEXT ──────────────────────────
  //
  // It was written to, and it matched NOTHING. `sharedCoverage` HOISTS a coverage line that is
  // identical on every option ("60 rows · 2D") out of the rows and states it once above the
  // list — the pane's own suppress-what-is-constant rule, working exactly as intended. So a
  // filter looking for `60` inside a row is looking for text the entry deliberately took OUT
  // of the row, and it can never match. Do not re-add it.
  //
  // The DECLARED NAME is the identity here, so it wins outright; `coordinateRows` survives only
  // as the fallback disambiguator for a fixture that seeds no declared frame at all.
  const declared = picker.getByRole('radio', { name: new RegExp(ANCHORED_COORDINATE, 'i') })
  const offered =
    (await declared.count()) > 0
      ? declared
      : opts.coordinateRows !== undefined
        ? picker.getByRole('radio', { name: new RegExp(`\\b${opts.coordinateRows.toLocaleString()}\\b`) })
        : picker.getByRole('radio')
  const chosen = offered.first()
  await expect(chosen).toBeVisible({ timeout: 15_000 })
  await chosen.click()
  await expect(chosen).toBeChecked({ timeout: 30_000 })

  // ── WHAT THIS WAITS ON NOW (ledger #27) ────────────────────────────────────────────────
  //
  // It used to wait for the single foot-of-card ▶ to stop refusing. That control is gone: every
  // row carries its own (the mockup's shape), and a row's ▶ is about THAT row, so it has no
  // pane-wide refusal left to clear.
  //
  // The comment it replaces was already honest that the ▶ had stopped witnessing the ROWS being
  // derived — it enables on the coordinate alone. So the witness is the one fact this helper can
  // actually establish: the radio holds the pick, and the row it belongs to offers its ▶.
  await expect(coordinateEmits(page).first()).toBeVisible({ timeout: 30_000 })
}

/** How many panes the composed canvas currently holds, read from the app's own read-only seam.
 *  The grid is WebGL and a headless browser paints no pixel, so the pane set is asserted where
 *  the pixels come from rather than from a screenshot. */
export async function canvasPanes(page: Page): Promise<Array<{ id: string; viewId: string | null; title: string | null }>> {
  return page.evaluate(() => {
    const read = (window as unknown as { __canvasPanes?: () => Array<Record<string, unknown>> }).__canvasPanes
    return (read ? read() : []).map(p => ({
      id: String(p.id ?? ''),
      viewId: (p.viewId as string | null) ?? null,
      title: (p.title as string | null) ?? null,
    }))
  })
}

// ── THE CONTESTED-NAME PROJECT (the entry section's fixture) ─────────────────────────────────
//
// The entry section lists the entries of the anchored row space's SIBLING axis, so this fixture
// adds the declarations the anchored project has no reason to carry:
//
//   · a KEY artifact for that sibling axis — a real inline-utf8 string column, because the
//     entry keys ARE what the browse list reads and `expect: 'string'` is what the engine
//     declares about them;
//   · TWO annotation columns on the same axis, one of which declares `meta.groups_entries:
//     true` — the producer SAYING what its column is for. That single declaration is what
//     drives the group headings, the contested-row qualifier and the emitted plot's title.
//
// The values source needs no seeding: the shared plottable seed's matrix already declares BOTH
// axes, which is exactly what makes an artifact able to answer *"what is entry X here?"*.
//
// The `Symbol` values are CONTESTED ON PURPOSE — two entries whose displayed name is the same,
// in two different declared groups. That is the CORRECT result rather than a collision, and it
// is what the spec driving this fixture exists to prove.

import { cscArtifact, textColumnArtifact } from '../14-declarative-qc/_fixtures'

/** The sibling axis, taken from the SHIPPED matrix fixture's own declaration rather than
 *  restated: the two must agree or the entries address a different axis, and a literal here
 *  could drift from it silently. */
export const SIBLING_AXIS = ((cscArtifact().structure as { axes: string[] }).axes).find(
  a => a !== ENTITY_AXIS,
) as string

/** The entry keys and the two annotations over them. FIVE, matching the shared matrix's own
 *  column count — a key list of a different length would address the wrong columns. */
export const CONTESTED = {
  keys: ['ent-1', 'ent-2', 'ent-3', 'ent-4', 'ent-5'],
  /** the DISPLAY annotation. `CD3` twice, and one entry with NO value at all — which must show
   *  its key and say the value is absent rather than borrowing another vocabulary. */
  symbol: ['CD3', 'CD3', 'CD19', '', 'PTPRC'],
  /** the GROUPING annotation — the column that declares its own role. */
  panel: ['RNA', 'ADT', 'RNA', 'ADT', 'RNA'],
  symbolTitle: 'Symbol',
  panelTitle: 'Panel',
} as const

/**
 * Seed the anchored project PLUS the sibling axis, its keys and its two annotations — in ONE
 * dataset, which the join requires.
 */
export async function seedContestedEntryProject(
  request: APIRequestContext,
  projectId: string,
): Promise<void> {
  const keys = textColumnArtifact('entry keys', CONTESTED.keys, SIBLING_AXIS)
  const symbol = textColumnArtifact(CONTESTED.symbolTitle, CONTESTED.symbol, SIBLING_AXIS)
  const panel = textColumnArtifact(CONTESTED.panelTitle, CONTESTED.panel, SIBLING_AXIS)
  await seedAnchoredProject(request, projectId, [
    {
      // THE SIBLING AXIS. `meta.is_axis_index` is what makes the server publish it as an axis
      // at all — without it the section resolves none and says so, correctly.
      output_id: 'entry-index',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: { ...keys.structure, key: 'values' },
      meta: { ...keys.meta, is_axis_index: true },
      content: { encoding: 'members', members: keys.members },
    },
    {
      output_id: 'entry-symbol',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: symbol.structure,
      meta: symbol.meta,
      content: { encoding: 'members', members: symbol.members },
    },
    {
      // THE ONE DECLARATION the grouping rests on.
      output_id: 'entry-panel',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: panel.structure,
      meta: { ...panel.meta, groups_entries: true },
      content: { encoding: 'members', members: panel.members },
    },
  ])
}

// ── THE MARKER FIXTURES (INV-9's three surfaces, and INV-1's contested names) ────────────────
//
// Two facts the anchored fixture above cannot express on its own:
//
//   · a MIXED alignment offer. `seedAnchoredProject`'s positions declare no alignment and its
//     columns all declare one, so every candidate frame is A3 and the picker correctly states
//     the fact ONCE on the control instead of per row (ITEM-20's stand-down). Proving the
//     per-candidate mark — and proving the stand-down is a RULE rather than the only state the
//     fixture can reach — needs a second frame that IS aligned.
//   · a CATEGORICAL colouring. The anchored columns are continuous, which renders a visual-map
//     rather than a LEGEND — and the legend is the load-bearing leg of INV-9, because a
//     screenshot crops the chrome and keeps the legend.

// The fixture builder is imported under a NEUTRAL local name: the shared module's own spellings
// are the domain lattice's, and this file is a SHARED HELPER — the domain baseline's house rule is
// that a helper carries ZERO domain tokens, because one token here is a token in every spec that
// imports it.
import {
  zarrClusteringArtifact as categoricalColumnFixture,
  PLOTTABLE_CLUSTERING_COLUMN,
} from '../14-declarative-qc/_fixtures'
import { ownerToken } from '../project/_helpers'
import { BACKEND } from '../_owner'

/** The digest the anchored key artifact declares. Re-exported so a fixture built OUTSIDE this
 *  module can declare alignment to the same row space — the join is on this value. */
export const ANCHORED_KEY_DIGEST = KEY_DIGEST

/** The categorical column name the shared plottable seed uses for its clustering. Re-exported so
 *  a spec names it once. */
export const CATEGORICAL_COLUMN = PLOTTABLE_CLUSTERING_COLUMN

/** An ALIGNED categorical column on the anchored row space — what § Colour by lists under
 *  `Groups`, and what makes an emitted plot render a LEGEND. */
export function categoricalColumn(
  outputId: string,
  label: string,
  /** `rows` mirrors {@link seedAnchoredProject}'s: a column seeded beside a resized frame has to
   *  be the SAME length, or it is a different row space and the canvas draws two populations. */
  options: { aligned?: boolean; rows?: number } = {},
): SeedArtifactSpec {
  const rows = options.rows ?? ANCHORED_ROWS
  const clust = categoricalColumnFixture(rows)
  return {
    output_id: outputId,
    datatype: DT.metadataColumn,
    scope: 'dataset',
    structure: {
      ...clust.structure,
      ...(options.aligned === false ? {} : { aligned_to: KEY_DIGEST }),
    },
    // The producer's declared SUMMARY — the split is a DECLARATION, and a row states its level
    // count from `meta` alone (INV-11).
    meta: {
      name: label,
      title: label,
      kind: 'categorical',
      n_categories: clust.levels.length,
      categories: clust.levels,
      n: rows,
    },
    content: { encoding: 'members', members: clust.members },
  }
}

// ── THE CONTESTED-ROW-SPACE PROJECT (INV-1's fixture) ────────────────────────────────────────
//
// TWO row spaces that a user reads as the same thing: the same axis LABEL, and a column of the
// same NAME on each. Nothing about the two is distinguishable by name — which is the point. They
// differ in the only ways identity is allowed to: their key sequence (hence their
// `content_hash`), their provenance, and their LENGTH.
//
// *"Nothing resolves a column, a coordinate set, an axis, an artifact or an entry by display
// name. Identity is `(artifact, selector)`. A picker may SHOW a name; nothing may KEY on one."*

/** The second row space's key digest — a DIFFERENT sequence, so a different `content_hash`. */
const KEY_DIGEST_B = 'e2e-visualize-row-space-b'
/** Its length. Deliberately unequal to {@link ANCHORED_ROWS}: the length is the column that
 *  proves two same-labelled options are different things (§7.5.2). */
export const CONTESTED_ROWS_B = 40
/** The column name BOTH row spaces carry. */
export const CONTESTED_COLUMN = CATEGORICAL_COLUMN

export interface ContestedRowSpaces {
  /** the dataset backing the row space this spec anchors — the one whose NAME gets renamed. */
  anchoredDatasetId: string
  /** the other one, carrying a same-named column on a different row space. */
  otherDatasetId: string
}

/**
 * Seed TWO row spaces into one project, each in its own dataset (provenance is the dataset's
 * name, so two datasets is what makes two provenances), each carrying a column named
 * {@link CONTESTED_COLUMN}.
 */
export async function seedContestedRowSpaces(
  request: APIRequestContext,
  projectId: string,
  names: { anchored: string; other: string },
): Promise<ContestedRowSpaces> {
  // Row space A — the anchored one. `seedAnchoredProject` seeds the key artifact, the plottable
  // positions and two continuous columns; the categorical column is what both spaces share.
  const anchored = await seedAnchoredProject(
    request,
    projectId,
    [categoricalColumn('cat-a', CONTESTED_COLUMN)],
    names.anchored,
  )

  // Row space B — its own key artifact, its own digest, its own length, and a column with the
  // SAME NAME aligned to it.
  const keysB = entityColumnArtifact(
    'row keys',
    Array.from({ length: CONTESTED_ROWS_B }, (_, i) => i),
    ENTITY_AXIS,
  )
  const colB = categoricalColumnFixture(CONTESTED_ROWS_B)
  const other = await postSeedPlan(request, projectId, {
    dataset: { name: names.other, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'rows-index-b',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keysB.structure, key: 'values', key_sequence_digest: KEY_DIGEST_B },
        meta: { ...keysB.meta, is_axis_index: true },
        content: { encoding: 'members', members: keysB.members },
      },
      {
        output_id: 'cat-b',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...colB.structure, aligned_to: KEY_DIGEST_B },
        meta: {
          name: CONTESTED_COLUMN,
          title: CONTESTED_COLUMN,
          kind: 'categorical',
          n_categories: colB.levels.length,
          categories: colB.levels,
          n: CONTESTED_ROWS_B,
        },
        content: { encoding: 'members', members: colB.members },
      },
    ],
  })
  return {
    anchoredDatasetId: anchored.dataset_id,
    otherDatasetId: other.dataset_id as string,
  }
}

/** Rename a dataset through the shipped affordance (`PUT /api/datasets/{id}`, `Dataset.rename`).
 *  The rename publishes `Dataset`/`Update`, which the workbench's catalog invalidation turns into
 *  a live re-read — so the pane learns the new name WITHOUT a reload, which is what lets a spec
 *  watch an already-open pane across it. */
export async function renameDataset(request: APIRequestContext, datasetId: string, name: string): Promise<void> {
  const token = await ownerToken(request)
  const r = await request.put(`${BACKEND}/api/datasets/${datasetId}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  })
  expect(r.ok(), `rename dataset failed (${r.status()}): ${await r.text()}`).toBeTruthy()
}

/** The full pane read — `id`/`title` plus the fields that say WHAT a pane plots: the viz dataset
 *  identity it is filed under and its RESOLVED per-channel bindings. A name is display; these are
 *  the identity, and they are what must not move when a label does. */
export async function canvasPanesFull(page: Page): Promise<
  Array<{ id: string; title: string | null; datasetKey: string | null; rows: number | null; bindings: unknown }>
> {
  return page.evaluate(() => {
    const read = (window as unknown as { __canvasPanes?: () => Array<Record<string, unknown>> }).__canvasPanes
    return (read ? read() : []).map(p => ({
      id: String(p.id ?? ''),
      title: (p.title as string | null) ?? null,
      datasetKey: (p.datasetKey as string | null) ?? null,
      rows: (p.rows as number | null) ?? null,
      bindings: p.bindings ?? null,
    }))
  })
}

// ── THE MOCKUP'S OWN SHAPE: several populations, every one of them plottable ────────────
//
// `docs/design/visualize-pane-mockup.html`'s Row space block lists three things a person would
// PLOT — two sources and their integration. That is what the fixture below builds, and the
// distinction from `seedContestedRowSpaces` is exactly the defect this round fixed: there, the
// second row space carries a COLUMN and no positions, so no picture can be drawn on it and it
// is (correctly) not a row space at all.

import {
  categoricalColumnArtifact,
  DT_POSITIONS,
  positionsArtifact,
  wideComponentsArtifact,
  zarrArrayMembers,
} from '../14-declarative-qc/_fixtures'

// ── THE SUBSET COORDINATE (dimension-membership ITEM-21) ─────────────────────────────────────
//
// The shape the whole round exists for, and the one no fixture in this tier could express: a
// coordinate whose positions are a SUBSET of their axis, beside columns that describe the WHOLE
// axis. Their lengths differ, so painting one on the other addresses row *i* of the population
// where row *i* of the subset was meant — the off-by-thousands paint the model makes impossible.
//
// It is OPT-IN on {@link PopulationSeed}, and the default is byte-identical to what this helper
// seeded before. That is not politeness: TEST-54's premise is a project seeded ENTIRELY with
// pre-membership artifacts, and it is this same helper's default that supplies it. A fixture
// that grew a membership by default would have made the legacy test un-writable here and
// silently changed what `frame-gate.spec.ts` measures.

/**
 * The inline member set (ITEM-5's `bitmap`) — the exact inverse of
 * `txr_zarr.encode_member_set`, and the fixture side of the codec `decodeMemberSet` reads.
 *
 * Base64 over a DELTA-VARINT (LEB128): each position stored as its gap from the previous one,
 * each gap as a base-128 varint, `previous` starting at -1 so the first gap is `p + 1`.
 *
 * It REFUSES a non-ascending or negative set, exactly as the producer does. A fixture that
 * silently encoded an unordered set would produce a blob the consumer decodes into a plausible
 * WRONG set — the one failure mode this whole encoding is ordered to prevent — and the fixture
 * would be the thing certifying it.
 */
export function encodeMemberSet(positions: readonly number[]): string {
  const out: number[] = []
  let previous = -1
  for (const value of positions) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`a member position is an index, not ${value}`)
    }
    if (value <= previous) {
      throw new Error(`member positions must be STRICTLY ASCENDING — ${value} follows ${previous}`)
    }
    let gap = value - previous
    previous = value
    while (gap >= 0x80) {
      out.push((gap & 0x7f) | 0x80)
      gap >>>= 7
    }
    out.push(gap)
  }
  return Buffer.from(Uint8Array.from(out)).toString('base64')
}

/** One row in every {@link SUBSET_STRIDE} of the population's axis is a member of the subset
 *  coordinate. NON-CONTIGUOUS on purpose: a contiguous prefix is exactly the set a broken
 *  gather that simply truncates the parent would also produce, so it could not tell the two
 *  apart. */
export const SUBSET_STRIDE = 5

/** The member positions of a population's subset coordinate — every {@link SUBSET_STRIDE}-th
 *  row of the axis, ascending. */
export function subsetMembers(rows: number): number[] {
  const out: number[] = []
  for (let i = 0; i < rows; i += SUBSET_STRIDE) out.push(i)
  return out
}

/** The Zarr member the subset coordinate's index BODY lands in. Its name is the producer's to
 *  choose (ITEM-3 / DRIFT-1.7), so the fixture chooses one and DECLARES it on the entry rather
 *  than assuming a fixed one. */
const MEMBER_INDEX = 'membership_index'

/** The declared display names the subset fixture writes. Named here so a spec spells each once. */
export const SUBSET = {
  /** the subset coordinate itself — what § Coordinates lists beside the whole-axis one.
   *  Deliberately NOT a superstring of the whole-axis one's name (`projection`): a spec picking
   *  by a name that CONTAINS the other's would match both and the click would be a coin toss. */
  coordinate: 'subset frame',
  /** the whole-axis CONTINUOUS column `seedPopulations` already seeds. Offered against the
   *  subset (it describes every one of its rows) and PAINTED through the gather. */
  full: 'metric one',
  /** a whole-axis CATEGORICAL column, so the painted buffer has a PARTITION to be right or
   *  wrong about rather than only a length. */
  legend: 'subset legend',
  /** same axis, DECLARED members, and they intersect the coordinate's — offered. The positive
   *  control that stops "absent" meaning "the list never rendered" (TEST-25). */
  intersecting: 'overlapping population',
  /** same axis, DECLARED members, and PROVABLY none of the coordinate's — A4, never offered. */
  disjoint: 'other population',
} as const

/** The two declared levels of {@link SUBSET.legend}. */
export const SUBSET_LEVELS = ['first', 'second'] as const

/**
 * The legend column's code at axis position `i`.
 *
 * Chosen so the GATHERED reading and a truncating one are distinguishable BY PARTITION, not
 * merely by length: on the member positions the codes alternate (an even split), and everywhere
 * else they are constant. A gather that read the parent's first *K* rows instead would produce
 * the same two levels in a lopsided split, so a test asserting "two colours" would pass for it
 * and a test asserting the SPLIT will not.
 */
export function subsetLegendCode(i: number): number {
  return i % SUBSET_STRIDE === 0 ? Math.floor(i / SUBSET_STRIDE) % 2 : 0
}

/** One seeded population: a dataset name, a row count, and positions DECLARING that they rest
 *  on this population's rows. */
export interface PopulationSeed {
  name: string
  rows: number
  /**
   * ALSO publish a coordinate that is a SUBSET of this population's axis (ITEM-21), together
   * with the columns that make the subset's offer decidable: a whole-axis categorical, a
   * same-axis column whose members INTERSECT the coordinate's, and one whose members are
   * provably DISJOINT from them.
   *
   * Absent ⇒ this population is seeded exactly as it was before this round: scalar
   * `aligned_to`, no `memberships`, no index body. That is TEST-54's fixture, and it is the
   * default so that it cannot drift.
   */
  subset?: boolean
}

/**
 * Seed N populations, each its own dataset with its own key artifact, ONE aligned column and
 * ONE aligned set of positions.
 *
 * The positions declare `aligned_to` — unlike `seedPlottableProject`'s, which declare nothing.
 * That is deliberate and is what the candidacy rule turns on: a producer that declares no
 * alignment leaves candidacy UNDECIDED (every axis offered, and the control says so), and the
 * real importer does declare it.
 */
export async function seedPopulations(
  request: APIRequestContext,
  projectId: string,
  populations: readonly PopulationSeed[],
): Promise<void> {
  for (const [i, population] of populations.entries()) {
    const digest = `e2e-population-${i}`
    const keys = entityColumnArtifact('row keys', Array.from({ length: population.rows }, (_, k) => k), ENTITY_AXIS)
    const column = entityColumnArtifact(
      'metric one',
      Array.from({ length: population.rows }, (_, k) => k % 10),
      ENTITY_AXIS,
    )
    const positions = positionsArtifact(population.rows)
    await postSeedPlan(request, projectId, {
      dataset: { name: population.name, datatype: DT.expression },
      artifacts: [
        {
          output_id: `keys-${i}`,
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
          meta: { ...keys.meta, is_axis_index: true },
          content: { encoding: 'members', members: keys.members },
        },
        {
          output_id: `positions-${i}`,
          datatype: DT_POSITIONS,
          scope: 'dataset',
          structure: { ...positions.structure, aligned_to: digest },
          meta: { name: 'projection' },
          content: { encoding: 'members', members: positions.members },
        },
        {
          output_id: `column-${i}`,
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...column.structure, aligned_to: digest },
          meta: { ...column.meta, kind: 'continuous', min: 0, max: 9, n: population.rows },
          content: { encoding: 'members', members: column.members },
        },
        ...(population.subset === true ? subsetArtifacts(i, digest, population.rows) : []),
      ],
    })
  }
}

/**
 * The SUBSET half of {@link seedPopulations} — the coordinate and the three columns that make
 * its offer decidable. Written as a producer writes them (`txr_zarr.Table.close()`):
 *
 *   · the index BODY is a Zarr member of the coordinate artifact, and it is declared ON THE
 *     MEMBERSHIP ENTRY (`members` names it, `path` addresses it) and NOWHERE ELSE. It is
 *     deliberately absent from `columns`/`arrays` — the producer's own comment says why, and a
 *     fixture that listed it there would be agreeing with a reader that the producer disagrees
 *     with, which is precisely the disagreement an e2e is for.
 *   · the coordinate declares `memberships` and NOT the scalar `aligned_to`: it is not aligned
 *     to the whole axis, and saying both would be the contradiction the writer refuses.
 */
function subsetArtifacts(i: number, digest: string, rows: number): SeedArtifactSpec[] {
  const members = subsetMembers(rows)
  const k = members.length
  const positions = positionsArtifact(k)
  const legend = categoricalColumnArtifact(
    SUBSET.legend,
    [...SUBSET_LEVELS],
    Array.from({ length: rows }, (_, r) => subsetLegendCode(r)),
    ENTITY_AXIS,
  )
  // INTERSECTING: the first half of the coordinate's OWN members, so the intersection is
  // non-empty and provable from the two inline sets alone.
  const intersecting = members.slice(0, Math.max(1, Math.floor(k / 2)))
  // DISJOINT: the positions the stride steps OVER. `i % STRIDE === 1` shares no element with
  // `i % STRIDE === 0`, and both sets are declared, so A4 is PROVEN rather than assumed.
  const disjoint: number[] = []
  for (let r = 1; r < rows; r += SUBSET_STRIDE) disjoint.push(r)

  const memberColumn = (name: string, positionsOfIt: readonly number[]): SeedArtifactSpec => {
    const col = entityColumnArtifact(
      name,
      positionsOfIt.map((_, n) => n % 10),
      ENTITY_AXIS,
    )
    return {
      output_id: `${name}-${i}`,
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: {
        ...col.structure,
        memberships: [
          {
            aligned_to: digest,
            axis: ENTITY_AXIS,
            kind: 'subset',
            n_members: positionsOfIt.length,
            bitmap: encodeMemberSet(positionsOfIt),
          },
        ],
      },
      meta: { ...col.meta, kind: 'continuous', min: 0, max: 9, n: positionsOfIt.length },
      content: { encoding: 'members', members: col.members },
    }
  }

  return [
    {
      output_id: `subset-positions-${i}`,
      datatype: DT_POSITIONS,
      scope: 'dataset',
      structure: {
        ...positions.structure,
        memberships: [
          {
            aligned_to: digest,
            axis: ENTITY_AXIS,
            kind: 'subset',
            n_members: k,
            members: MEMBER_INDEX,
            path: MEMBER_INDEX,
            bitmap: encodeMemberSet(members),
          },
        ],
      },
      meta: { name: SUBSET.coordinate },
      content: {
        encoding: 'members',
        members: [
          ...positions.members,
          // ONE chunk — the index body IS the gather list and is read whole (`readMemberIndex`),
          // which is how the producer declares it too.
          ...zarrArrayMembers(MEMBER_INDEX, [...members], {
            encoding: 'u32',
            dtype: 'uint32',
            chunk: k,
          }),
        ],
      },
    },
    {
      output_id: `subset-legend-${i}`,
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: { ...legend.structure, aligned_to: digest },
      meta: {
        name: SUBSET.legend,
        title: SUBSET.legend,
        kind: 'categorical',
        n_categories: SUBSET_LEVELS.length,
        categories: [...SUBSET_LEVELS],
        n: rows,
      },
      content: { encoding: 'members', members: legend.members },
    },
    memberColumn(SUBSET.intersecting, intersecting),
    memberColumn(SUBSET.disjoint, disjoint),
  ]
}

/**
 * Seed a population whose SECOND axis bears nothing plottable — the shipped defect's own
 * shape, in neutral vocabulary: one dataset publishing two axes, positions on the first only.
 *
 * The second axis is not empty. It carries a real, ordinary column, which is why "positions OR
 * columns" would not have narrowed anything.
 */
export async function seedOnePopulationTwoAxes(
  request: APIRequestContext,
  projectId: string,
  name: string,
  rows = 40,
  otherRows = 120,
): Promise<void> {
  const digest = 'e2e-single-population'
  const otherDigest = 'e2e-single-population-other'
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const otherKeys = entityColumnArtifact('other keys', Array.from({ length: otherRows }, (_, k) => k), ENTITY_AXIS)
  const column = entityColumnArtifact('metric one', Array.from({ length: rows }, (_, k) => k % 10), ENTITY_AXIS)
  const otherColumn = entityColumnArtifact(
    'other metric',
    Array.from({ length: otherRows }, (_, k) => k % 7),
    ENTITY_AXIS,
  )
  const positions = positionsArtifact(rows)
  await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'keys-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'keys-other',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...otherKeys.structure, key: 'values', key_sequence_digest: otherDigest },
        meta: { ...otherKeys.meta, is_axis_index: true },
        content: { encoding: 'members', members: otherKeys.members },
      },
      {
        output_id: 'positions-primary',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...positions.structure, aligned_to: digest },
        meta: { name: 'projection' },
        content: { encoding: 'members', members: positions.members },
      },
      {
        output_id: 'column-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...column.structure, aligned_to: digest },
        meta: { ...column.meta, kind: 'continuous', min: 0, max: 9, n: rows },
        content: { encoding: 'members', members: column.members },
      },
      {
        output_id: 'column-other',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...otherColumn.structure, aligned_to: otherDigest },
        meta: { ...otherColumn.meta, kind: 'continuous', min: 0, max: 6, n: otherRows },
        content: { encoding: 'members', members: otherColumn.members },
      },
    ],
  })
}

/**
 * THE REAL IMPORTED SHAPE, in neutral vocabulary: ONE dataset publishing TWO axes, with
 * columns on both, positions on one — and a column of each kind the importer really emits.
 *
 * It is the fixture for the second half of the reported defect: § Colour by was listing the
 * OTHER axis's columns (one value per entry of a different axis — they cannot colour these
 * rows) and the two KEY artifacts (the axes themselves), all of them marked "alignment not
 * declared".
 */
export async function seedTwoAxisShape(request: APIRequestContext, projectId: string, name: string): Promise<void> {
  const PRIMARY = 'e2e-two-axis-primary'
  const OTHER = 'e2e-two-axis-other'
  const rows = 40
  const otherRows = 120
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const otherKeys = entityColumnArtifact('entry keys', Array.from({ length: otherRows }, (_, k) => k), 'others')
  const onAnchor = entityColumnArtifact('grouping', Array.from({ length: rows }, (_, k) => k % 4), ENTITY_AXIS)
  const declared = entityColumnArtifact('declared elsewhere', Array.from({ length: otherRows }, (_, k) => k % 3), 'others')
  const undeclared = entityColumnArtifact('undeclared elsewhere', Array.from({ length: otherRows }, (_, k) => k % 3), 'others')
  const positions = positionsArtifact(rows)
  await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'keys-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: PRIMARY },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'keys-other',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...otherKeys.structure, key: 'values', key_sequence_digest: OTHER },
        meta: { ...otherKeys.meta, is_axis_index: true },
        content: { encoding: 'members', members: otherKeys.members },
      },
      {
        output_id: 'positions-primary',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...positions.structure, aligned_to: PRIMARY },
        meta: { name: 'projection' },
        content: { encoding: 'members', members: positions.members },
      },
      {
        // ON the anchored rows. The one column that may be offered.
        output_id: 'col-anchor',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...onAnchor.structure, aligned_to: PRIMARY },
        meta: { ...onAnchor.meta, kind: 'categorical', n_categories: 4, n: rows },
        content: { encoding: 'members', members: onAnchor.members },
      },
      {
        // On the OTHER axis, DECLARING that alignment. A2 by digest — dropped before this round.
        output_id: 'col-other-declared',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...declared.structure, aligned_to: OTHER },
        meta: { ...declared.meta, kind: 'categorical', n_categories: 3, n: otherRows },
        content: { encoding: 'members', members: declared.members },
      },
      {
        // On the OTHER axis, declaring only WHICH AXIS. This is the one that used to be
        // offered and marked: its alignment was never unknown, it was known and elsewhere.
        output_id: 'col-other-undeclared',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...undeclared.structure },
        meta: { ...undeclared.meta, kind: 'categorical', n_categories: 3, n: otherRows },
        content: { encoding: 'members', members: undeclared.members },
      },
    ],
  })
}

// ── THE OWNER'S REAL SHAPE, and the two-dataset shape beside it ────────────────────────
//
// The pane's first block is § Coordinates and it lists with nothing chosen first, so the two
// fixtures the gate needs are about WHAT IS OFFERED THERE, not about anything an anchor once
// asked. Both are seeded through the same plan endpoint as everything else in this file.

/**
 * ONE dataset · TWO axes · NO `aligned_to` anywhere · one 2-D coordinate set and one that
 * declares MORE than two components.
 *
 * This is the shape the owner actually has on screen, and every clause of it is load-bearing:
 *
 *  · **no `aligned_to`** — the data was imported before the importer stamped it. A previous fix
 *    to this pane worked only for correctly-declared data and therefore changed nothing on the
 *    owner's screen. So the fixture declares NONE, and the derivation of which rows the pane is
 *    about has to reach the answer from the artifact's own axis label and source dataset.
 *  · **two axes** — one imported file publishes an axis per entity kind, so this is the project
 *    where an axis-offering control had two things to offer. Nothing may offer either.
 *  · **a >2-D set** — the one that must be ABSENT from § Coordinates, with no component picker
 *    and no "first two" default.
 */
/** The producer-declared display NAMES the fixture below writes, exported so a spec asserts
 *  against the declaration rather than re-typing it: `flat` is the 2-D set that MUST be offered,
 *  `wide` the >2-D one that must NOT be. */
export const UNDECLARED_COORDS = { flat: 'projection', wide: 'decomposition' } as const

export async function seedUndeclaredOneDatasetTwoAxes(
  request: APIRequestContext,
  projectId: string,
  name: string,
  rows = 40,
  otherRows = 120,
): Promise<void> {
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const otherKeys = entityColumnArtifact('entry keys', Array.from({ length: otherRows }, (_, k) => k), 'others')
  const column = entityColumnArtifact('metric one', Array.from({ length: rows }, (_, k) => k % 10), ENTITY_AXIS)
  const flat = positionsArtifact(rows)
  const wide = wideComponentsArtifact(rows, 50)
  await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        // The two KEY artifacts — the axes themselves. They declare a key sequence (that is
        // what makes them axes) and DELIBERATELY no alignment.
        output_id: 'keys-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: 'e2e-undeclared-primary' },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'keys-other',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...otherKeys.structure, key: 'values', key_sequence_digest: 'e2e-undeclared-other' },
        meta: { ...otherKeys.meta, is_axis_index: true },
        content: { encoding: 'members', members: otherKeys.members },
      },
      {
        // 2-D. OFFERED. No `aligned_to`.
        output_id: 'positions-flat',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: flat.structure,
        meta: { name: UNDECLARED_COORDS.flat },
        content: { encoding: 'members', members: flat.members },
      },
      {
        // 50 components. NOT OFFERED. Same datatype, same capability, same axis — the ONLY
        // difference is the declared width, which is what makes this a controlled negative.
        output_id: 'positions-wide',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: wide.structure,
        meta: { name: UNDECLARED_COORDS.wide },
        content: { encoding: 'members', members: wide.members },
      },
      {
        output_id: 'column-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: column.structure,
        meta: { ...column.meta, kind: 'continuous', min: 0, max: 9, n: rows },
        content: { encoding: 'members', members: column.members },
      },
    ],
  })
}

/** TWO datasets, each carrying ONE 2-D coordinate set — the shape where § Coordinates MUST
 *  draw a heading per dataset, and the positive control for the one-dataset case above. */
export async function seedTwoDatasetsOneCoordinateEach(
  request: APIRequestContext,
  projectId: string,
  names: readonly string[],
  rows = 40,
): Promise<void> {
  for (const [i, name] of names.entries()) {
    const digest = `e2e-two-datasets-${i}`
    const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
    const flat = positionsArtifact(rows)
    await postSeedPlan(request, projectId, {
      dataset: { name, datatype: DT.expression },
      artifacts: [
        {
          output_id: `keys-${i}`,
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
          meta: { ...keys.meta, is_axis_index: true },
          content: { encoding: 'members', members: keys.members },
        },
        {
          output_id: `positions-${i}`,
          datatype: DT_POSITIONS,
          scope: 'dataset',
          structure: { ...flat.structure, aligned_to: digest },
          meta: { name: 'projection' },
          content: { encoding: 'members', members: flat.members },
        },
      ],
    })
  }
}

/**
 * THE LEGITIMATE CROSS-DATASET SHAPE — coordinates in one dataset, columns in another, and a
 * DECLARED link between them.
 *
 * This exists because the fix that made `seedAnchoredProject` honest could easily have thrown
 * the good case out with the bad one. The two look superficially identical — a coordinate set
 * and a column that do not share a dataset — and the difference is the whole rule:
 *
 *   · UNDECLARED (what `seedPlottableProject` writes: positions in a dataset with no key
 *     artifact) ⇒ nothing says which rows those points are, so no column may be offered
 *     against them. The old pane let the USER assert that bridge; that is the defect.
 *   · DECLARED (this fixture, and what a real integration writes) ⇒ the producer stamped
 *     `aligned_to` with the key sequence, so the link is DATA and the columns ARE offered.
 *
 * A declared bridge is data; a user-asserted bridge is a guess wearing a UI. The integration
 * scenario the owner's mockup shows — a merged population whose columns live elsewhere — is
 * this one, and it must keep working.
 *
 * Two datasets: the first carries the KEYS + the columns, the second carries ONLY the
 * coordinates, declaring the first's key sequence.
 */
export async function seedDeclaredCrossDatasetFrame(
  request: APIRequestContext,
  projectId: string,
  names: { rows: string; frame: string },
  /** WITHHOLD the declaration — the NEGATIVE control. The two calls differ in exactly one
   *  field, which is what makes the pair evidence rather than two anecdotes: anything that
   *  excluded the undeclared case for some OTHER reason would pass a sloppier fixture. */
  opts: { declared?: boolean } = {},
  rows = ANCHORED_ROWS,
): Promise<void> {
  const declared = opts.declared !== false
  const digest = 'e2e-declared-cross-dataset'
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const column = entityColumnArtifact(
    ANCHORED_COLUMN.first,
    Array.from({ length: rows }, (_, k) => k % 10),
    ENTITY_AXIS,
  )
  await postSeedPlan(request, projectId, {
    dataset: { name: names.rows, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'x-keys',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'x-column',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...column.structure, aligned_to: digest },
        meta: { ...column.meta, kind: 'continuous', min: 0, max: 9, n: rows },
        content: { encoding: 'members', members: column.members },
      },
    ],
  })

  const positions = positionsArtifact(rows)
  await postSeedPlan(request, projectId, {
    dataset: { name: names.frame, datatype: DT.expression },
    artifacts: [
      {
        // A DIFFERENT dataset, and the link is DECLARED. This is the whole fixture.
        output_id: 'x-positions',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: declared ? { ...positions.structure, aligned_to: digest } : { ...positions.structure },
        meta: { name: ANCHORED_COORDINATE },
        content: { encoding: 'members', members: positions.members },
      },
    ],
  })
}

// ── THE OWNER'S IMPORTED SHAPE — the DEFAULT shape the Visualize specs run against ──────────
//
// Every fixture above is WELL DECLARED, and that is why three successive fixes to this pane
// passed their tests and changed nothing on the owner's screen (ledger #21/#22). This one is
// built from the negatives instead — it declares only what the producer that wrote the owner's
// project actually declared, which is less than the current one does:
//
//   · **no `aligned_to`, anywhere.** The importer gained that declaration after this project was
//     imported, so every join in the pane has to be reached from the artifact's own axis label
//     and source dataset — the FALLBACK path, which is the only path this data can take.
//   · **TWO artifacts declaring the SAME axis's key sequence, and only ONE of them saying it IS
//     the axis.** The importer emits the canonical index (`meta.is_axis_index`) AND a second
//     per-row identifier column that truthfully declares it CARRIES those keys
//     (`structure.key_sequence_digest`) while deliberately not claiming to be the axis. Every
//     other fixture writes exactly one keys-declaring artifact per axis, so the pair — which
//     every real import produces — was never seen by a test. It is what made the derivation
//     ambiguous and left both dependent sections empty (#22).
//   · **every coordinate set declares the DATATYPE WORD as its name** (`meta.name` = the
//     datatype id) and declares NEITHER `meta.source_key` NOR `meta.method` — the state that put
//     N rows reading one word in front of the owner (#11/#17). The importer derives the real
//     names now; this project predates that, so the honest answer here is the opaque identity,
//     never an invented name.
//   · **one dataset, two axes**, with columns on both and an expression matrix declaring the
//     pair — so BOTH dependent sections are scoped by the coordinate pick, which is the act the
//     owner reports as doing nothing.
export const OWNER_SHAPE = {
  /** how many coordinate sets the fixture writes — MORE THAN ONE, because "always select the
   *  first" (#24) and "a hundred must not all read alike" (#17) are both claims about a list. */
  coordinateSets: 3,
  rows: 40,
  entries: 5,
  /** the declared display name EVERY coordinate set carries: the artifact's own datatype word,
   *  which is what makes it no name at all. Taken FROM the datatype id rather than spelled, so
   *  this file states the relation and never the vocabulary. */
  declaredName: DT_POSITIONS,
  /** the two per-row columns the colouring section must list once a set is picked. */
  columns: { categorical: 'grouping', continuous: 'metric one' },
  /** the declared display name of the >2-D set — the one that must NOT be offered, with no
   *  component picker and no "first two" default. A real import writes one of these on every
   *  project, so it belongs in the default shape rather than in a fixture of its own. */
  wideName: 'decomposition',
} as const

/** The key sequences the two axes store. Declared by the axis AND by its identifier twin —
 *  which is the fixture's subject: they are the same sequence, so both artifacts declare the
 *  same digest, exactly as one import writes them. */
const OWNER_ROW_DIGEST = 'owner-imported-rows'
const OWNER_ENTRY_DIGEST = 'owner-imported-entries'

export async function seedOwnerImportedShape(
  request: APIRequestContext,
  projectId: string,
  name: string,
  /**
   * The ROW COUNT and the coordinate member's inner CHUNK, both defaulted to the shape every
   * existing caller already gets. They are parameters because the streaming specs (TESTS.md
   * TEST-13/14/24) need to control ARRIVAL: the app's per-chunk progress channel and the coverage
   * indicator both key off how many chunks a read arrives in, and a fixture that is always
   * multi-chunk cannot express the single-chunk case the indicator must stay ABSENT for.
   *
   * Defaults preserved deliberately — every other spec in this directory reads
   * `OWNER_SHAPE.rows`, so changing the default here would move assertions in files that have
   * nothing to do with streaming.
   */
  opts: { rows?: number; chunkRows?: number } = {},
): Promise<SeedEngineResponse> {
  const rows = opts.rows ?? OWNER_SHAPE.rows
  const nEntries = OWNER_SHAPE.entries
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const entryKeys = textColumnArtifact(
    'entry keys',
    Array.from({ length: nEntries }, (_, k) => `ent-${k + 1}`),
    SIBLING_AXIS,
  )
  const identifiers = textColumnArtifact(
    'row identifier',
    Array.from({ length: rows }, (_, k) => `row-${k + 1}`),
    ENTITY_AXIS,
  )
  const entryNames = textColumnArtifact(
    'Symbol',
    Array.from({ length: nEntries }, (_, k) => `SYM${k + 1}`),
    SIBLING_AXIS,
  )
  const grouping = entityColumnArtifact(
    OWNER_SHAPE.columns.categorical,
    Array.from({ length: rows }, (_, k) => k % 4),
    ENTITY_AXIS,
  )
  const metric = entityColumnArtifact(
    OWNER_SHAPE.columns.continuous,
    Array.from({ length: rows }, (_, k) => k % 10),
    ENTITY_AXIS,
  )
  const wide = wideComponentsArtifact(rows, 50)
  const matrix = cscArtifact(rows, nEntries)
  return await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        // THE AXIS — the artifact whose producer SAYS it is one.
        output_id: 'owner-keys-rows',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: OWNER_ROW_DIGEST },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        // ITS TWIN, and the whole point of this fixture: a per-row identifier column whose
        // VALUES are that same key sequence, so it declares the digest — and which carries no
        // `meta.is_axis_index`, because it is not the axis. The importer emits exactly this
        // pair on every run, and it is the pair a derivation keying on the digest alone reads
        // as two axes.
        output_id: 'owner-row-identifier',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...identifiers.structure, key: 'values', key_sequence_digest: OWNER_ROW_DIGEST },
        meta: { ...identifiers.meta },
        content: { encoding: 'members', members: identifiers.members },
      },
      {
        output_id: 'owner-keys-entries',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...entryKeys.structure, key: 'values', key_sequence_digest: OWNER_ENTRY_DIGEST },
        meta: { ...entryKeys.meta, is_axis_index: true },
        content: { encoding: 'members', members: entryKeys.members },
      },
      // THE COORDINATE SETS — same datatype, same axis, same declared name, no distinguisher.
      ...Array.from({ length: OWNER_SHAPE.coordinateSets }, (_, i) => {
        const positions = positionsArtifact(rows, opts.chunkRows)
        return {
          output_id: `owner-positions-${i}`,
          datatype: DT_POSITIONS,
          scope: 'dataset' as const,
          structure: { ...positions.structure },
          meta: { name: OWNER_SHAPE.declaredName },
          content: { encoding: 'members' as const, members: positions.members },
        }
      }),
      {
        // >2-D: same datatype, same capability, same axis, and NOT offered. The only difference
        // is the declared width, which is what makes it a controlled negative rather than a
        // second shape that might be excluded for some other reason.
        output_id: 'owner-positions-wide',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...wide.structure },
        meta: { name: OWNER_SHAPE.wideName },
        content: { encoding: 'members', members: wide.members },
      },
      {
        output_id: 'owner-col-categorical',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...grouping.structure },
        meta: { ...grouping.meta, kind: 'categorical', n_categories: 4, n: rows },
        content: { encoding: 'members', members: grouping.members },
      },
      {
        output_id: 'owner-col-continuous',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...metric.structure },
        meta: { ...metric.meta, kind: 'continuous', min: 0, max: 9, n: rows },
        content: { encoding: 'members', members: metric.members },
      },
      {
        output_id: 'owner-entry-names',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...entryNames.structure },
        meta: { ...entryNames.meta },
        content: { encoding: 'members', members: entryNames.members },
      },
      {
        // The values an ENTRY row plots — a matrix declaring BOTH axes, with no alignment
        // declaration of its own.
        output_id: 'owner-matrix',
        datatype: DT.expression,
        scope: 'dataset',
        structure: { ...matrix.structure },
        meta: { name: 'counts' },
        content: { encoding: 'members', members: matrix.members },
      },
    ],
  })
}

// ── THE FUSION PAIR (dimension-membership ITEM-32 / TEST-41) ──────────────────────────────────
//
// TWO datasets whose columns rest on the SAME entity axis (they declare the same
// `key_sequence_digest`), each carrying a categorical column of the SAME NAME. One dataset also
// carries the axis KEY and a coordinate, so § Colour by has a frame to offer both columns against.
//
// Whether the two same-named columns FUSE into one offer is decided by their VOCABULARIES, never
// by their name (`vocabFusion.ts`): reconcilable ⇒ ONE offer that names BOTH datasets; conflicting
// ⇒ TWO offers. The two arms differ ONLY in the second column's declared level set, which is what
// makes them a controlled pair — anything that fused (or split) for another reason would not flip
// between them.

export const FUSION = {
  /** the same-named categorical column each dataset carries — the subject of the fusion. */
  column: 'group label',
  /** the coordinate the pair is offered against. */
  coordinate: 'integration frame',
  datasetA: 'Reference',
  datasetB: 'Query',
  /** the level set dataset A declares. */
  levels: ['red', 'green', 'blue'] as const,
} as const

/** Seed the fusion pair. `reconcilable` ⇒ B declares the SAME level set as A (they fuse);
 *  otherwise B declares a DISJOINT set (they must not). */
export async function seedFusionPair(
  request: APIRequestContext,
  projectId: string,
  reconcilable: boolean,
  rows = 40,
): Promise<void> {
  const digest = 'e2e-fusion-shared-axis'
  const keys = entityColumnArtifact('row keys', Array.from({ length: rows }, (_, k) => k), ENTITY_AXIS)
  const positions = positionsArtifact(rows)
  const levelsA = [...FUSION.levels]
  const levelsB = reconcilable ? [...FUSION.levels] : ['crimson', 'amber', 'violet']
  const categorical = (name: string, levels: readonly string[]) => {
    const col = categoricalColumnArtifact(name, levels, Array.from({ length: rows }, (_, r) => r % levels.length), ENTITY_AXIS)
    return {
      structure: { ...col.structure, aligned_to: digest },
      // A COMPLETE declared preview (`categories.length === n_categories`) is what lets
      // `reconcileVocabularies` compare the two vocabularies at all (`vocabFusion.ts` refuses a
      // capped preview) — so the fixture declares the whole set, which a real producer does.
      meta: { name, title: name, kind: 'categorical', n_categories: levels.length, categories: [...levels], n: rows },
      content: { encoding: 'members' as const, members: col.members },
    }
  }
  // Dataset A: carries the axis key + the coordinate + column A.
  const a = categorical(FUSION.column, levelsA)
  await postSeedPlan(request, projectId, {
    dataset: { name: FUSION.datasetA, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'fusion-keys',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keys.structure, key: 'values', key_sequence_digest: digest },
        meta: { ...keys.meta, is_axis_index: true },
        content: { encoding: 'members', members: keys.members },
      },
      {
        output_id: 'fusion-positions',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...positions.structure, aligned_to: digest },
        meta: { name: FUSION.coordinate },
        content: { encoding: 'members', members: positions.members },
      },
      { output_id: 'fusion-col-a', datatype: DT.metadataColumn, scope: 'dataset', ...a },
    ],
  })
  // Dataset B: ONE same-named column, aligned to the SAME axis — offered across datasets exactly
  // as `seedDeclaredCrossDatasetFrame` demonstrates.
  const b = categorical(FUSION.column, levelsB)
  await postSeedPlan(request, projectId, {
    dataset: { name: FUSION.datasetB, datatype: DT.expression },
    artifacts: [{ output_id: 'fusion-col-b', datatype: DT.metadataColumn, scope: 'dataset', ...b }],
  })
}

// ── THE INTEGRATED COORDINATE (dimension-membership ITEM-8/16/19 / TEST-24/46/51/52) ──────────
//
// TWO datasets, each publishing its OWN entity axis, and ONE coordinate that rests on BOTH — an
// INTEGRATED coordinate declares a membership PER axis (INV-1). Its rows are a CORRESPONDENCE
// (INV-6): row r is entry `memA[r]` of dataset A AND entry `memB[r]` of dataset B, and the two
// index bodies are DIFFERENT permutations so that `memA[r] ≠ memB[r]` — an index-identity gather
// returns a full, well-typed, wrong column and is caught.
//
// The membership ARRAY order is the coordinate's declared SEGMENT ORDER (INV-7); `reversed` flips
// it, which a faithful gather reflects in the painted sequence and a fixed/sorted one does not.

export const INTEGRATED = {
  coordinate: 'integration',
  datasetA: 'Reference',
  datasetB: 'Query',
  /** the CATEGORICAL column on each side — its level at an entry is what paints, so a wrong index
   *  paints a wrong level. */
  columnA: 'ref cluster',
  columnB: 'query cluster',
  levels: ['alpha', 'beta', 'gamma', 'delta'] as const,
  /** the coordinate's row count (member count on each axis). */
  rows: 12,
  /** the parent axis lengths — larger than `rows`, so the coordinate is a genuine SUBSET of each. */
  axisA: 40,
  axisB: 40,
} as const

/** memA[r] = r (ascending). memB[r] = a DIFFERENT permutation of the first `rows` of axis B, so
 *  `memA[r] ≠ memB[r]` for the interior — the correspondence the fixture exists to exercise. */
export function integratedMembersA(rows: number): number[] {
  return Array.from({ length: rows }, (_, r) => r)
}
export function integratedMembersB(rows: number): number[] {
  // A non-monotonic PERMUTATION of the first `rows` of axis B — the correspondence ORDER
  // (INV-6/INV-7): row r is entry memB[r] of dataset B, read at B's OWN index j, never at r. It is
  // a genuine permutation (non-ascending), which is what makes it a CORRESPONDENCE index body
  // rather than a subset's ascending set — INV-6 pairs entry i of one axis with an ARBITRARY entry
  // j of the other, which a monotonic (ascending) body cannot express.
  //
  // It is DELIBERATELY NOT a plain reverse. `rows-1-r ≡ -(r+1)` preserves each row's residue class
  // modulo the categorical's level count, so a reverse paints the SAME partition an index-identity
  // gather (row r ↦ r) would — the negative control below (`indexIdentityGrouping`) would then have
  // no teeth, because the correspondence and the bug are indistinguishable by partition. Swapping
  // the last two members breaks that residue symmetry: `{r : memB[r] % levels == c}` now differs
  // from `{r : r % levels == c}`, so reading side B at r instead of memB[r] paints a provably
  // different partition, and the correspondence read is the only one that matches.
  const out = Array.from({ length: rows }, (_, r) => rows - 1 - r)
  if (rows >= 2) {
    const tail = out[rows - 1]
    out[rows - 1] = out[rows - 2]
    out[rows - 2] = tail
  }
  return out
}

export async function seedIntegratedCoordinate(
  request: APIRequestContext,
  projectId: string,
  opts: { reversed?: boolean } = {},
): Promise<void> {
  const DA = 'e2e-integrated-axis-a'
  const DB = 'e2e-integrated-axis-b'
  const rows = INTEGRATED.rows
  const memA = integratedMembersA(rows)
  const memB = integratedMembersB(rows)
  const keysA = entityColumnArtifact('ref keys', Array.from({ length: INTEGRATED.axisA }, (_, k) => k), ENTITY_AXIS)
  const keysB = entityColumnArtifact('query keys', Array.from({ length: INTEGRATED.axisB }, (_, k) => k), 'others')
  // Categorical columns on each parent axis. The level at entry e is `e % levels`, so painting a
  // correspondence row r by side B reads level `memB[r] % levels` — which differs from
  // `memA[r] % levels` precisely because memA ≠ memB.
  const catA = categoricalColumnArtifact(
    INTEGRATED.columnA,
    [...INTEGRATED.levels],
    Array.from({ length: INTEGRATED.axisA }, (_, e) => e % INTEGRATED.levels.length),
    ENTITY_AXIS,
  )
  const catB = categoricalColumnArtifact(
    INTEGRATED.columnB,
    [...INTEGRATED.levels],
    Array.from({ length: INTEGRATED.axisB }, (_, e) => e % INTEGRATED.levels.length),
    'others',
  )
  const positions = positionsArtifact(rows)
  const memberEntry = (aligned: string, member: string, mem: number[]) => ({
    aligned_to: aligned,
    axis: aligned === DA ? ENTITY_AXIS : 'others',
    kind: 'subset' as const,
    n_members: mem.length,
    members: member,
    path: member,
    // The `bitmap` is the ascending SET of members (the delta-varint codec requires it); the
    // correspondence ORDER (the permutation) lives in the index BODY member (`mem-a`/`mem-b`),
    // which is read whole and may be any permutation.
    bitmap: encodeMemberSet([...mem].sort((a, b) => a - b)),
  })
  const entries = opts.reversed
    ? [memberEntry(DB, 'mem-b', memB), memberEntry(DA, 'mem-a', memA)]
    : [memberEntry(DA, 'mem-a', memA), memberEntry(DB, 'mem-b', memB)]

  // Dataset A: axis A key + a categorical column + the INTEGRATED coordinate (declaring both
  // memberships, with both index bodies as zarr members).
  await postSeedPlan(request, projectId, {
    dataset: { name: INTEGRATED.datasetA, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'int-keys-a',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keysA.structure, key: 'values', key_sequence_digest: DA },
        meta: { ...keysA.meta, is_axis_index: true },
        content: { encoding: 'members', members: keysA.members },
      },
      {
        output_id: 'int-col-a',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...catA.structure, aligned_to: DA },
        meta: { name: INTEGRATED.columnA, title: INTEGRATED.columnA, kind: 'categorical', n_categories: INTEGRATED.levels.length, categories: [...INTEGRATED.levels], n: INTEGRATED.axisA },
        content: { encoding: 'members', members: catA.members },
      },
      {
        output_id: 'int-positions',
        datatype: DT_POSITIONS,
        scope: 'dataset',
        structure: { ...positions.structure, memberships: entries },
        meta: { name: INTEGRATED.coordinate },
        content: {
          encoding: 'members',
          members: [
            ...positions.members,
            ...zarrArrayMembers('mem-a', [...memA], { encoding: 'u32', dtype: 'uint32', chunk: memA.length }),
            ...zarrArrayMembers('mem-b', [...memB], { encoding: 'u32', dtype: 'uint32', chunk: memB.length }),
          ],
        },
      },
    ],
  })
  // Dataset B: axis B key + a categorical column on it.
  await postSeedPlan(request, projectId, {
    dataset: { name: INTEGRATED.datasetB, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'int-keys-b',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keysB.structure, key: 'values', key_sequence_digest: DB },
        meta: { ...keysB.meta, is_axis_index: true },
        content: { encoding: 'members', members: keysB.members },
      },
      {
        output_id: 'int-col-b',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...catB.structure, aligned_to: DB },
        meta: { name: INTEGRATED.columnB, title: INTEGRATED.columnB, kind: 'categorical', n_categories: INTEGRATED.levels.length, categories: [...INTEGRATED.levels], n: INTEGRATED.axisB },
        content: { encoding: 'members', members: catB.members },
      },
    ],
  })
}
