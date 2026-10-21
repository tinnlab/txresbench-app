import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ownerToken } from '../project/_helpers'
import {
  DT,
  categoricalColumnArtifact,
  cscArtifact,
  zarrClusteringArtifact,
  zarrEmbeddingArtifact,
  expressionPlaceholder,
  halfCellSetMask,
  metricColumns,
  entityColumnArtifact,
  ENTITY_AXIS,
  obsPayload,
  PLOTTABLE_CELLS,
  PLOTTABLE_CLUSTERING_COLUMN,
  PLOTTABLE_GENES,
  ringEmbedding,
} from './_fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed small UPLOAD fixture every real-import seeder posts. Named ONCE so the two
 *  seeders below share one path instead of two copies that can drift apart. */
const UPLOAD_FIXTURE = resolve(HERE, 'fixtures/tiny_counts.h5ad')

// Shared harness for the declarative-processor-ui (Phase-8) e2e specs. These prove the NEW
// DATA-driven surfaces the rewrite ships (declarative-processor-ui Slice 7): the QC + Cell-filter
// UIs are `packages/<name>/ui/*.yaml` `view_spec` DATA, rendered through the general
// `DeclarativeRegion` interpreter (widget testids are `widget-<id>` — renderers.tsx `testid()`) and
// driven onto the ONE `@ziee/viz` canvas (`workbench-canvas-host`, `data-viz-framework`,
// `workbench-canvas-empty` — CanvasView.tsx). The bespoke `CellFilterCriteriaWidget` /
// `MetricListWidget` React (and their `schemaform-field-*` surfaces) are DELETED — no
// `openCellFilterForm`, no `schemaform-field-criteria`; the declarative view AUTO-MOUNTS as a pane
// via `placeViews` when its owning analysis' `appliesTo: single-cell/expression` availability
// holds (an expression artifact is present). (The view_spec's own `inspects:` key was removed by
// ITEM-68 — it was read by nothing; the gate has always used the manifest selector.)
//
// SEEDING (Slice 7 decision, documented per-spec in TESTS.md):
//  • PURE specs seed obs DIRECTLY through the ONE `#[cfg(debug_assertions)]` backend route
//    `POST /api/projects/{id}/_debug/seed` (compiled out of release, gated by `projects::use` +
//    project-edit). That route is a GENERIC engine — it inserts whatever artifacts the posted
//    `plan` describes and holds no single-cell vocabulary of its own; every datatype id, column
//    name and payload value in the plans below comes from `./_fixtures.ts`, the test DATA. The
//    seeded bytes are served by the same `GET /api/artifacts/{id}/data` byte-range path the FE
//    `readOpaque` reads, so the FULL FE paint + client-side keep-mask loop run for real; only the
//    Python compute is bypassed.
//  • REAL specs (gated on `CYTO_E2E_REAL_COMPUTE`) drive a real completed `qc.10x`/`cell.filter`
//    compute job over a genuinely IMPORTED matrix — `seedRunnableExpression` uploads the
//    committed `.h5ad` through the deployment's own on-ingest converter, so the artifact under
//    test is the one the real producer writes (a CSC Zarr store declaring `kind: sparse_csc`),
//    not a fixture's idea of one. See that function's header for why a fixture cannot serve.
//    They need a sandbox-executable backend (bwrap + `CYTO_ENV_ROOTFS_DIR`). See TESTS.md
//    "Phase-8 env matrix".

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'
import { BINDING_ORIGIN_COPY } from '@/modules/workbench/core'

// ── the generic seed engine's wire vocabulary ─────────────────────────────────────────────────

/** How one seeded blob's bytes are framed. The engine only frames; the values are all ours. */
export type SeedContent =
  | { encoding: 'json'; value: unknown }
  | { encoding: 'f32'; values: number[] }
  | { encoding: 'u32'; values: number[] }
  | { encoding: 'i64'; values: number[] }
  | { encoding: 'input' }
  | { encoding: 'driver_file'; file: string }
  | { encoding: 'members'; members: ({ name: string } & SeedContent)[] }

/** Which tenancy scope a seeded artifact is attached to (Rust `SeedScope`). */
export type SeedScope = 'project' | 'dataset' | 'both'

/** A producer DECLARATION (`structure` or `meta`). Free-form JSON; any node of the form
 *  `{ $manifest: '<key>' }` is replaced by that key's value from the driver's
 *  `manifest.json`, so a declaration can carry numbers only the driver knows. A key the
 *  manifest does not carry is a 400 (`SEED_UNKNOWN_MANIFEST_KEY`) — it does NOT silently
 *  resolve to null — so a plan using `$manifest` must also name a `driver`. */
export type SeedDeclaration = unknown

export interface SeedArtifactSpec {
  output_id: string
  datatype: string
  scope?: SeedScope
  /** artifact-model ITEM-5: the producer-declared decode contract. Omitted ⇒ `opaque`.
   *  Every client read dispatches on it (ITEM-25), so a fixture framing a Zarr member
   *  tree or a CSC trio MUST declare it or the app cannot read what was seeded. */
  structure?: SeedDeclaration
  /** artifact-model ITEM-6: the producer-declared display meaning. Omitted ⇒
   *  `{"origin":"seed"}`. The successor to the plan's former free-form `params` bag,
   *  which ITEM-7 dropped along with the column. */
  meta?: SeedDeclaration
  /** The row's `status`. Omitted ⇒ `ready` (Rust `SeedArtifactSpec::status`, ITEM-30).
   *  A free string, not a union, matching the column and the Rust field: the vocabulary is
   *  enforced at the CONSUMPTION boundary, so a fixture seeding an unknown status exercises
   *  that refusal rather than being blocked here from expressing it. */
  status?: string
  content: SeedContent
}

/** One artifact per entry of a driver-manifest `{ id: file-name }` MAP (Rust `SeedManifestFiles`). */
export interface SeedManifestFilesSpec {
  manifest_key: string
  datatype: string
  scope?: SeedScope
  /** Manifest key holding a SECOND map, `{ output_id → structure }` — the PER-ARTIFACT decode
   *  contract, keyed by the same `output_id` as `manifest_key`. A set whose size and ids are
   *  the driver's data cannot be given one declaration per member by a plan, and one shared
   *  template cannot name each member; so the declarations travel as driver DATA too.
   *  Omitted ⇒ `opaque`, which declares no axis and no members — enough for a genuinely
   *  opaque blob, and NOT enough for a set of per-entity columns, which every axis-scoped
   *  resolver selects on exactly those two declarations. Naming a key whose map is missing an
   *  entry is a 400, never a silent fall back. */
  structure_key?: string
  /** Manifest key holding `{ output_id → meta }` — the per-artifact display declaration
   *  (what an artifact-ref picker labels its options with). Same fail-closed lookup. */
  meta_key?: string
}

/** One artifact per entry of a driver-manifest LIST of objects (Rust `SeedManifestItems`). */
export interface SeedManifestItemsSpec {
  manifest_key: string
  name_field: string
  datatype_field: string
  output_id_prefix?: string
  scope?: SeedScope
}

export interface SeedPlan {
  dataset?: { name: string; datatype: string }
  /** Run an embedded Python driver over the posted `input` before cataloging. */
  driver?: 'modality-split' | 'single-file-import'
  artifacts?: SeedArtifactSpec[]
  manifest_files?: SeedManifestFilesSpec[]
  manifest_items?: SeedManifestItemsSpec[]
}

export interface SeedEngineResponse {
  dataset_id: string | null
  artifacts: { output_id: string; datatype: string; id: string }[]
  /** The driver's `manifest.json` verbatim (`null` when no driver ran). */
  manifest: Record<string, unknown> | null
}

/** POST a seed plan (+ optional raw fixture bytes) to the generic engine. Fails LOUDLY (never a
 *  silent skip) if the route is missing/erroring — it only exists in a DEBUG build of the backend. */
export async function postSeedPlan(
  request: APIRequestContext,
  projectId: string,
  plan: SeedPlan,
  input?: Buffer,
  timeout?: number,
): Promise<SeedEngineResponse> {
  const token = await ownerToken(request)
  const multipart: Record<string, unknown> = { plan: JSON.stringify(plan) }
  if (input) {
    multipart.input = { name: 'input.bin', mimeType: 'application/octet-stream', buffer: input }
  }
  const r = await request.post(`${BACKEND}/api/projects/${projectId}/_debug/seed`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: multipart as never,
    ...(timeout ? { timeout } : {}),
  })
  expect(
    r.ok(),
    `debug seed route failed (${r.status()}): ${await r.text()} — \`POST …/_debug/seed\` is a ` +
      '#[cfg(debug_assertions)] endpoint; it only exists in a DEBUG build of the backend.',
  ).toBeTruthy()
  return (await r.json()) as SeedEngineResponse
}

/** Find a seeded artifact id by the `output_id` the plan gave it. */
export function seededId(resp: SeedEngineResponse, outputId: string): string | null {
  return resp.artifacts.find(a => a.output_id === outputId)?.id ?? null
}

// ── the single-cell fixture PLANS (their vocabulary is `./_fixtures.ts`) ──────────────────────

/** The report artifact + the per-metric `metadata-column` blobs a real run emits. A real run
 *  produces ONE `metadata-column` per computed metric; the fixture mirrors that so the criteria
 *  column picker + the live keep-mask/kept-count paint from real bytes. */
function annotatedObsArtifacts(
  nCells: number,
  extraColumns: readonly { name: string; values: number[] }[] = [],
): SeedArtifactSpec[] {
  return [
    {
      output_id: 'qc-obs',
      datatype: DT.qcReport,
      scope: 'dataset',
      content: { encoding: 'json', value: obsPayload(nCells) },
    },
    // `scope: 'dataset'` is LOAD-BEARING, and its absence was a silent hole. These columns
    // carried no scope, so they were catalogued PROJECT-scoped (`dataset_id` null) while the
    // expression placeholder beside them is dataset-scoped. `siblingsOnAxis` requires a
    // sibling's dataset to EQUAL the anchor's, and null never equals anything — so a seed that
    // looks like one coherent dataset offered ZERO criteria columns for its own matrix.
    // Invisible for as long as the obs slice read a project-wide report artifact; fatal once it
    // became an axis relation. It matches what a real import produces: columns beside the
    // matrix they describe, on one dataset.
    // Each column as a REAL producer writes it: a zarr store whose sole member is the constant
    // `values`, with the column's own name in `meta`, DECLARING the axis it aligns to.
    //
    // These used to be `{ encoding: 'f32' }` with no `structure` at all, which catalogues as
    // OPAQUE — no axis, no members. Every axis-scoped resolver filters on the declared axis, so
    // these were invisible to the criteria builder no matter how they were scoped.
    // The bare-f32 form also named nothing, so it could not have exercised the member-vs-meta
    // naming that collapses real columns onto one key.
    // `extraColumns` are seeded EXACTLY like the metric columns above — same axis, same
    // declaration, same scope. They exist so a caller can give two seeded datasets column sets
    // that DIFFER: with identical sets, "these columns came from the dataset I chose" and
    // "these columns came from whichever dataset happened to be in the project" are the same
    // observation, and a test cannot tell them apart.
    ...[...metricColumns(nCells), ...extraColumns].map<SeedArtifactSpec>(({ name, values }) => {
      const { members, structure, meta } = entityColumnArtifact(name, values, ENTITY_AXIS)
      return {
        output_id: name,
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure,
        meta,
        content: { encoding: 'members', members },
      }
    }),
  ]
}

export interface SeedResult {
  /** `null` when `expression: false` (obs-only seed — see the option's doc below). */
  expression_artifact_id: string | null
  qc_artifact_id: string | null
  n_cells: number
  /** Present only when `categorical: true`. The DECLARED column + its declared level set,
   *  one level of which selects NO row (see {@link CATEGORICAL_SEED}). */
  categorical?: {
    column: string
    levels: readonly string[]
    unobserved: string
    /** the per-row level NAME, index-aligned — the spec's independent oracle. */
    rowLevels: readonly string[]
  }
}

/**
 * The declared categorical the `categorical: true` seed adds (TEST-57 / ITEM-43).
 *
 * `unobserved` is declared by the producer and selected by NO code. That asymmetry is the entire
 * assertion: a picker populated by inspecting the values cannot offer it, and a picker fed the
 * producer's declaration must — so it distinguishes the two derivations end to end, which no
 * count or "the picker has options" check can do.
 */
const CATEGORICAL_SEED = {
  column: 'phase',
  levels: ['alpha', 'beta', 'gamma', 'zeta-never-observed'] as const,
  unobserved: 'zeta-never-observed',
  /** how many of the declared levels the codes actually reach (the first three). */
  observed: 3,
} as const

/** Seed a QC dataset into a project. `annotated:true` → the `report/qc` obs.json with metric
 *  columns (the declarative surfaces paint their violins / before-after); `annotated:false` → only
 *  the `single-cell/expression` artifact.
 *
 *  `expression:false` seeds the obs WITHOUT the opaque `single-cell/expression` PLACEHOLDER, for a
 *  spec whose REAL half must genuinely RUN a processor: the placeholder's bytes are JSON
 *  (`{"seed":"single-cell/expression",…}`), not a matrix, so a run over it always fails — such a
 *  spec pairs this with `seedRunnableExpression` for a real `.h5ad`. It has to be an OPT-OUT (not
 *  "seed both") because `run_processor` input resolution (`hostCtx.ts::resolveInputs`) demands
 *  EXACTLY ONE compatible artifact per required `artifact-ref` slot — two expression artifacts
 *  make the analysis unlaunchable ("found 2"). Pass `nCells` = the real `.h5ad`'s cell count so the
 *  seeded obs stays obs-aligned with the matrix the run reads. */
export async function seedQcDataset(
  request: APIRequestContext,
  projectId: string,
  opts: { annotated: boolean; nCells?: number; expression?: boolean; categorical?: boolean },
): Promise<SeedResult> {
  const rowCount = opts.nCells ?? 200
  const artifacts: SeedArtifactSpec[] = []
  // The DECLARED categorical (opt-in). Seeded exactly like the metric columns — same axis, same
  // dataset scope, same single-column store shape — so it reaches the criteria builder by the one
  // route every other column takes, and the spec is not testing a bespoke seeding path.
  const codes = Array.from({ length: rowCount }, (_, i) => i % CATEGORICAL_SEED.observed)
  const rowLevels = codes.map(c => CATEGORICAL_SEED.levels[c])
  if (opts.expression ?? true) {
    artifacts.push({
      output_id: 'expression',
      datatype: DT.expression,
      scope: 'dataset',
      content: { encoding: 'json', value: expressionPlaceholder(rowCount) },
    })
  }
  if (opts.annotated) artifacts.push(...annotatedObsArtifacts(rowCount))
  if (opts.categorical) {
    const cat = categoricalColumnArtifact(
      CATEGORICAL_SEED.column,
      CATEGORICAL_SEED.levels,
      codes,
      ENTITY_AXIS,
    )
    artifacts.push({
      output_id: CATEGORICAL_SEED.column,
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: cat.structure,
      meta: cat.meta,
      content: { encoding: 'members', members: cat.members },
    })
  }
  // A DECLARED dataset, and everything above scoped to it.
  //
  // This seed used to scope NOTHING: the expression placeholder and its obs columns were all
  // project-scoped (`dataset_id` null). That is not merely "the columns are elsewhere" — the
  // ANCHOR had no dataset either, and `siblingsOnAxis` resolves an anchor with no source dataset
  // to NOTHING, deliberately (it refuses to fall back to project-wide, which would offer columns
  // belonging to a different dataset). So an obs-annotated seed could never offer a single
  // criteria column for its own matrix once the obs slice became an axis relation.
  //
  // One dataset carrying the matrix AND the columns that describe it is what a real import
  // produces, and it is the only shape in which the axis relation means anything.
  const resp = await postSeedPlan(request, projectId, {
    dataset: { name: `qc-seed-${Date.now()}`, datatype: DT.expression },
    artifacts,
  })
  return {
    expression_artifact_id: seededId(resp, 'expression'),
    qc_artifact_id: seededId(resp, 'qc-obs'),
    n_cells: rowCount,
    ...(opts.categorical
      ? {
          categorical: {
            column: CATEGORICAL_SEED.column,
            levels: CATEGORICAL_SEED.levels,
            unobserved: CATEGORICAL_SEED.unobserved,
            rowLevels,
          },
        }
      : {}),
  }
}

/**
 * Seed ONE artifact of `datatype` — the generic "give this analysis a candidate for its input
 * slot" seeder. The caller passes the datatype it read off the LIVE contribution catalog
 * (`14-workbench/_analysis.ts::singleSlotFormBackedAnalysis`), so neither side writes a
 * contributed id down.
 *
 * `realFixtureBytes: false` (default) stores a small JSON placeholder. That is enough for the
 * form to have exactly one candidate (so its artifact-ref control auto-picks and Run enables)
 * and for a job to be SUBMITTED — everything a click-synchronous assertion needs. The job then
 * fails inside the sandbox, which such a caller must not wait for.
 *
 * `realFixtureBytes: true` stores the committed upload fixture's bytes VERBATIM. That is the
 * right shape for an on-ingest converter, whose whole job is to read the raw uploaded container
 * off its input slot — unlike a slot that expects a PRODUCED store, where opaque bytes are
 * unreadable and the seed has to go through the real importer (`seedRunnableExpression`). Use it
 * for a caller that needs the run to genuinely progress.
 */
export async function seedArtifactOfType(
  request: APIRequestContext,
  projectId: string,
  datatype: string,
  opts: { realFixtureBytes?: boolean } = {},
): Promise<string> {
  const real = opts.realFixtureBytes ?? false
  const artifact: SeedArtifactSpec = {
    output_id: 'slot-input',
    datatype,
    content: real ? { encoding: 'input' } : { encoding: 'json', value: { seed: datatype } },
  }
  const resp = await postSeedPlan(
    request,
    projectId,
    { artifacts: [artifact] },
    real ? readFileSync(UPLOAD_FIXTURE) : undefined,
    real ? 120_000 : undefined,
  )
  const id = seededId(resp, 'slot-input')
  expect(id, `the seed produced an artifact of ${datatype}`).toBeTruthy()
  return id as string
}

export interface SeedDatasetResult {
  dataset_id: string
  expression_artifact_id: string
}

/** What a PLAN-based dataset seed additionally knows. It is a separate type rather than an
 *  optional field because the distinction is real: a seeder that WROTE the plan can name the
 *  columns it put on the axis, and `seedRunnableExpression` — which drives a real import — cannot
 *  without going back to the catalog to ask. */
export interface SeedProjectDatasetResult extends SeedDatasetResult {
  /** The per-row column NAMES this dataset's axis now carries — exactly the set a criteria
   *  builder anchored on `expression_artifact_id` must offer, and nothing else. Returned rather
   *  than restated by the caller so a spec asserts the OFFERED set against what was SEEDED
   *  instead of against a literal list that drifts the moment the fixture grows a column. */
  column_names: string[]
}

/** Seed a REAL project-attached dataset (a `datasets` row + `project_datasets` link + a
 *  DATASET-SCOPED `single-cell/expression` artifact). The artifact's `source_dataset_of` resolves
 *  to this dataset, so the artifact-ref picker groups the candidate under `name`. It also seeds a
 *  project-scoped obs (mirroring the annotated QC seed) so the auto-mounted Cell-filter surface has
 *  REAL obs columns to build a criterion on (TEST-E6).
 *
 *  `extraColumns` adds per-cell columns THIS dataset alone carries. Two datasets seeded with the
 *  same columns are indistinguishable through the criteria builder, so a spec about several
 *  datasets in one project needs at least one column per dataset that only that dataset has —
 *  see the note beside the seeded column artifacts. */
export async function seedProjectDataset(
  request: APIRequestContext,
  projectId: string,
  name: string,
  nCells = 200,
  extraColumns: readonly { name: string; values: number[] }[] = [],
): Promise<SeedProjectDatasetResult> {
  const columnArtifacts = annotatedObsArtifacts(nCells, extraColumns)
  const resp = await postSeedPlan(request, projectId, {
    dataset: { name, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'expression',
        datatype: DT.expression,
        scope: 'dataset',
        content: { encoding: 'json', value: expressionPlaceholder(nCells) },
      },
      ...columnArtifacts,
    ],
  })
  const expression = seededId(resp, 'expression')
  expect(resp.dataset_id && expression, 'the dataset seed produced a dataset + expression artifact').toBeTruthy()
  return {
    dataset_id: resp.dataset_id as string,
    expression_artifact_id: expression as string,
    // The per-cell columns, taken from the plan that was POSTED rather than re-derived: the
    // report artifact is not one (it declares no axis), and the seeder is the only thing that
    // knows which of the artifacts it sent are columns.
    column_names: columnArtifacts
      .filter(a => a.datatype === DT.metadataColumn)
      .map(a => a.output_id),
  }
}

export interface SeedPlottableResult {
  embedding_artifact_id: string
  expression_artifact_id: string
  mask_artifact_id: string
  clustering_artifact_id: string
  clustering_column: string
  /** The DECLARED level set of the seeded categorical, including one level that never
   *  occurs in the data (D10 — levels are declared, never derived from the codes). */
  clustering_levels: string[]
  /** How many inner chunks the seeded embedding holds. `> 1` is what makes the
   *  progressive-arrival assertions meaningful rather than vacuous. */
  embedding_chunks: number
  n_cells: number
  n_genes: number
}

/** Seed a fully-PLOTTABLE project (no compute run): a dense 2-D `embedding`, a real CSC
 *  `single-cell/expression` matrix (→ color-by-gene value columns), an obs `report/qc` blob, a
 *  content-addressed cell-set row subset, and a `clustering` categorical column.
 *
 *  Every artifact DECLARES its `structure` (ITEM-5), because that is what the client reader
 *  dispatches on since ITEM-12 deleted `/read`. All three — embedding, clustering AND the
 *  matrix — are seeded as real (raw, unsharded) ZARR member trees, so the app reads them the
 *  way it reads a processor's output. The matrix declares `kind: "sparse_csc"`, which is the
 *  single vocabulary `cyto_csc.write_csc_zarr` emits; there is no second, non-Zarr spelling
 *  of a CSC for a fixture to reach for. */
export async function seedPlottableProject(
  request: APIRequestContext,
  projectId: string,
): Promise<SeedPlottableResult> {
  const n = PLOTTABLE_CELLS
  const csc = cscArtifact(n, PLOTTABLE_GENES)
  const emb = zarrEmbeddingArtifact(n)
  const clust = zarrClusteringArtifact(n)
  const resp = await postSeedPlan(request, projectId, {
    artifacts: [
      {
        output_id: 'umap',
        datatype: DT.embedding,
        structure: emb.structure,
        content: { encoding: 'members', members: emb.members },
      },
      {
        output_id: 'expression',
        datatype: DT.expression,
        structure: csc.structure,
        content: { encoding: 'members', members: csc.members },
      },
      {
        output_id: 'cell-set',
        datatype: DT.cellSet,
        content: { encoding: 'u32', values: halfCellSetMask(n) },
      },
      {
        output_id: 'qc-obs',
        datatype: DT.qcReport,
        content: { encoding: 'json', value: obsPayload(n) },
      },
      {
        output_id: 'clustering',
        datatype: DT.clustering,
        structure: clust.structure,
        content: { encoding: 'members', members: clust.members },
      },
    ],
  })
  return {
    embedding_artifact_id: seededId(resp, 'umap') as string,
    expression_artifact_id: seededId(resp, 'expression') as string,
    mask_artifact_id: seededId(resp, 'cell-set') as string,
    clustering_artifact_id: seededId(resp, 'clustering') as string,
    clustering_column: PLOTTABLE_CLUSTERING_COLUMN,
    clustering_levels: clust.levels,
    embedding_chunks: emb.n_chunks,
    n_cells: n,
    n_genes: PLOTTABLE_GENES,
  }
}

/** The cell count of the `fixtures/tiny_counts.h5ad` fixture (120 cells × 10 genes). A spec that
 *  pairs `seedRunnableExpression` with an obs seed passes this as `nCells` so the seeded obs is
 *  obs-ALIGNED with the matrix the real run reads (same per-cell length). */
export const TINY_COUNTS_CELLS = 120

/** How much extra wall-clock a `seedRunnableExpression` call adds to its test: a real
 *  on-ingest conversion, plus (on a cold host) the backend fetching and mounting the
 *  runtime image. Granted ADDITIVELY (`test.info().timeout + …`) rather than by
 *  assignment, so a spec that already raised its own budget for a compute keeps it —
 *  assignment would silently LOWER `cell-filter-live`'s 300 s to this number. */
const IMPORT_BUDGET_MS = 240_000

/**
 * Seed a REAL RUNNABLE `single-cell/expression` artifact by IMPORTING the committed
 * `fixtures/tiny_counts.h5ad` through the deployment's OWN upload + on-ingest converter,
 * then attaching the resulting dataset to `projectId`.
 *
 * ── WHY AN IMPORT AND NOT A SEED PLAN (the bug this replaced) ────────────────────────
 *
 * This used to POST the raw `.h5ad` bytes to the debug seed engine with
 * `content: {encoding:'input'}` and NO `structure`, above a doc comment claiming "the
 * sandbox input-stager copies the bytes verbatim to `/inputs/matrix.h5ad`". Both halves
 * were false. Mount names are DERIVED from the artifact (`sandbox/spec.rs::
 * derive_artifact_mount_name`), and neither compute reads an `.h5ad` any more:
 * `cell-filter.py::read_matrix` and `qc-10x.py::read_matrix` both refuse an input whose
 * store does not DECLARE `kind: "sparse_csc"` in its group `zarr.json`. Running the
 * production scripts on exactly that input exits 2:
 *
 *     cell-filter: input on slot 'expression' at 'expression' carries no `structure`
 *     declaration in a group `zarr.json` — it is not a cyto_zarr artifact.
 *     qc-10x:      input on slot 'matrices[0]' at 'expression' carries no `structure` …
 *
 * ── WHY THE STORE CANNOT COME FROM A FIXTURE (committed OR generated) ────────────────
 *
 * The obvious fixes — commit a pre-built CSC Zarr store, or generate one at seed time
 * from the same `.h5ad` — are both UNREACHABLE through the seed engine, so the choice
 * between "fast but goes stale" and "honest but adds a dependency" never arises:
 *
 *   • A member's bytes can only be framed as `json` / `f32` / `u32` / `i64` / the
 *     request's single `input` part / a driver file (`SeedBytes`, `workstore/
 *     data_api.rs`). There is no raw-bytes framing, and a real store's shard files are
 *     arbitrary gzip — measured at 307 and 118 bytes for this fixture, so not even
 *     `u32`-expressible without padding that would move the shard index.
 *   • The raw, UNSHARDED Zarr the seed engine CAN express (`_fixtures.ts::cscArtifact`,
 *     which the FE reader decodes happily) is not readable by the PYTHON side at all:
 *     `cyto_zarr_read.read_array` reads `codecs[0].configuration.chunk_shape` and
 *     `gzip.decompress`es unconditionally, so `cyto_csc.read_csc` on such a store raises
 *     `KeyError: 'chunk_shape'`. Verified directly.
 *
 * So the bytes have to come from the REAL producer. That is strictly the better answer
 * anyway: there is no staleness story to tell, because there is no copy of the format
 * anywhere in the test tree. If `write_csc_zarr` changes its container tomorrow, the
 * importer changes with it and this seed follows for free — where a committed fixture
 * would keep deserializing into a shape nothing produces any more, and would do it
 * QUIETLY, since the specs that consume it are the ones behind `CYTO_E2E_REAL_COMPUTE`.
 *
 * ── WHAT THE IMPORT PRODUCES ────────────────────────────────────────────────────────
 *
 * The production `anndata-import` converter emits, for this fixture: ONE
 * `single-cell/expression` CSC Zarr store (120 cells × 10 genes, 1164 nnz) plus
 * `cells_index` / `genes_index` (axis keys) and one `metadata-column`. That is exactly
 * the input set both computes need — including the genes-axis string column `qc.yaml`'s
 * `geneNamesPicker` auto-seeds `gene_names` from, which is why a DEFAULT `qc.10x` run
 * (whose metric set includes the `mito`/`ribo` PATTERN metrics) can complete at all.
 *
 * COST: a real sandbox conversion per call — see [`IMPORT_BUDGET_MS`]. The callers are
 * the real-compute specs, which pay for a sandbox run regardless; `datasets/
 * vertical-slice.spec.ts` and `datasets/promote.spec.ts` already import this same
 * fixture on the DEFAULT (ungated) run, so this adds no new host requirement.
 */
export async function seedRunnableExpression(
  request: APIRequestContext,
  projectId: string,
  datasetName = 'Runnable dataset',
): Promise<SeedDatasetResult> {
  // Additive, not assignment — see IMPORT_BUDGET_MS.
  test.setTimeout(test.info().timeout + IMPORT_BUDGET_MS)

  const token = await ownerToken(request)
  const auth = { authorization: `Bearer ${token}` }
  const h5ad = readFileSync(UPLOAD_FIXTURE)
  // The dataset's NAME comes from the uploaded file name, so the caller's label survives
  // into the artifact-ref picker's grouping. Sanitized + uniquified: the suite shares ONE
  // owner and one persistent DB, so a fixed name would collide across specs.
  const slug = datasetName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'runnable'
  const fileName = `${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.h5ad`

  // ── 1. the real streaming upload. Returns once the bytes are ingested and the
  //       on-ingest run is ENQUEUED — the conversion is still ahead of us.
  const upload = await request.post(`${BACKEND}/api/datasets/upload`, {
    headers: auth,
    multipart: {
      file: { name: fileName, mimeType: 'application/octet-stream', buffer: h5ad },
    },
    timeout: 120_000,
  })
  expect(
    upload.ok(),
    `upload ${fileName} -> ${upload.status()}: ${await upload.text()}`,
  ).toBeTruthy()
  const uploaded = (await upload.json()) as {
    datasets?: { id?: string; dataset?: { id?: string } }[]
  }
  const datasetId = uploaded.datasets?.[0]?.dataset?.id ?? uploaded.datasets?.[0]?.id
  expect(datasetId, 'the upload created a dataset').toBeTruthy()

  // ── 2. wait for the on-ingest converter. A FAILED import is a hard failure carrying
  //       the converter's own reason — never a silent "no artifact found" further down.
  const deadline = Date.now() + IMPORT_BUDGET_MS
  let status: string | null = null
  let error: string | null = null
  for (;;) {
    const r = await request.get(`${BACKEND}/api/datasets/${datasetId}`, { headers: auth })
    expect(r.ok(), `GET /datasets/${datasetId} -> ${r.status()}`).toBeTruthy()
    const row = (await r.json()) as {
      processing_status?: string | null
      processing_error?: string | null
    }
    status = row.processing_status ?? null
    error = row.processing_error ?? null
    if (status === 'completed' || status === 'failed') break
    if (Date.now() >= deadline) break
    await new Promise(done => setTimeout(done, 2_000))
  }
  expect(
    status,
    `the on-ingest converter did not COMPLETE for ${fileName} (last processing_status: ` +
      `${status ?? 'null'}${error ? `, error: ${error}` : ''}). This seed IS a real import — ` +
      'it needs a sandbox-executable host. A conversion failure is a failure here, not a skip.',
  ).toBe('completed')

  // ── 3. attach the imported dataset to the project. Import artifacts are DATASET-scoped
  //       (ITEM-23), and `GET /projects/{id}/artifacts` lists project-scoped artifacts PLUS
  //       the attached datasets' — which is what makes them pickable as analysis inputs.
  const attach = await request.post(
    `${BACKEND}/api/projects/${projectId}/datasets/${datasetId}`,
    { headers: auth },
  )
  expect(
    attach.ok(),
    `attach dataset ${datasetId} to project ${projectId} -> ${attach.status()}: ${await attach.text()}`,
  ).toBeTruthy()

  // ── 4. the produced matrix. Selected by `subtypes_of` — the SAME lattice query the
  //       analyses' `appliesTo` resolves with, so "exactly one" here is the same
  //       "exactly one" `run_processor` input resolution will demand.
  const listed = await request.get(
    `${BACKEND}/api/projects/${projectId}/artifacts?subtypes_of=${encodeURIComponent(DT.expression)}`,
    { headers: auth },
  )
  expect(listed.ok(), `list artifacts -> ${listed.status()}: ${await listed.text()}`).toBeTruthy()
  const matrices = (await listed.json()) as { id: string; datatype: string; structure?: unknown }[]
  expect(
    matrices.map(m => `${m.datatype}:${m.id}`),
    'the import produced EXACTLY ONE `single-cell/expression` artifact in this project — ' +
      'run_processor input resolution demands exactly one compatible artifact per required ' +
      'slot, so zero makes the analysis unlaunchable and two make it ambiguous',
  ).toHaveLength(1)
  // The whole point of the change: what landed DECLARES the CSC contract the computes read.
  expect(
    (matrices[0].structure as { kind?: string } | undefined)?.kind,
    'the imported matrix declares `kind: "sparse_csc"` — this is the assertion that fails ' +
      'loudly if the seed ever regresses to posting opaque bytes, instead of the failure ' +
      'surfacing minutes later as an unexplained processor exit 2',
  ).toBe('sparse_csc')

  return { dataset_id: datasetId as string, expression_artifact_id: matrices[0].id }
}

export interface SeedMultimodalResult {
  modalities: string[]
  obs_columns: string[]
  qc_artifact_id: string
  container_artifact_id: string
  n_cells: number
  /** The dataset every artifact above is scoped to. A multi-modal import IS one dataset —
   *  that is what makes the modalities' frame SHARED — and the filter surface resolves its
   *  criteria columns through that dataset (`siblingsOnAxis`), so a seed with no dataset row
   *  carries no columns at all no matter what it catalogues. */
  dataset_id: string
  /** `{ modality → artifact id }` for the per-modality matrices, so a spec can CHOOSE one in
   *  the surface's dataset picker. Both satisfy the picker's `subtypes_of` source (the protein
   *  datatype EXTENDS the expression one), so it offers two and pre-selects neither. */
  matrix_artifact_ids: Record<string, string>
  /** The per-row metric columns the reader materialized as `metadata-column` artifacts — the
   *  set the criteria builder must offer. A SUBSET of the reader's column list, which also
   *  names the identifier/label columns that live only inside the report blob. */
  metric_columns: string[]
}

/** Seed a REAL MULTI-MODAL (CITE-seq) dataset (TEST-E5). Posts a genuine 10x CITE-seq `.h5ad`
 *  fixture (Gene Expression + Antibody Capture, subsampled from `pbmc_1k_protein_v3`, CC BY 4.0)
 *  as the engine's `input` and names the `modality-split` driver — the SAME `multimodal.py` reader
 *  the production `anndata-import` converter composes (`split_by_feature_types` / `modality_prefixed`
 *  / `modality_datatype` / `align_barcodes` / `detect_isotype_controls`). The plan then catalogs a
 *  `single-cell/multimodal` container + a report json whose SHARED frame carries
 *  `modality:`-prefixed metrics (`prot:total_counts`, `rna:total_counts`, `rna:pct_mito`), plus the
 *  per-modality matrices and per-metric columns the driver's OWN manifest enumerates (their ids +
 *  datatypes come from the reader, i.e. from DATA). Fails LOUDLY (never a silent skip) if the route
 *  or the host scientific-python stack is missing.
 *
 *  ── ONE DATASET, AND WHY IT IS LOAD-BEARING ─────────────────────────────────────────────
 *
 *  This plan declared NO `dataset` and scoped nothing, so every artifact it catalogued had a
 *  NULL `source_dataset_id` — and the per-metric columns carried no `structure` either, so they
 *  declared no axis. Both were invisible for as long as the filter surface read its frame out
 *  of the `report/qc` blob; the moment that slice became an AXIS relation
 *  (`axis_columns { of: $state.expression, … }`), the criteria builder resolved to nothing here
 *  — `siblingsOnAxis` requires the anchor to HAVE a dataset and each sibling to DECLARE the
 *  axis, and this seed satisfied neither. Nothing failed: the picker simply offered
 *  "No options yet".
 *
 *  A multi-modal import IS one dataset (that is what makes the modalities' frame SHARED and the
 *  keep-mask joint), so declaring one is not a test convenience — it is the shape the thing
 *  being tested actually has. */
export async function seedMultimodalDataset(
  request: APIRequestContext,
  projectId: string,
  datasetName = 'Multimodal CITE-seq',
): Promise<SeedMultimodalResult> {
  const h5ad = readFileSync(resolve(HERE, 'fixtures/multimodal_citeseq.h5ad'))
  const resp = await postSeedPlan(
    request,
    projectId,
    {
      driver: 'modality-split',
      // The dataset the modalities share. `datatype` names the CONTAINER the reader produced.
      dataset: { name: `${datasetName} ${Date.now()}`, datatype: DT.multimodal },
      artifacts: [
        {
          output_id: 'multimodal-container',
          datatype: DT.multimodal,
          scope: 'both',
          content: { encoding: 'driver_file', file: 'container.json' },
        },
        {
          output_id: 'qc-obs',
          datatype: DT.qcReport,
          scope: 'both',
          content: { encoding: 'driver_file', file: 'obs.json' },
        },
      ],
      // The per-modality matrices: one per reader-declared modality link, each carrying the
      // datatype the READER chose (`single-cell/expression` for rna, `single-cell/protein` for prot).
      // DATASET-scoped, like a real import's outputs — this is the anchor every axis-scoped
      // resolver scopes by.
      manifest_items: [
        {
          manifest_key: 'modality_links',
          name_field: 'modality',
          datatype_field: 'datatype',
          output_id_prefix: 'expression:',
          scope: 'dataset',
        },
      ],
      // The per-metric columns the reader wrote, keyed by column name — each with the axis it
      // aligns to and the display name it carries, both from the DRIVER's manifest. Without the
      // two declaration keys these catalogue as opaque (no axis, no members) and the criteria
      // builder cannot see them; without `scope` they carry no dataset and `siblingsOnAxis`
      // drops them even when they do declare one.
      manifest_files: [
        {
          manifest_key: 'column_files',
          structure_key: 'column_structures',
          meta_key: 'column_meta',
          datatype: DT.metadataColumn,
          scope: 'dataset',
        },
      ],
    },
    h5ad,
    120_000,
  )
  const manifest = (resp.manifest ?? {}) as {
    modalities?: string[]
    obs_columns?: string[]
    metric_columns?: string[]
    n_cells?: number
  }
  const matrices: Record<string, string> = {}
  for (const modality of manifest.modalities ?? []) {
    const id = seededId(resp, `expression:${modality}`)
    expect(id, `the reader's ${modality} modality was catalogued as its own matrix`).toBeTruthy()
    matrices[modality] = id as string
  }
  expect(resp.dataset_id, 'the multimodal seed created the dataset its modalities share').toBeTruthy()
  return {
    modalities: manifest.modalities ?? [],
    obs_columns: manifest.obs_columns ?? [],
    metric_columns: manifest.metric_columns ?? [],
    dataset_id: resp.dataset_id as string,
    matrix_artifact_ids: matrices,
    qc_artifact_id: seededId(resp, 'qc-obs') as string,
    container_artifact_id: seededId(resp, 'multimodal-container') as string,
    n_cells: manifest.n_cells ?? 0,
  }
}

export interface SeedAnndataImportResult {
  dataset_id: string
  embedding_artifact_id: string
  qc_artifact_id: string
  expression_artifact_id: string
  obs_columns: string[]
  n_cells: number
}

/** Seed a project by running the REAL `anndata-import` converter over a POSTed `.h5ad`: the
 *  `single-file-import` driver invokes the production `h5ad_import.py` (the SAME script the
 *  on-ingest converter runs in the sandbox) on the host python, so the cataloged `embedding` holds
 *  the dataset's genuine `obsm['X_umap']` coordinates and the produced columns are the converter's
 *  real ones.
 *
 *  THE COLUMNS ARE CATALOGED ON THE ENTITY AXIS, one artifact each — mirroring the
 *  one-`metadata-column`-per-column set a real import produces. That is not a detail: every
 *  axis-scoped source in a declarative view (`axis_columns` → `axisSource.ts::siblingsOnAxis` →
 *  `axisColumnRows`) selects candidates by the anchor's SOURCE DATASET and by what each sibling
 *  DECLARES (`structure.axis` + `structure.columns`). This seed used to publish them only as
 *  ONE bundled report blob with no `structure` at all — the shape the cell-filter view read when
 *  its frame slice was `{ source: job.result, datatype: report/qc }`. When that slice moved to the
 *  AXIS, nothing here moved with it: the seeded dataset's axis carried zero column artifacts, so
 *  the frame slice resolved empty, `$derived.keptMask` had length 0, and the surface mounted showing
 *  "No data yet" with no error anywhere. The bundle is still cataloged (it is what a report-shaped
 *  reader wants); the per-column artifacts are what the AXIS carries.
 */
export async function seedAnndataImport(
  request: APIRequestContext,
  projectId: string,
  h5ad: Buffer,
  datasetName = 'AnnData import (pbmc)',
): Promise<SeedAnndataImportResult> {
  const resp = await postSeedPlan(
    request,
    projectId,
    {
      driver: 'single-file-import',
      dataset: { name: datasetName, datatype: DT.anndata },
      artifacts: [
        {
          // The GENUINE embedding: a single-file dense f32 [N,2] blob (the `chunked_dense`,
          // `file_layout: single` form the `embedding` datatype declares + `positions()` reads).
          output_id: 'embedding:X_umap',
          datatype: DT.embedding,
          scope: 'both',
          meta: { seeded: true, source: 'X_umap' },
          content: { encoding: 'driver_file', file: 'embedding.f32' },
        },
        {
          output_id: 'qc-obs',
          datatype: DT.qcReport,
          content: { encoding: 'driver_file', file: 'obs.json' },
        },
        {
          // The raw h5ad as a `single-cell/expression` artifact so the cell-filter view mounts.
          //
          // ⚠ PRESENCE-ONLY, NOT RUNNABLE — and deliberately left that way. These bytes are an
          // opaque blob with no `structure`, exactly the shape `seedRunnableExpression` stopped
          // producing: a compute reading this on an `expression`/`matrices` slot exits 2. It is
          // sound here ONLY because this helper's sole caller (`14-workbench/
          // cell-filter-scatter-thins.spec.ts`) runs NO processor — it needs an artifact of this
          // DATATYPE to exist so `placeViews` auto-mounts the cell-filter surface, and asserts on
          // the data plane. The `meta.runnable` flag is a leftover of the retired claim.
          //
          // It cannot be fixed the way `seedRunnableExpression` was: this helper's input is a
          // CALLER-supplied `.h5ad` run through the `single-file-import` DRIVER, and a driver's
          // Zarr store cannot be cataloged as a multi-file artifact (`driver_file` reads ONE
          // plain file name). A real fix needs the seed engine or the driver to change — both
          // server-side.
          //
          // It IS on the axis' dataset (`scope: 'dataset'`), which is what makes it a usable
          // ANCHOR: `siblingsOnAxis` scopes by the anchor's `source_dataset_id` and yields
          // nothing when it is null.
          output_id: 'expression',
          datatype: DT.expression,
          scope: 'dataset',
          meta: { seeded: true, presence_only: true },
          content: { encoding: 'input' },
        },
      ],
      // ONE artifact per produced column, on the ENTITY AXIS — the set the axis-scoped
      // resolvers read (see this function's doc comment). Ids, file names and BOTH producer
      // declarations come from the driver's own manifest, i.e. from what the converter
      // actually produced: this block names no column and hardcodes no count, so a different
      // input seeds a different set with no edit here.
      //
      // `scope: 'dataset'` matches the anchor above. It is load-bearing, not tidiness: a
      // project-scoped column has a NULL `source_dataset_id`, and `siblingsOnAxis` requires
      // the sibling's to EQUAL the anchor's — so a project-scoped set would be cataloged, be
      // visible in the catalog, declare the right axis, and still resolve to nothing.
      manifest_files: [
        {
          manifest_key: 'column_files',
          structure_key: 'column_structures',
          meta_key: 'column_meta',
          datatype: DT.metadataColumn,
          scope: 'dataset',
        },
      ],
    },
    h5ad,
    180_000,
  )
  const manifest = (resp.manifest ?? {}) as { obs_columns?: string[]; n_cells?: number }
  return {
    dataset_id: resp.dataset_id as string,
    embedding_artifact_id: seededId(resp, 'embedding:X_umap') as string,
    qc_artifact_id: seededId(resp, 'qc-obs') as string,
    expression_artifact_id: seededId(resp, 'expression') as string,
    obs_columns: manifest.obs_columns ?? [],
    n_cells: manifest.n_cells ?? 0,
  }
}

// ── DECLARATIVE-SURFACE helpers (widget-<id> testids; the general DeclarativeRegion interpreter) ──

/** The declarative Cell-filter (`ui/cell-filter.yaml`) widget testids. Each is `widget-<widget id>`
 *  (renderers.tsx `testid()`). */
export const CF = {
  add: 'widget-addCriterionBtn',
  table: 'widget-criteriaTable',
  groupBy: 'widget-groupByPicker',
  label: 'widget-labelInput-input',
  run: 'widget-runBtn',
} as const

/**
 * The PER-ROW criterion controls.
 *
 * The builder is a TABLE now, so every row's control carries its OWN testid
 * (`widget-<table>-<primitive>-<column>-<row>`) instead of N controls sharing one id and being
 * told apart by `.nth(i)`. That is worth the churn at the call sites: `.nth(i)` indexes what
 * happened to RENDER, so a row whose control is correctly gated off silently shifted every
 * later index by one — a spec could drive row 2 while believing it was driving row 1, and pass.
 */
export const CFRow = {
  col: (row: number) => `${CF.table}-select-column-${row}`,
  min: (row: number) => `${CF.table}-edit-min-${row}`,
  max: (row: number) => `${CF.table}-edit-max-${row}`,
  keep: (row: number) => `${CF.table}-multiselect-keep-${row}`,
  remove: (row: number) => `${CF.table}-action-remove-${row}`,
} as const

/** The declarative Compute-QC (`ui/qc.yaml`) widget testids.
 *
 *  `modality: 'widget-modalityPicker'` is GONE with the widget. The picker offered a CLOSED
 *  `[rna, prot, atac]` list and its value became the emitted column prefix, so a `hto` or
 *  `crispr` run had no correct answer; the modality now travels stamped in each matrix's own
 *  `structure` and the view neither picks nor relays one. The retired testid survives ONLY as
 *  an absence assertion in `modality-symmetry.spec.ts`, written inline there so this table
 *  stays a list of widgets that EXIST. */
/**
 * THE METRIC ROWS, and only them.
 *
 * A row whose control has something to say renders a SECOND `<tr>` directly under itself — the
 * full-width band the sentence lives in (`@ziee/kit`'s `renderRowDetail`, stamped
 * `…-row-<key>-detail`), because a column of a ~284px grid is the wrong box for a sentence: the
 * message measured 44px wide and 480px tall in one. So a bare `tbody tr` counts "metrics plus
 * however many of them are currently invalid" — a number that changes as the user types, and that
 * three specs were each independently one edit away from believing. Every count that means
 * METRICS goes through this.
 */
export const METRIC_ROWS =
  '[data-testid="widget-metricTable"] tbody tr[data-testid^="widget-metricTable-grid-row-"]' +
  ':not([data-testid$="-detail"])'

export const QC = {
  table: 'widget-metricTable',
  addMetric: 'widget-addMetricBtn',
  /** The browsable catalog of predefined metrics, and the ONLY control involved in adding one.
   *  Each preset used to be its own button (`widget-addHbBtn`, …), then briefly a picker plus an
   *  Add button; both are gone. Choosing is the action, so `widget-addPresetBtn` is not listed
   *  here — this table stays a list of widgets that EXIST. */
  presetPicker: 'widget-presetPicker',
  run: 'widget-runBtn',
} as const

/** Activate a right-dock view tab by title (both the QC + Cell-filter declarative views inspect
 *  the same accepted type, so they co-mount as sibling tabs — the target view's widgets are only
 *  visible when its tab is active).
 *
 *  IT WAITS for the tab rather than probing `count()` once. The pane it wants no longer exists at
 *  shell-mount time: the auto-mount gate keys on the project's PRODUCED type ids, which arrive from
 *  the catalog fetch one round trip after the workbench opens, so a one-shot probe could run before
 *  the tab existed, silently skip the click, and leave the caller's 20 s widget wait to time out on
 *  a pane that had mounted but was never brought to the front.
 *
 *  Absence stays tolerated (the surface may already be the sole/active pane, with no tab strip), so
 *  a genuinely-missing pane still fails at the caller's own widget assertion, which names it. */
async function activateViewTab(page: Page, title: string): Promise<void> {
  const tab = page.getByRole('tab', { name: title, exact: true }).first()
  await tab.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (await tab.count()) await tab.click().catch(() => {})
}

/** Wait for the declarative filter surface to have auto-mounted (its `Add criterion` control is
 *  present).
 *
 *  IT MOUNTS ONLY IF THE PROJECT HAS PRODUCED WHAT ITS OWNING ANALYSIS APPLIES TO. That is the
 *  auto-mount gate (`core/shell/dock/viewAutomountGate.ts`) and it is unconditional — it shipped
 *  behind a default-OFF flag for one owner comparison and the flag is gone. So the seeding above
 *  is now load-bearing for this helper in BOTH senses: it is what makes the surface appear, and
 *  what makes it usable.
 *
 *  The history is worth keeping because it cost real diagnosis time in the other direction. This
 *  comment ONCE said "the view mounts via `placeViews` once its inspected artifact type is
 *  present" while the code mounted every registered analysis' pane on every project, empty ones
 *  included — a `ViewContribution` carries no `appliesTo`, `computeAvailability` reads nothing
 *  else, and `[].every(…)` is `true`. Believing that sentence is what made two `14-workbench`
 *  assertions expect a LAUNCH to add this pane. Under the gate a launch still does not add it
 *  (launching does not produce an artifact); producing the artifact does.
 *
 *  MOUNTED IS NOT USABLE. The surface mounts on the mere PRESENCE of a compatible artifact; which
 *  one it operates on is a separate answer the user gives in the picker below, and the criteria
 *  builder offers nothing until they have. A spec that needs to build a criterion must therefore
 *  call {@link chooseSurfaceDataset} as well — UNLESS the project holds exactly ONE candidate, in
 *  which case the picker pre-selects it and the spec never notices the difference.
 *
 *  Every spec in this directory but two is in that lucky case, which is why the two that are not
 *  (several datasets; several modalities, each a subtype of the accepted type) were the only ones
 *  that broke when the builder's columns stopped coming from a project-wide report artifact and
 *  started coming from the axis of the CHOSEN one. Pre-selection was answering for the others. */
export async function awaitFilterSurface(page: Page): Promise<void> {
  await activateViewTab(page, 'Cell filter')
  await page.getByTestId(CF.add).first().waitFor({ state: 'visible', timeout: 20_000 })
}

/** The filter surface's own DATASET picker (`expressionPicker`). It is an `artifact_ref`, so
 *  WHICH testid it renders under is the candidate COUNT: none → `-empty`, one → a pre-selected
 *  `-summary`, two or more → a real `-select`. */
export const CF_DATASET = {
  empty: 'widget-expressionPicker-empty',
  summary: 'widget-expressionPicker-summary',
  select: 'widget-expressionPicker-select',
} as const

/**
 * CHOOSE the dataset this mask annotates, through the affordance a user has.
 *
 * The picker is a POPOVER (the kit `Select`): its rows do not exist until it is opened, and the
 * kit stamps each `${testid}-opt-${artifactId}`. Confirmed by what the control DISPLAYS — the
 * chosen rendering carries the artifact id it names — so a helper that stops committing fails
 * HERE rather than three assertions later.
 */
export async function chooseSurfaceDataset(page: Page, artifactId: string): Promise<void> {
  const picker = page.getByTestId(CF_DATASET.select)
  await picker.waitFor({ state: 'visible', timeout: 20_000 })
  await picker.click()
  await page.getByTestId(`${CF_DATASET.select}-opt-${artifactId}`).click()
  await expect(
    picker.locator(`[data-artifact-id="${artifactId}"]`),
    'the picker must DISPLAY the artifact it was given — what is launched is what was shown',
  ).toBeVisible({ timeout: 20_000 })
}

/**
 * The column names a criterion row OFFERS, sorted. Opens the row's column picker, reads it, and
 * closes it again — so it can be asked before a choice is made.
 *
 * This is the observation that makes "the builder is anchored on the dataset I chose" checkable:
 * the set is the axis of ONE dataset, so a resolver that leaked across datasets, or anchored on
 * the wrong one, shows up here as a set difference rather than as a plausible-looking criterion.
 *
 * ONE READING, never an assertion — pair it with {@link expectCriteriaColumns}, which polls it.
 * The frame behind these options is fetched, so it lands AFTER the control that depends on it has
 * rendered: measured across two runs, a single read taken straight after switching datasets
 * returned the empty list once and the PREVIOUS dataset's columns once. Both are real transient
 * states of the surface and neither is the answer.
 *
 * Opening is idempotent and the close is AWAITED, so a polling caller can never read the previous
 * iteration's still-open list. (The live-loop spec beside this one learned both halves locally
 * first; this is that lesson in the shared helper instead of a third copy of it.)
 */
export async function criteriaColumnOptions(page: Page, rowIdx: number): Promise<string[]> {
  const col = page.getByTestId(CFRow.col(rowIdx))
  await col.waitFor({ state: 'visible', timeout: 20_000 })
  await expect(col, CRITERIA_COLUMN_DISABLED).toBeEnabled({ timeout: 20_000 })
  if ((await col.getAttribute('aria-expanded')) !== 'true') await col.click()
  // …and WAIT for it to be open. The read below is one-shot over the DOM as it stands, and the
  // popover's rows do not exist until then, so a click that has not landed yet reads as "this
  // column offers nothing". The polling caller absorbs that, but this function is exported and
  // asking it once is a legitimate use — so the wait belongs here rather than in the poll.
  await expect(col).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })
  const prefix = `${CFRow.col(rowIdx)}-opt-`
  const names = await page
    .locator(`[role="option"][data-testid^="${prefix}"]`)
    .evaluateAll((nodes, p) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(p.length)), prefix)
  await page.keyboard.press('Escape')
  await expect(col).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 })
  return names.filter(Boolean).sort()
}

/** Assert the EXACT set a criterion row offers, polled to the frame's arrival.
 *
 *  Polling does not weaken the claim — the assertion is still set EQUALITY, so a leaked column, a
 *  missing one, or a stale anchor all fail. What it removes is the race: the alternative is a
 *  single read whose answer depends on whether an in-flight fetch had landed, which reports a
 *  correct surface as broken and would be "fixed" by a sleep. */
export async function expectCriteriaColumns(
  page: Page,
  rowIdx: number,
  expected: readonly string[],
  message: string,
): Promise<void> {
  await expect
    .poll(() => criteriaColumnOptions(page, rowIdx), { timeout: 30_000, message })
    .toEqual([...expected].sort())
}

/** Why a criterion row's column picker being DISABLED is worth naming rather than waiting out.
 *  The control disables when the axis it reads offers nothing, and the overwhelmingly common
 *  cause on this surface is that no dataset has been chosen — a state a bare `.click()` reports
 *  only as a two-minute timeout on an element that was visible the whole time. */
const CRITERIA_COLUMN_DISABLED =
  'the criterion column picker is DISABLED, i.e. the axis carries no columns. Either no dataset ' +
  'has been chosen yet (with 2+ candidates the picker pre-selects nothing — call ' +
  '`chooseSurfaceDataset` first) or the chosen dataset carries no per-row columns.'

/** The two controls the run-driving helper below touches, destructured ONCE. It is one binding
 *  rather than two lookups so this module's residue in the contributed-vocabulary ratchet
 *  (`scripts/lint-no-domain-in-builtin.mjs`) does not grow by a reference. */
// Exported so a spec drives these controls without naming the table again — one place the
// analysis' vocabulary appears in this module, which is what its guard residue is measured on.
export const {
  table: METRIC_TABLE,
  run: RUN_CONTROL,
  presetPicker: PRESET_PICKER,
} = QC

/**
 * Add ONE predefined metric through the affordance a user has: choose it in the catalog picker.
 * That is the whole gesture — choosing IS the action. `preset` is the metric's own name
 * (`pct_hb`), which is what the option commits.
 *
 * It is still two Playwright actions because the picker is a POPOVER — its rows do not exist
 * until it is opened — but it is ONE user gesture: open, choose, done.
 */
export async function addPresetMetric(page: Page, preset: string): Promise<void> {
  await awaitQcSurface(page)
  const picker = page.getByTestId(PRESET_PICKER)
  await picker.waitFor({ state: 'visible', timeout: 20_000 })
  const before = await page.getByTestId(new RegExp(`^${METRIC_TABLE}-edit-name-\\d+$`)).count()
  await picker.click()
  await page.getByTestId(`${PRESET_PICKER}-opt-${preset}`).click()
  // Confirm the METRIC LANDED, not that the picker still shows the choice.
  //
  // It used to assert `picker [data-value=preset]` and then press an Add button. Both encoded a
  // two-step flow that no longer exists: choosing IS the action now, and the add SPENDS the
  // choice so the control returns to its placeholder ready for the next one. So the old
  // assertion waited on a state the product deliberately clears, and the button it then pressed
  // was gone — the helper was pinned to the mechanism instead of the outcome.
  //
  // A row count rather than a name lookup: the row's own name field is what the user reads, but
  // it is editable and a later step may rewrite it, so the durable fact is that the table GREW.
  await expect(page.getByTestId(new RegExp(`^${METRIC_TABLE}-edit-name-\\d+$`))).toHaveCount(
    before + 1,
    { timeout: 20_000 },
  )
}

/** Wait for the declarative metric surface (its metric table). */
export async function awaitQcSurface(page: Page): Promise<void> {
  await activateViewTab(page, 'Compute QC metrics')
  await page.getByTestId(METRIC_TABLE).first().waitFor({ state: 'visible', timeout: 20_000 })
}

/** Add a criterion row and pick a seeded column in the row's column picker.
 *  Row `rowIdx` is the 0-based `for_each` index. `select` is either an OFFERED-option index
 *  (0-based, default 0) or `{ column }` to pick a column BY NAME — use the latter when the
 *  criterion's control type matters (a CONTINUOUS column like `nCount` yields min/max; a
 *  CATEGORICAL one like `ident` yields a keep-set), since the picker lists columns
 *  alphabetically so a positional index is control-blind.
 *  Seeded continuous columns are all ≥ 0, so a `max: -1` bound empties the keep-mask deterministically.
 *
 *  The picker is a POPOVER (the kit `Select`), not a native `<select>`: its rows do not exist
 *  in the DOM until it is opened, and the kit stamps each one `${testid}-opt-${value}`. So the
 *  choice is the two gestures a user makes — open, click the row — rather than `selectOption`,
 *  and it is confirmed by what the control DISPLAYS (`data-value`, the popover equivalent of
 *  `toHaveValue`) so a helper that stops committing fails here rather than three assertions later. */
export async function addCriterion(
  page: Page,
  rowIdx: number,
  select: number | { column: string } = 0,
): Promise<void> {
  await addCriterionRow(page)
  await pickCriterionColumn(page, rowIdx, select)
}

/** Add an EMPTY criterion row. Split out of {@link addCriterion} so a spec can INSPECT what the
 *  new row offers (`criteriaColumnOptions`) before committing to one of them — reading the offered
 *  set and then choosing from it is two questions about one row, not two rows. */
export async function addCriterionRow(page: Page): Promise<void> {
  await page.getByTestId(CF.add).first().click()
}

/** Choose a column in an EXISTING criterion row's picker (the second half of {@link addCriterion}). */
export async function pickCriterionColumn(
  page: Page,
  rowIdx: number,
  select: number | { column: string } = 0,
): Promise<void> {
  const col = page.getByTestId(CFRow.col(rowIdx))
  await col.waitFor({ state: 'visible', timeout: 20_000 })
  // NAMED, not waited out. A disabled picker is visible, so `.click()` retries against it until
  // the whole TEST budget is gone and then reports "element is not enabled" from inside a call
  // log — which is how "nobody chose a dataset" presented as an unexplained two-minute timeout
  // in two different specs.
  await expect(col, CRITERIA_COLUMN_DISABLED).toBeEnabled({ timeout: 20_000 })
  await col.click()
  const option =
    typeof select === 'number'
      ? page.locator(`[role="option"][data-testid^="${CFRow.col(rowIdx)}-opt-"]`).nth(select)
      : page.getByTestId(`${CFRow.col(rowIdx)}-opt-${select.column}`)
  await option.click()
  const chosen =
    typeof select === 'number'
      ? col.locator('[data-value]')
      : col.locator(`[data-value="${select.column}"]`)
  await expect(chosen).toBeVisible({ timeout: 20_000 })
}

/** Slack for the element waits a run-driving helper performs BESIDE its main run wait
 *  (surface mount → Run button → the terminal race's own settle, plus the review host's
 *  own open + paint). Measured off the explicit `timeout:` values in the two run-driving
 *  helpers: 20 + 20 + 30 + 5 s. */
export const RUN_HELPER_HEADROOM_MS = 90_000

/** The declared success toast the surface's own run action fires after its `wait_for` resolves
 *  the job to a terminal `completed`. It IS the completion signal for the declarative bridge
 *  (the same one `declarative-processor-ui.spec.ts` waits on), and it can only appear after the
 *  run genuinely finished: `waitForJob` REJECTS on a `failed`/`stopped` frame, which aborts
 *  `interpretBody` before the trailing `toast`. */
const RUN_SUCCESS_TOAST = 'QC metrics computed'

/** The analysis this surface's Run control dispatches (its view spec's `run_processor.id`).
 *  Returned by the helper so its callers — which live in vocabulary-free files — never name it. */
/** The analysis `runQcToCompletion` drives. Exported so a spec that needs to name the same
 *  analysis (its pane, its run list) reads it from here instead of repeating the literal —
 *  one spelling, and one place the domain vocabulary appears. */
export const RUN_ANALYSIS_ID = 'qc.10x'

/**
 * REAL-compute helper: run the analysis from its OWN contributed pane and wait for the declared
 * completion. Used by the REAL-compute guidance/toast/job-details specs + `runToReview`. The run
 * must genuinely COMPLETE (needs a privileged sandbox host + CYTO_ENV_ROOTFS_DIR). On run failure
 * it raises a CLEAR error — a skip is NOT a pass. Assumes the workbench is already open (the
 * caller runs `openWorkbench` first). Returns the analysis id it drove.
 *
 * ── WHY THIS NO LONGER GOES THROUGH THE LAUNCHER + A RUN PANE ────────────────────────────
 *
 * It used to click the launcher row, then `workbench-analysis-run-<id>`, then
 * `workbench-run-console-<id>`, then `workbench-flow-guidance-<id>`. Every one of those but the
 * first is gone for this analysis: it declares `ui:`, so the launcher click now reveals its OWN
 * pane and `AnalysisRunPanel` refuses to synthesize a rival slot-only form for it (INV-4 — the
 * fallback form omits an input the view adds, and a Run from it completed with that input unset
 * and reported zeros). The contributed pane's `widget-runBtn` is the ONLY surface that launches
 * this analysis now, and it is the one that passes every input it displayed.
 *
 * The Run control is `disabledWhen` its input list is empty, and the view SEEDS that list at
 * mount when the answer is unambiguous — so a still-disabled button means the seed did not take,
 * and is asserted rather than clicked through, so that failure reads as itself.
 */
export async function runQcToCompletion(page: Page, timeout = 120_000): Promise<string> {
  // The config's per-test budget is 120 s and this helper WAITS `timeout` for the run on top
  // of ~75 s of preceding element waits — so before this line every caller died of TEST
  // timeout before the loud run-failure diagnosis below could ever print, which is the one
  // run that most needs a diagnosis. Granted additively (`test.info().timeout + …`) so a
  // caller that already raised its own budget keeps it, and so the number lives with the
  // wait it pays for instead of being copied into each of the four call sites.
  test.setTimeout(test.info().timeout + timeout + RUN_HELPER_HEADROOM_MS)
  let failureText = ''
  await awaitQcSurface(page)

  const runBtn = page.getByTestId(RUN_CONTROL)
  await expect(
    runBtn,
    'the Run control must be ENABLED — it disables while its declared input list is empty, so a ' +
      'disabled button means the pane never seeded one (seed a runnable input first)',
  ).toBeEnabled({ timeout: 20_000 })
  await runBtn.click()

  // The declared success toast fires on completion; a rejected `wait_for` (a failed/stopped
  // run) is surfaced by `WidgetHost`'s dispatch catch as an ERROR toast instead. Race the two
  // so an unavailable sandbox fails LOUDLY with its own message rather than timing out on a
  // locator — an unexplained timeout is not a diagnosis.
  const success = page.getByText(RUN_SUCCESS_TOAST, { exact: false }).first()
  const failure = page.locator('[data-sonner-toast][data-type="error"]').first()
  // The OUTCOME is recorded as the race resolves, not re-observed from the DOM afterwards.
  //
  // The success toast is NOT sticky (only the job-completion toast is), so it auto-dismisses.
  // Re-asserting `toBeVisible` after the race is a SECOND observation of a disappearing thing:
  // it passes when the assertion happens to run inside the toast's lifetime and fails with
  // "element(s) not found" when it does not — reporting a run that demonstrably completed as
  // one that never finished. Observed exactly that way on a second consecutive run.
  // Each branch RESOLVES its outcome rather than assigning a captured one. The mutating form
  // read correctly and typechecked as nonsense: the writes happen inside `.then()` callbacks,
  // which TypeScript cannot order against the `await`, so it kept the declaration's narrowed
  // `'none'` and reported BOTH checks below as comparisons that can never be true. Resolving a
  // value states the same thing in a form the compiler can follow, and removes a variable two
  // callbacks were racing to write.
  const { outcome, text } = await Promise.race([
    success
      .waitFor({ state: 'visible', timeout })
      .then(() => ({ outcome: 'success' as const, text: '' }))
      .catch(() => ({ outcome: 'none' as const, text: '' })),
    failure
      .waitFor({ state: 'visible', timeout })
      .then(async () => ({
        outcome: 'failure' as const,
        text: await failure.innerText().catch(() => ''),
      }))
      .catch(() => ({ outcome: 'none' as const, text: '' })),
  ])
  failureText = text
  if (outcome === 'failure') {
    throw new Error(
      `the run FAILED — the compute sandbox could not complete ("${failureText}"). ` +
        'Needs a privileged host + a mounted rootfs / CYTO_ENV_ROOTFS_DIR under ' +
        'CYTO_E2E_REAL_COMPUTE. A skip is not a pass.',
    )
  }
  if (outcome !== 'success') {
    throw new Error(
      `the run never reported an outcome within ${Math.round(timeout / 1000)}s — neither the ` +
        'success toast nor an error toast appeared. The run may still be queued (a busy host), ' +
        'or the declared success toast was removed from the view.',
    )
  }

  // NO TOAST DISMISSAL HERE.
  //
  // This used to clear the sticky completion toast, and its fallback removed the toast nodes
  // directly:  `document.querySelectorAll('[data-sonner-toast]').forEach(t => t.remove())`.
  // That rips out DOM the toast library's React tree still owns, so its NEXT render tried to
  // `insertBefore` against a node that was no longer a child — `NotFoundError` — which the root
  // error boundary turned into "Something went wrong" over the whole app. It surfaced only on a
  // SECOND run, because that is when the toast layer next rendered, and it cost several runs to
  // find because the symptom (a run that never reports an outcome) looks nothing like the cause.
  //
  // A test helper may not mutate DOM the app owns. The reason the dismissal was added — a sticky
  // toast sitting over the shell chrome — was a REAL problem with a different cause, and it is
  // fixed at that cause: the region rail's "add a pane" trigger no longer overflows under the
  // pop-out button (`RegionShell`), so nothing needs the toast out of the way.

  return RUN_ANALYSIS_ID
}

/**
 * Commit a real filter keep-mask — the proven sequence from the live filter-commit
 * @acceptance spec, extracted so the virtual-dataset specs drive the filter surface the
 * SAME way rather than re-typing it (and drifting).
 *
 * The upstream quality run PRODUCES the metadata column the criterion is built on
 * (`total_counts`); the filter surface then adds a criterion on it with a `min` threshold,
 * names the mask, and clicks "Commit keep-mask". Returns the mask LABEL once the
 * "Keep-mask committed" toast confirms the run finished — which is what fires the
 * server-side finalize sink that mints the `source='filter'` virtual dataset (DEC-6). The
 * committed mask carries `meta.filter_mask{label}`, the marker
 * `workstore::virtual_dataset::filter_mask_of` recognises.
 *
 * REAL-compute only — the commit is a genuine sandbox run. Callers are already behind
 * `test.skip(!REAL_COMPUTE, …)`.
 */
export async function commitFilter(
  page: Page,
  opts: { column?: string; min?: number; label?: string } = {},
): Promise<string> {
  const column = opts.column ?? 'total_counts'
  const label = opts.label ?? 'strict'
  const min = opts.min ?? 42
  // The upstream analysis PRODUCES the metadata column the criterion is built on.
  await runQcToCompletion(page)
  await awaitFilterSurface(page)

  // A first empty criterion row. The produced column arrives EVENT-DRIVEN (the catalog refresh
  // that carries the finished quality run's new artifacts), so poll the picker until it OFFERS the
  // column rather than reading once and racing a real absence against a late arrival.
  await page.getByTestId(CF.add).click()
  const col = page.getByTestId(CFRow.col(0))
  await col.waitFor({ state: 'visible', timeout: 20_000 })
  await expect
    .poll(
      async () => {
        if ((await col.getAttribute('aria-expanded')) !== 'true') await col.click()
        const present = (await page.getByTestId(`${CFRow.col(0)}-opt-${column}`).count()) > 0
        await page.keyboard.press('Escape')
        return present
      },
      {
        timeout: 60_000,
        message: `the filter criteria picker never offered the upstream-produced column "${column}"`,
      },
    )
    .toBe(true)

  // A criterion that keeps a STRICT SUBSET (total_count >= min).
  await addCriterion(page, 0, { column })
  const minField = page.getByTestId(CFRow.min(0))
  await minField.fill(String(min))
  await minField.blur()
  // The mask NAME. `fill` REPLACES the field's default (`keep`) — an `type()` would append.
  await page.getByTestId(CF.label).fill(label)
  await page.getByRole('button', { name: 'Commit keep-mask' }).click()

  await expect(
    page.getByText('Keep-mask committed', { exact: false }),
    'the filter commit run never completed — its finalize sink is what mints the filter VD. ' +
      'A timeout here is the RUN failing, not the UI (check the CYTO_ENV_ROOTFS_SQUASHFS seam).',
  ).toBeVisible({ timeout: 180_000 })
  return label
}

/** The SHIPPED wording of the binding-origin mark, re-exported for the e2e tier.
 *
 *  A spec asserting a re-typed twin of a user-facing string passes while the product says
 *  something else — which is the failure a single copy table exists to prevent, and which one
 *  spec in this suite hit for real (it asserted `/auto/i` against a mark that reads "Chosen
 *  for you"). Imported from the same object the components render, so the two cannot drift. */
export const ARTIFACT_REF_ORIGIN_MARK = BINDING_ORIGIN_COPY.autoBound
