// The job-result DATA RESOLVER (PLAN.md ITEM-9 / DRIFT-3.5) — the last-mile seam that
// turns a declarative `view_spec`'s `data` declarations
// (`{ obs: { source: job.result, args: { path: /obs } }, vis2D: … }`) into the resolved
// columnar slices the reactive store's `derived` primitives + the `@ziee/viz` sources read
// (`buildScatterSource`/`buildViolinSource` over `$data.obs`).
//
// The RESOLVER is pure + injectable (a `readSlice` callback that yields each slice's parsed
// artifact payload), so a unit test drives it with a SYNTHETIC `/obs` slice and no backend.
// The React binding (`resolveAndApplyViewData`) is the thin wire to the real serve surface
// that pushes the resolved slices into the shared store via `store.setData`. The slice's
// DATATYPE is taken from the view's DECLARED `data.<slice>.args.datatype` (INV-6 — NOT a
// hardcoded `report/qc`), so a non-QC processor's slice resolves against its own datatype.
//
// OBS WIRE (artifact-model ITEM-25): the obs slice is read through the TYPED read surface
// (ITEM-29) — `readColumn({expect: 'table'})`, which DECLARES what this resolver expects
// and fails at the boundary naming both kinds when the artifact holds something else,
// rather than decoding a `sparse_csc` matrix as a table with no columns. Underneath it is
// `readTable`: it opens the artifact's DECLARED members and range-reads each column's
// chunks — replacing `readTableArrow`, which fetched `GET /read?<selection>` and decoded an
// Arrow-IPC body the SERVER had transcoded from a JSON blob. The wire shape downstream is
// unchanged: a row-major `{columns, rows}` table, transposed here to the columnar
// `{ col: values[] }` slice the store's `derived` primitives + the viz sources read.
//
// The declaration is passed IN (`structure: newest.structure`) so the read needs no second
// `GET /artifacts/{id}` — the row the query already returned carries it (ITEM-25).
//
// Three things improve and nothing downstream notices. Columns are fetched CONCURRENTLY and
// chunk by chunk (it was one blocking fetch of the whole table). A categorical column arrives
// as codes + its DECLARED level set rather than as N repeated strings. And the server no
// longer parses the artifact to answer (INV-1) — it hands back byte ranges.

import type { DataSourceSpec, ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { resolveOrThrow, type WorkbenchAPI } from '@/modules/workbench/core'
// The capability CONTRACTS are TYPE-ONLY imports (erased at build), and the ids are plain
// string literals — so core keeps a compile-time reference to an extension's published
// shape without a runtime core→extensions edge (INV-6: routing is by id).
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import {
  parseStructure,
  readCategoricalColumn,
  readColumn,
  readDeclaredLevels,
  readSparseColumn,
  ERR_NOT_CONFORMING,
  ERR_UNRESOLVABLE,
  UnsupportedArtifactStructure,
  WorkstoreHttpError,
  WorkstoreTypeMismatch,
  type TableData,
} from '@/core/workstore'
import { datatypeRegistry } from '@/core/datatypes/registry'
import { getViewStore } from './viewStores'
import { currentPaneScope } from './paneScope.store'
import {
  AXIS_COLUMNS_AS_SOURCES,
  AXIS_COLUMNS_PRODUCED_BY_OTHERS,
  AXIS_COLUMNS_SOURCE,
  anchorId,
  anchorIds,
  axisColumnRows,
  axisColumnSourcesFor,
  criterionColumnNames,
  readAxisColumnsFrame,
  tableColumns,
  anchorCoordinate,
  correspondenceGather,
  gatherFor,
  resolveRowSpaceAnchor,
  viewOwnAnalysisIds,
  type RowSpaceAnchor,
} from './axisSource'
import {
  ROW_SPACE_COLUMNS_SOURCE,
  resolveRowSpaceColumns,
  type RowSpaceColumnsArgs,
} from './rowSpaceColumns'
import { PANE_FRAME_SOURCE, resolvePaneFrame, type PaneFrameArgs } from './paneFrame'
import {
  INTEGRATION_GRID_SOURCE,
  resolveIntegrationGrid,
  type IntegrationGridArgs,
} from './integrationGrid'
import {
  COMPATIBLE_COLUMNS_SOURCE,
  resolveCompatibleColumns,
  type CompatibleColumnsArgs,
} from './compatibleColumns'
import {
  CONTAINER_MEMBERS_SOURCE,
  resolveContainerMembers,
  type ContainerMembersArgs,
} from './containerMembers'
import { COLUMN_VALUES_SOURCE, readColumnValues, toColumnRequests } from './columnValues'
import {
  AXIS_ENTRIES_SOURCE,
  AXIS_ENTRY_VALUES_AS_SOURCES,
  AXIS_ENTRY_VALUES_SOURCE,
  readEntryValuesFrame,
  resolveAxisEntries,
  resolveEntryAxes,
  resolveEntrySources,
  type AxisEntriesArgs,
  type AxisEntryValuesArgs,
  type EntryAxis,
  type EntrySource,
} from './axisEntries'
import {
  AXIS_ENTRY_ROWS_SOURCE,
  resolveAxisEntryRows,
  resolveKeyLabel,
  type AxisEntryRowsArgs,
} from './axisEntryRows'
import { evalExpr, type Scope } from './expr'
import { declarationsOf } from './columnDeclarations'
import {
  aggregateDataStatus,
  errorMessage,
  sliceDatatype,
  type DataStatus,
  type SliceResolution,
} from './dataStatus'
import type { Data } from './store'

// NOTE: `sliceDatatype` / `DataStatus` / `SliceResolution` are DEFINED in `./dataStatus` (so
// the STORE can share them without depending on the resolver) and are imported from there by
// every consumer. They are deliberately NOT re-exported here — one symbol, one import path.

/** Read one declared slice → its CLASSIFIED resolution (`ready` + payload / `empty` /
 *  `error` + message). Injected so the pure resolver runs with no backend.
 *
 *  The classification (rather than the old bare `unknown | undefined`) is what makes F3
 *  fixable: the fetch site is the ONLY place that knows whether "no data" meant "the query
 *  failed" or "there is genuinely nothing yet", and it used to throw that away into a
 *  `console.error`. */
export type ReadSlice = (
  key: string,
  decl: DataSourceSpec,
  /** The SPEC the slice was declared in — supplied by {@link resolveViewData} rather than
   *  closed over by each caller. A slice may narrow itself by a property of its own view
   *  (`produced_by: others` asks about the analyses the view LAUNCHES), and threading the
   *  spec through the reader is what makes production and every test resolve that from the
   *  same object: a caller that closed over its own copy could hand the reader a spec the
   *  resolver never saw, and pass while production did nothing. */
  spec: ViewSpec,
) => Promise<SliceResolution | undefined>

/**
 * The `data.<slice>.source` values this resolver knows how to read. A slice naming anything
 * else is SKIPPED (it contributes neither data nor status), which is what lets a purely
 * state-driven view avoid being pinned on a skeleton (DEC-3). `axis_columns` (ITEM-11)
 * joined `job.result` here: both land the same columnar frame, they differ only in WHAT is
 * authoritative — the newest artifact of a declared datatype, versus whatever the anchored
 * dataset's axis actually carries.
 *
 * **This set is the gate, and `readSliceFromApi`'s dispatch is NOT.** A source handled below
 * but absent from here is dead: `resolveViewData` `continue`s past the slice and the branch
 * is never reached. `row_space_columns` shipped in exactly that state — its resolver, its
 * tests and the two shipped section slices that name it were all correct, and the section
 * populated nothing in the app because the slice never reached the reader. The two are kept
 * adjacent, and `viewData.test.ts` asserts that every source the reader dispatches on is
 * listed here, so the next one cannot be half-wired.
 */
/**
 * THE DISPATCH TABLE — the single place a resolved source's name is written down.
 *
 * It used to be an `if`-chain in `readSliceFromApi` with the gate below as a SECOND,
 * hand-written list of the same names. Two hand-maintained lists of one fact is the exact
 * shape that shipped `row_space_columns` dead, and the test that was supposed to prevent it
 * hand-listed the names a THIRD time (and omitted `pane_frame` + `column_values`, the two the
 * whole emit model rests on — so deleting `COLUMN_VALUES_SOURCE` killed every emitted plot
 * with the unit tier green).
 *
 * Now there is one table and the gate is DERIVED from its keys, so gate/dispatch drift is not
 * REPRESENTABLE — which is a stronger guarantee than any test could give, and the reason the
 * test below iterates the derived set rather than asserting an equality that is now true by
 * construction. A new source is wired by adding one entry; it cannot be half-wired.
 */
/**
 * Progressive-landing context threaded to the (few) slice readers that STREAM (incremental-landing
 * ITEM-7). A reader calls `land({ [sliceKey]: partialPayload }, done)` to paint the slice's rows as
 * they arrive; the resolver still lands the authoritative WHOLESALE payload at the end, so the final
 * state equals the wholesale one. Absent for a non-progressive resolve (every reader that does not
 * stream simply ignores it), so this changes nothing for the wholesale path.
 */
export interface SliceLandingCtx {
  land: (partial: Record<string, unknown>, done: boolean) => void
}

/**
 * The landing-site MERGE-vs-REPLACE rule (incremental-landing ITEM-1 / TEST-8). A `partial`
 * resolution — like `error` and `unreadable` — means MORE is still coming (or a partial failure),
 * so it must KEEP whatever a previous landing already put in the store and merge the new slices in;
 * the wholesale-replace branch would discard the earlier rows. `viewData.ts`'s original
 * `res.status === 'error' || res.status === 'unreadable'` was a SILENT-FALLTHROUGH site: a
 * `partial` nobody added an arm for would compile cleanly and fall through to REPLACE. Extracted as
 * a pure function so the arm is asserted directly (TEST-8) rather than trusted to the type system.
 */
export function landedData(
  prev: Record<string, unknown>,
  status: DataStatus,
  resData: Record<string, unknown>,
): Record<string, unknown> {
  return status === 'error' || status === 'unreadable' || status === 'partial'
    ? { ...prev, ...resData }
    : resData
}

const SLICE_READERS: Record<
  string,
  (
    api: WorkbenchAPI,
    key: string,
    decl: DataSourceSpec,
    scope: Scope | undefined,
    spec: ViewSpec | undefined,
    land: SliceLandingCtx | undefined,
  ) => Promise<SliceResolution | undefined>
> = {
  [AXIS_COLUMNS_SOURCE]: (api, key, decl, scope, spec) => readAxisColumnsSlice(api, key, decl, scope, spec),
  [ROW_SPACE_COLUMNS_SOURCE]: (api, key, decl, scope) => readRowSpaceColumnsSlice(api, key, decl, scope),
  [COMPATIBLE_COLUMNS_SOURCE]: (api, key, decl, scope) => readCompatibleColumnsSlice(api, key, decl, scope),
  [CONTAINER_MEMBERS_SOURCE]: (_api, key, decl) => readContainerMembersSlice(key, decl),
  [INTEGRATION_GRID_SOURCE]: (api, key, decl, scope) => readIntegrationGridSlice(api, key, decl, scope),
  [AXIS_ENTRIES_SOURCE]: (api, key, decl, scope) => readAxisEntriesSlice(api, key, decl, scope),
  [AXIS_ENTRY_VALUES_SOURCE]: (api, key, decl, scope) => readAxisEntryValuesSlice(api, key, decl, scope),
  [AXIS_ENTRY_ROWS_SOURCE]: (api, key, decl, scope) => readAxisEntryRowsSlice(api, key, decl, scope),
  [PANE_FRAME_SOURCE]: (api, key, decl, scope) => readPaneFrameSlice(api, key, decl, scope),
  [COLUMN_VALUES_SOURCE]: (api, key, decl, scope, _spec, land) =>
    readColumnValuesSlice(api, key, decl, scope, land),
}

/** The sources served by the GENERIC tail of `readSliceFromApi` (newest-artifact-of-a-datatype),
 *  which has no entry in the table above because it is the fallthrough rather than a branch. */
const GENERIC_SOURCES = ['job.result'] as const

export const RESOLVED_SOURCES: ReadonlySet<string> = new Set<string>([
  ...GENERIC_SOURCES,
  ...Object.keys(SLICE_READERS),
])

/** What `resolveViewData` yields: the columnar slices the store bakes as `$data`, plus the
 *  region-level status (worst-of across the declared slices) and, on failure, the message. */
export interface ViewDataResolution {
  data: Record<string, unknown>
  status: DataStatus
  error?: string
  /** The SERVER's user-facing sentence for the failure, when it wrote one (ITEM-41). */
  hint?: string
}

/**
 * Resolve a `view_spec`'s `data` declarations into the `{ key → columnar slice }` record the
 * store bakes as `$data`, PLUS the region-level `DataStatus`. Only `source: job.result`
 * slices are resolved here (the sole source this round); a slice the injected reader skips
 * entirely (`undefined`) contributes neither data nor status — a spec whose every slice is
 * skipped therefore aggregates to `ready`, so a purely state-driven view is never pinned on
 * a skeleton (DEC-3). Pure: all IO is the injected `readSlice`.
 */
/** Already-warned `key\u0000source` pairs, so a re-render loop logs ONCE, not per frame. */
const warnedSources = new Set<string>()

/**
 * Say so — LOUDLY, in development — when a view declares a source this build cannot resolve.
 *
 * Dev-only `console.warn` and deliberately not a throw: an app older than the spec it is
 * handed must keep working, and the region already tells the USER what it cannot load. This
 * half is for the author, who is otherwise debugging a widget that renders empty for no
 * visible reason. Same treatment, and the same reasoning, as the artifact-status
 * `BUCKET_ORDER` fallback.
 */
function warnOnUnsupportedSource(key: string, source: string): void {
  if (!import.meta.env.DEV) return
  const seen = `${key}\u0000${source}`
  if (warnedSources.has(seen)) return
  warnedSources.add(seen)
  console.warn(
    `[declarative] viewData: data slice "${key}" declares source "${source}", which this build ` +
      `has no reader for — the slice resolves to nothing and any widget bound to $data.${key} ` +
      `will render empty. Known sources: ${[...RESOLVED_SOURCES].sort().join(', ')}. ` +
      'Add a reader to SLICE_READERS, or correct the spec.',
  )
}

/** The user-facing sentence for an unresolvable source. Names the slice AND the source: a
 *  message that says only "unsupported" leaves the reader to find which of several slices
 *  it means. */
function unsupportedSourceMessage(key: string, source: string): string {
  return `data slice "${key}" declares source "${source}", which this version of the app has no reader for.`
}

export async function resolveViewData(
  spec: ViewSpec,
  readSlice: ReadSlice,
): Promise<ViewDataResolution> {
  const out: Record<string, unknown> = {}
  const parts: SliceResolution[] = []
  for (const [key, decl] of Object.entries(spec.data ?? {})) {
    if (!decl) continue
    // A source this build has NO READER for is CLASSIFIED, not skipped.
    //
    // It used to `continue` beside the `!decl` case above, so a slice naming an invented or
    // newer-than-this-build source contributed no data AND no status — and a view whose only
    // slice was unrecognised therefore aggregated to a clean `ready` and rendered widgets
    // bound to `$data.<key>` with nothing in them. A blank surface, reported healthy, which
    // is the failure mode that survives every check there is because nothing is broken as
    // far as any of them can tell.
    //
    // Note the asymmetry with `!decl` above, which is still skipped: a missing declaration is
    // not a slice at all, whereas THIS is a slice the author wrote and the app cannot honour.
    if (!RESOLVED_SOURCES.has(decl.source)) {
      warnOnUnsupportedSource(key, decl.source)
      parts.push({ status: 'unsupported', error: unsupportedSourceMessage(key, decl.source) })
      continue
    }
    const res = await readSlice(key, decl, spec)
    if (res === undefined) continue
    parts.push(res)
    if (res.status === 'ready' && res.payload !== undefined) out[key] = res.payload
  }
  const { status, error, hint } = aggregateDataStatus(parts)
  return { data: out, status, error, hint }
}

// ── the React binding: resolve via the real host hook + push into the shared store ───────

/**
 * Transpose a row-major table (`{columns, rows}` — what `readTable` yields) back into the
 * columnar `{ col: values[] }` slice the store's `derived` primitives + the viz sources read.
 * This is the SHAPE the retired `{obs:{col:[…]}}` JSON path produced, so the downstream
 * widgets are unaffected by the wire swap.
 *
 * It is also the ONE expression that mints every resolved slice, and it assigns an ARRAY per
 * column (`rows.map`). That is why the resolver hands payloads through UNCHANGED: the retired
 * `extractObsSlice` unwrapped a `{ obs: <plain object> }` payload, a shape this transposition
 * cannot produce for any input (C7). Pinned by the C7 tests in `viewData.test.ts`.
 */
export function columnarFromTable(table: TableData): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  table.columns.forEach((name, ci) => {
    out[name] = table.rows.map(row => row[ci])
  })
  return out
}

/**
 * Read one slice's columns off the artifact's declared members and transpose to the columnar
 * `{ col: values[] }` slice the widgets read.
 *
 * NON-THROWING, and — since ITEM-1 — CLASSIFYING. A failure (query threw / read threw) is
 * `error` and carries its message so the region can NAME it; a genuine no-data outcome (no
 * artifact of the declared datatype, or a served table with zero rows) is `empty`. Those two
 * used to be the same `undefined`, which is exactly what made a backend-down region
 * indistinguishable from an untouched project (F3). A slice that declares no datatype is
 * skipped entirely (`undefined`) and contributes NO status.
 *
 * The failure is still `console.error`-logged: the returned `error` status is the USER-facing
 * half, the log is the developer-facing half (stack + cause), and losing it would be an
 * observability regression on a real backend-down.
 */
/** Analysis ids a `job.result` slice narrows to, `undefined` when it declares none, and the
 *  sentinel `'malformed'` when it declares something this build cannot read.
 *
 *  A malformed value is NOT treated as "no narrowing": that would silently widen the slice
 *  back to newest-of-datatype, which is exactly the shadowing defect `produced_by` exists to
 *  close. Absence of a decision is not a privilege. */
function slicedProducedBy(decl: DataSourceSpec): string[] | undefined | 'malformed' {
  const raw = (decl.args as { produced_by?: unknown } | undefined)?.produced_by
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return 'malformed'
  if (!list.every(v => typeof v === 'string' && v.trim() !== '')) return 'malformed'
  return list as string[]
}

/**
 * WHICH SHAPE the artifact behind this slice holds — `table` (the historical default) or
 * `document`. `'malformed'` when it declares something this build cannot read.
 *
 * The default has to stay `table` or every shipped view changes meaning, and the malformed
 * arm has to REFUSE rather than fall back to that default, on the same rule `produced_by`
 * established: a declaration this build cannot read is not a licence to pick the historical
 * behaviour, because the author wrote it precisely to get something else.
 */
function sliceShape(decl: DataSourceSpec): 'table' | 'document' | 'malformed' {
  const raw = (decl.args as { shape?: unknown } | undefined)?.shape
  if (raw === undefined || raw === null) return 'table'
  if (raw === 'table' || raw === 'document') return raw
  return 'malformed'
}

/** The `kind` discriminator a document slice REQUIRES its artifact to carry, `undefined` when
 *  it declares none, `'malformed'` when it declares something unreadable. */
function sliceKind(decl: DataSourceSpec): string | undefined | 'malformed' {
  const raw = (decl.args as { kind?: unknown } | undefined)?.kind
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  return 'malformed'
}

/** Already-warned slices, so a re-render loop logs once. */
const warnedProducedBy = new Set<string>()
const warnedShape = new Set<string>()

/** Say so in development when a slice's SHAPE declaration cannot be read, or when the artifact
 *  behind it does not hold the shape it declared. Dev-warn, never a throw: a client older than
 *  its server must keep working, and this whole arm exists because the alternative — deciding
 *  quietly — rendered a wrong surface in silence. */
function warnOnShape(key: string, detail: string): void {
  if (!import.meta.env.DEV) return
  const seen = `${key}\u0000${detail}`
  if (warnedShape.has(seen)) return
  warnedShape.add(seen)
  console.warn(`[declarative] viewData: data slice "${key}" ${detail}`)
}

/** Say so in development when `produced_by` cannot be read — the author is otherwise looking
 *  at a slice that resolves to nothing for no visible reason. Dev-warn, never a throw. */
function warnOnMalformedProducedBy(key: string, raw: unknown): void {
  if (!import.meta.env.DEV) return
  if (warnedProducedBy.has(key)) return
  warnedProducedBy.add(key)
  console.warn(
    `[declarative] viewData: data slice "${key}" declares produced_by=${JSON.stringify(raw)}, ` +
      'which must be an analysis id or a non-empty list of them. The slice resolves to nothing ' +
      'rather than falling back to the newest artifact of its datatype.',
  )
}

export async function readSliceFromApi(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope?: Scope,
  spec?: ViewSpec,
  /** Progressive-landing context (ITEM-7) — forwarded to a reader that streams; ignored by the
   *  rest. Absent for a non-progressive resolve. */
  land?: SliceLandingCtx,
): Promise<SliceResolution | undefined> {
  // ONE dispatch, from the ONE table the gate is derived from — see `SLICE_READERS`.
  //
  // `Object.hasOwn`, not a bare index: a plain object literal inherits `Object.prototype`, so
  // `decl.source === 'constructor'` (or `toString`, `valueOf`) would index to a truthy INHERITED
  // function and then CALL it. `resolveViewData` gates on `RESOLVED_SOURCES` first and would not
  // reach it, but `readSliceFromApi` is exported and called directly by tests and callers. The
  // `if`-chain this replaced had no such case, and a refactor must not add one.
  const reader = Object.hasOwn(SLICE_READERS, decl.source) ? SLICE_READERS[decl.source] : undefined
  if (reader) return reader(api, key, decl, scope, spec, land)
  const datatype = sliceDatatype(decl)
  if (!datatype) return undefined

  // WHICH SHAPE this binding expects, decided BEFORE anything is fetched — an unreadable
  // declaration must cost no request, and must not be answered with the default. Both
  // refusals follow `produced_by`'s rule below: a declaration this build cannot read is not a
  // licence to pick the historical behaviour, because the author wrote it to get something else.
  const shape = sliceShape(decl)
  if (shape === 'malformed') {
    warnOnShape(
      key,
      `declares shape=${JSON.stringify((decl.args as { shape?: unknown }).shape)}, which must be ` +
        '"table" or "document". The slice resolves to nothing rather than falling back to a table read.',
    )
    return {
      status: 'unsupported',
      error: `data slice "${key}" declares a "shape" this build cannot read — it must be "table" or "document".`,
    }
  }
  const declaredKind = sliceKind(decl)
  if (declaredKind === 'malformed') {
    warnOnShape(
      key,
      `declares kind=${JSON.stringify((decl.args as { kind?: unknown }).kind)}, which must be a ` +
        'non-empty string naming the document discriminator.',
    )
    return {
      status: 'unsupported',
      error: `data slice "${key}" declares a "kind" this build cannot read — it must be a non-empty string.`,
    }
  }

  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let rows: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    rows = await data.artifacts.query({ type: datatype })
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for "${key}" (${datatype})`, e)
    return { status: 'error', error: `Could not load "${key}" (${datatype}): ${errorMessage(e)}` }
  }
  // NARROW TO THE PRODUCING ANALYSIS, when the slice names one.
  //
  // Without this a `job.result` slice says only "the newest artifact of this datatype", and a
  // datatype is shared: one opaque-JSON datatype is emitted by the demo analysis, by a
  // sibling integrator's summary sidecar, and — decisively — by the very analysis whose
  // form is doing the reading. So a form reading its preflight's output bound correctly until the
  // first real run, after which a DIFFERENT artifact of the same datatype became newest, the
  // expected keys were absent, and the table rendered its empty state. A correct-looking
  // form over the wrong artifact, failing no gate — and invisible to a test written against
  // a fresh database, because the artifact that shadows it does not exist until a run
  // happens.
  //
  // `generator_id` is the producing analysis, derived server-side; `axis_columns`'
  // `produced_by: others` already answers the same question from the same field, so this
  // exposes an answer the catalog has rather than inventing a mechanism.
  const producedBy = slicedProducedBy(decl)
  if (producedBy === 'malformed') {
    warnOnMalformedProducedBy(key, (decl.args as { produced_by?: unknown }).produced_by)
    return {
      status: 'unsupported',
      error: `data slice "${key}" declares a "produced_by" this build cannot read — it must be an analysis id or a non-empty list of them.`,
    }
  }
  // A DECLARED narrowing that matches nothing yields NOTHING. It deliberately does NOT fall
  // back to newest-of-datatype: that fallback is the defect above wearing a parameter that
  // looks like it is doing something, which is strictly worse than not having the parameter.
  const candidates = producedBy ? rows.filter(r => producedBy.includes(r.generator_id ?? '')) : rows
  const newest = [...candidates].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (!newest) return { status: 'empty' } // genuine no-data — expected, silent.

  // ── THE DOCUMENT ARM ────────────────────────────────────────────────────────────────────
  //
  // A `job.result` artifact is not always a columnar table. Several producers write a
  // `kind`-tagged JSON object whose members are unrelated and of unequal length, and the
  // columnar reader zips every array-valued key to `max(len)`, pads the short ones with nulls
  // and drops everything that is not an array. Measured on a real producer's bytes that turned
  // `{kind, sources[2], normalize[0], candidates[1]}` into two rows — one real, one blank —
  // with `kind` gone: a table bound to it rendered a phantom row, and the field identifying
  // WHICH artifact it was never reached the view.
  //
  // So the shape is declared and the mismatch is REFUSED. `unsupported` rather than `error`,
  // because it is deterministic: retrying cannot clear a binding that expects columns over an
  // artifact that holds a document, and reporting a retryable fault sends someone to debug a
  // backend that is fine.
  if (shape === 'document') {
    let document: Record<string, unknown>
    try {
      document = await readColumn({ id: newest.id, expect: 'document', structure: newest.structure })
    } catch (e) {
      return readFailure(key, datatype, newest.id, e)
    }
    // The DISCRIMINATOR, checked — this is the field the columnar decode used to drop, so a
    // binding that names it is asserting exactly the thing that used to be unobservable.
    if (declaredKind !== undefined) {
      const actual = document.kind
      if (actual !== declaredKind) {
        const seen = typeof actual === 'string' ? `"${actual}"` : '(none)'
        warnOnShape(key, `expects a "${declaredKind}" document but artifact ${newest.id} carries ${seen}`)
        return {
          status: 'unsupported',
          error: `data slice "${key}" expects a "${declaredKind}" document but the newest matching artifact carries kind ${seen}.`,
        }
      }
    }
    if (Object.keys(document).length === 0) return { status: 'empty' }
    return { status: 'ready', payload: document }
  }

  let table: TableData
  try {
    table = await readColumn({ id: newest.id, expect: 'table', structure: newest.structure })
  } catch (e) {
    return readFailure(key, datatype, newest.id, e)
  }
  if (table.rows.length === 0) return { status: 'empty' } // genuine empty serve — expected.
  return { status: 'ready', payload: columnarFromTable(table) }
}

/**
 * Classify a failed artifact read: DETERMINISTIC (this build cannot decode what the producer
 * declared, or the artifact does not hold the shape the binding declared) versus RETRYABLE
 * (the transport failed).
 *
 * The split matters at the surface: `unsupported`'s copy says the build and the spec disagree,
 * `error`'s sends the user to the server. Collapsing the two — in either direction — is how a
 * shape mismatch reads as an outage, or an outage reads as a permanent refusal.
 */
function readFailure(
  key: string,
  datatype: string,
  artifactId: string,
  e: unknown,
): SliceResolution {
  console.error(`[declarative] viewData: artifact read failed for "${key}" (artifact ${artifactId})`, e)
  const detail = `Could not read "${key}" (${datatype}): ${errorMessage(e)}`
  if (e instanceof UnsupportedArtifactStructure || e instanceof WorkstoreTypeMismatch) {
    return { status: 'unsupported', error: detail }
  }
  // ── THE SERVER FOUND IT AND REFUSED TO SERVE IT (ITEM-41 / INV-9) ───────────────────────
  //
  // A 409 carrying `ARTIFACT_UNRESOLVABLE` or `ARTIFACT_NOT_CONFORMING` is NOT a transport
  // fault. The artifact was located, the server opened the question and answered it
  // definitively: the bytes were condemned, or the alignment's source is gone. Reporting that
  // as `error` puts "the server may be unavailable, or you may not have access" over an
  // artifact whose server is fine and whose permissions are fine — vaguer than what is
  // actually known, and pointing at the wrong thing to go and fix.
  //
  // `unreadable` is the value that exists for exactly this: "the inputs for this view are
  // here, but none of them could be read." Its `details` carry the server's own message,
  // which NAMES the missing source — so INV-9's "name the missing or changed source" survives
  // to the surface instead of being flattened into a generic fault.
  //
  // The two codes deliberately share this arm at the REGION level while staying distinct on
  // the wire and in the artifact listing, which is where the remedies differ (restore the
  // source vs delete/re-run). A region cannot offer either remedy; what it must not do is
  // claim a server outage.
  if (isUnreadableArtifactRefusal(e)) {
    // `hint` carries the SERVER's sentence, which names the missing source and states the
    // remedy. Taken from the field rather than by stripping this module's own prefix off
    // `message` — recovering a fact by regexing prose is what `errorCode` exists to stop.
    const hint = e instanceof WorkstoreHttpError ? e.serverMessage : undefined
    return { status: 'unreadable', error: detail, hint }
  }
  return { status: 'error', error: detail }
}

/** Did the server LOCATE this artifact and refuse to serve it, as opposed to failing to
 *  answer at all? Keyed on the machine-readable `errorCode` the client already carries —
 *  never on parsing the prose, which is the whole reason that field was plumbed through. */
function isUnreadableArtifactRefusal(e: unknown): boolean {
  if (!(e instanceof WorkstoreHttpError)) return false
  return e.errorCode === ERR_UNRESOLVABLE || e.errorCode === ERR_NOT_CONFORMING
}

/**
 * Read a `row_space_columns` slice (visualize-pane ITEM-37/ITEM-44): the columns OFFERED
 * against the anchored row space, described from their catalog rows alone.
 *
 * The one data-plane fact about it: it makes NO `readColumn` at all — the whole point
 * (INV-11 / INV-8). It makes two catalog-side calls, in sequence: the project catalog (for
 * the anchor's axis identities) and then the artifact list. The second is NARROWED by the first
 * (ITEM-31): `on_axis` drops the rows that positively declare a different axis, which on a
 * multi-dataset project is most of the catalog. The narrowing is a strict SUPERSET of what
 * this resolver then offers — asserted server-side by TEST-47 — so it changes the SIZE of the
 * response and nothing about the answer. The offering decision stays here, in TypeScript,
 * where A1/A2/A3/A4 is unit-testable without a database. It is deliberately always `ready`,
 * never `empty` and never skipped, because the two emptinesses a section must tell apart
 * (no anchor vs anchored-and-offering-nothing) both have to reach the view, and a slice
 * STATUS carries only one of them. They travel in the payload's `anchored`/`count`.
 *
 * A query failure is still `error` with its message, on the same rule as every other slice:
 * a backend-down section must not read as an untouched project.
 */
async function readRowSpaceColumnsSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as RowSpaceColumnsArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  // The anchor's axis IDENTITIES, as `$scope.axis` carries them (content hashes). Resolved
  // before the artifact list so the list can be narrowed by what they declare.
  const anchorHashes = anchorIds(args.aligned_to, scope ?? {})
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    // ITEM-31 — `on_axis` takes the axis's ordered KEY SEQUENCE digest, which is what an
    // aligned artifact declares about itself; the pane holds only the key artifact's
    // `content_hash`. The catalog carries both, which is the whole reason
    // `AxisSummary.key_sequence_digest` is on the wire: resolving one to the other out of
    // the artifact list would mean fetching the very list the filter exists to narrow.
    //
    // SOLE or nothing. `on_axis` names ONE axis, and an integrated coordinate rests on two —
    // narrowing to one of them would drop the other dataset's every column, which is exactly
    // the truncation the plural anchor exists to stop. Two axes ⇒ no narrowing, and the
    // offering predicate composes over both as it always did.
    const catalog = await data.catalog()
    const digests = [
      ...new Set(
        anchorHashes
          .map(h => catalog.axes.find(a => a.content_hash === h)?.key_sequence_digest)
          .filter((d): d is string => typeof d === 'string' && d !== ''),
      ),
    ]
    const onAxis = anchorHashes.length === 1 && digests.length === 1 ? digests[0] : undefined
    artifacts = await data.artifacts.query(onAxis === undefined ? {} : { onAxis })
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for row_space_columns slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // `aligned_to` is a `$`-ref to the anchored row space's IDENTITIES, resolved through the
  // SAME `anchorIds` every OFFERING source uses — so a section declares WHICH row space and
  // never HOW alignment is decided (ITEM-17).
  //
  // `anchorIds`, not `anchorId` (ITEM-8): the offer is the question that composes over an
  // integrated coordinate's two axes, and `anchorId` refuses a list naming two things.
  const anchor = anchorHashes
  // The chosen COORDINATE, for the per-row `plot_note` (ITEM-19): a picture rests on the column
  // AND the frame, so the row states what a picture of it would be marked with.
  const coordinate = anchorId(args.coordinate, scope ?? {})
  return { status: 'ready', payload: resolveRowSpaceColumns(artifacts, args, anchor, coordinate) }
}

/**
 * Read a `compatible_columns` slice (ITEM-35): the per-entity columns SEVERAL datasets share,
 * with the catalog's verdict on whether each could mean the same thing.
 *
 * One data-plane fact about it, and it is the one that matters: it makes exactly ONE call,
 * `artifacts.query({})`, and NO artifact read whatsoever (INV-11). It is deliberately always
 * `ready` and never `empty`, for the same reason `row_space_columns` is — the several
 * emptinesses a section must tell apart (no datasets chosen / only one chosen / chosen and
 * sharing nothing) all have to reach the view, and a slice STATUS carries only one of them.
 * They travel in the payload's `anchored` / `datasets` / `count`.
 */
async function readCompatibleColumnsSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as CompatibleColumnsArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    artifacts = await data.artifacts.query({})
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for compatible_columns slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // `anchorIds`, not `anchorId`: this source is asked about SEVERAL datasets by construction —
  // an alignment over one is not an alignment — so the plural resolver is the correct one and
  // the singular would answer `undefined` for every real use.
  const datasetIds = anchorIds(args.of, scope ?? {})
  return { status: 'ready', payload: resolveCompatibleColumns(artifacts, args, datasetIds) }
}

/**
 * Read a `container_members` slice (issue #361): the declared member GROUPS of a manifest
 * datatype, offered as `{ value, label }` options for a picker.
 *
 * PURE — zero reads, because every fact on that record is a declaration: the datatype's
 * `input_requirements.members` is read out of the already-populated client-side datatype
 * registry, and the derivation is {@link resolveContainerMembers}. No artifact is opened and
 * no catalog call is made.
 *
 * The registry is populated asynchronously after auth, so a slice resolved before the
 * populate lands sees no datatype at all — that is `empty`, never an error and never a
 * throw. The same is true of a datatype that declares no manifest: absence is the honest
 * answer, not a fault.
 */
async function readContainerMembersSlice(
  key: string,
  decl: DataSourceSpec,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as ContainerMembersArgs
  const datatype = typeof args.datatype === 'string' && args.datatype !== '' ? args.datatype : undefined
  const options = resolveContainerMembers(
    datatype === undefined ? undefined : datatypeRegistry.get(datatype)?.input_requirements,
  )
  if (options.length === 0) return { status: 'empty' }
  return { status: 'ready', payload: options }
}

/**
 * Read an `integration_grid` slice: the whole binding plan for the reworked
 * `integration analysis` slot shape (the `entity:` / `level:` families, the positional `rows`
 * slot, and the KEYED `dataset_content_hashes` map).
 *
 * Exactly ONE `artifacts.query({})` and NO artifact read (INV-11) — the same guarantee, made
 * the same way, as `compatible_columns` above. It matters more here: this plan names every
 * identifier column of every selected dataset, so a body-reading version would open dozens of
 * stores merely because the pane was opened.
 *
 * Always `ready`, never `empty`, for the reason the two sources beside it are: the several
 * emptinesses the form must tell apart (nothing chosen / one chosen / chosen but a source has
 * no row index) all have to reach the view, and a slice STATUS carries only one of them. They
 * travel in `anchored` / `datasets` / `blocked` / `ready`.
 */
async function readIntegrationGridSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as IntegrationGridArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    artifacts = await data.artifacts.query({})
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for integration_grid slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  const datasetIds = anchorIds(args.of, scope ?? {})
  // The user's DECLARED level columns. `anchorIds` is the same list resolver the dataset ids
  // use — these are plain strings rather than artifact ids, but the shape (a `$`-ref to a
  // list of strings) is identical and re-implementing it here is how one syntax comes to mean
  // two things.
  const levels = anchorIds(args.levels, scope ?? {})
  return { status: 'ready', payload: resolveIntegrationGrid(artifacts, args, datasetIds, levels) }
}

// ── the AXIS-ENTRY seam's IO half (ITEM-24 … ITEM-27) ────────────────────────────────────
//
// The resolvers in `axisEntries.ts` are pure; everything below is the wire to the real read
// surface. Two facts about the shape are load-bearing:
//
//   · the ENTRY KEYS of an axis are read ONCE per (axis artifact) and memoized, because both
//     sources need them — `axis_entries` to offer them and `axis_entry_values` to turn a
//     chosen key into the column POSITION a matrix is indexed by. Reading them twice would
//     double the one read this seam is allowed to make.
//   · the memo is keyed on the axis ARTIFACT id, which is content-addressed and immutable, so
//     it needs no epoch and can never go stale. It is bounded by the number of axes a session
//     browses.

/** The entry keys of an axis, read once. `id → keys`. */
const entryKeyCache = new Map<string, Promise<readonly string[]>>()

/** Test-only reset of the entry-key memo. */
export function __resetEntryKeysForTests(): void {
  entryKeyCache.clear()
}

/** Read (and memoize) an axis's entry keys through the TYPED string surface. `expect:'string'`
 *  is the declaration this read makes about the producer's own declaration, so a key column
 *  that is not a string column fails at the boundary NAMING both kinds rather than decoding
 *  bytes as something it was not told to expect. `.readAll()` is spelled out because it is a
 *  decision: the accessor is lazy by default, and this is the one place the whole column is
 *  genuinely wanted — bounded by `ENTRY_BROWSE_MAX` before we get here. */
function entryKeysOf(axis: EntryAxis): Promise<readonly string[]> {
  const cached = entryKeyCache.get(axis.artifact)
  if (cached) return cached
  const pending = (async () => {
    const column = await readColumn({ id: axis.artifact, expect: 'string', structure: axis.structure })
    return await column.readAll()
  })()
  entryKeyCache.set(axis.artifact, pending)
  return pending
}

/**
 * Read an `axis_entries` slice (ITEM-24 / ITEM-25): what can be CHOSEN on a sibling axis of
 * the anchored row space.
 *
 * Always `ready`, never `empty` and never skipped, for the same reason `row_space_columns` is:
 * the several emptinesses (no anchor / no such axis / an ambiguous label / too large to
 * browse) all have to reach the view, and a slice STATUS carries only one of them. They travel
 * in the payload's `anchored` / `browsable` / `refusal`.
 */
async function readAxisEntriesSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as AxisEntriesArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  let axes: Awaited<ReturnType<typeof data.catalog>>['axes']
  try {
    // BOTH reads are control-plane: the catalog carries the axis SUMMARIES (whose declared
    // `length` decides the read strategy before a byte is opened — ITEM-25) and the artifact
    // list carries the provenance the axis join needs.
    const [rows, catalog] = await Promise.all([data.artifacts.query({}), data.catalog()])
    artifacts = rows
    axes = catalog.axes
  } catch (e) {
    console.error(`[declarative] viewData: catalog read failed for axis_entries slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // PLURAL (ITEM-19). `anchorId` refuses a `$`-ref naming two axes, so an INTEGRATED coordinate
  // used to answer `no_anchor` here — an honest emptiness at the time, and now simply the wrong
  // question: the sibling exists once PER row space, and the list is their correspondence.
  const anchors = anchorIds(args.axis_of, scope ?? {})
  try {
    return { status: 'ready', payload: await resolveAxisEntries(artifacts, axes, args, anchors, entryKeysOf) }
  } catch (e) {
    // The axis RESOLVED and its keys could not be read. That is a fault, not an emptiness:
    // reporting no entries would state that the axis is empty, which is a positive claim
    // about content this client never saw.
    console.error(`[declarative] viewData: entry keys read failed for "${key}"`, e)
    return { status: 'error', error: `Could not read the entries of "${key}": ${errorMessage(e)}` }
  }
}

/**
 * Read an `axis_entry_values` slice (ITEM-26): what a CHOSEN entry IS.
 *
 * Two arms from ONE declaration, the pairing `axis_columns`' `as: sources` established:
 *   · `as: sources` → provenance, `{ entry → [{artifact, selector, datatype, title, name}] }`.
 *     PURE — zero reads, because every fact on that record is a declaration.
 *   · default → the columnar frame, which is the only arm that opens bytes, and only for the
 *     entries a user has already chosen.
 *
 * NOTHING is read before a choice: an empty `entries` binding yields the empty answer on both
 * arms (INV-4 — an unresolved `$`-ref is absence, not "everything").
 */
async function readAxisEntryValuesSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as AxisEntryValuesArgs
  const asSources = (decl.args as { as?: string } | undefined)?.as === AXIS_ENTRY_VALUES_AS_SOURCES
  const chosen = anchorIds(args.entries, scope ?? {})
  // TWO readings of one `$`-ref, and the difference is which question is being asked (ITEM-8):
  //
  //   · `anchorHash` — the SOLE axis, kept for the ROW COUNT below, which is a question about
  //     one axis instance and is answered `0` for a plural anchor (the densified length there
  //     comes from the gather's own segment counts, not from a single axis's declaration).
  //   · `anchorHashes` — EVERY axis: the offering predicate composes over them, AND — since
  //     ITEM-19 — so does the SIBLING resolution. Resolving entries ACROSS two axes is the
  //     correspondence (INV-6): one sibling per row space, joined by index PAIRS.
  const anchorHash = anchorId(args.axis_of, scope ?? {})
  const anchorHashes = anchorIds(args.axis_of, scope ?? {})
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  let axes: Awaited<ReturnType<typeof data.catalog>>['axes']
  try {
    const [rows, catalog] = await Promise.all([data.artifacts.query({}), data.catalog()])
    artifacts = rows
    axes = catalog.axes
  } catch (e) {
    console.error(`[declarative] viewData: catalog read failed for axis_entry_values slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  const resolved = resolveEntryAxes(artifacts, axes, anchorHashes, args.axis)
  // The axis did not resolve — both arms answer EMPTY rather than erroring: `axis_entries`
  // is the slice that states WHICH absence it is, and two slices reporting the same absence
  // in two vocabularies is how a section comes to say it twice.
  if (!resolved.ok) return { status: 'ready', payload: {} }
  const rowSpace = resolveRowSpaceAnchor(artifacts, anchorHashes, anchorCoordinate(scope ?? {}))
  let sources
  try {
    sources = resolveEntrySources(artifacts, resolved.axes, rowSpace, chosen, args)
  } catch (e) {
    // A `name` template collision is a DECLARATION defect and is reported as one — loudly,
    // naming both sources, never resolved by letting one overwrite the other.
    console.error(`[declarative] viewData: axis_entry_values slice "${key}"`, e)
    return { status: 'error', error: errorMessage(e) }
  }
  if (asSources) return { status: 'ready', payload: sources }
  if (chosen.length === 0) return { status: 'ready', payload: {} }
  // ONE POSITION MAP PER SIBLING AXIS (ITEM-19). A single map keyed on the entry alone would
  // answer one axis's index for both sides of a correspondence — the index-identity read that
  // returns a full-length, well-typed column that is wrong for every row of the second side.
  const positionsByAxis = new Map<string, Map<string, number>>()
  await Promise.all(
    resolved.axes.map(async axis => {
      const keys = await entryKeysOf(axis).catch(() => [] as readonly string[])
      positionsByAxis.set(axis.contentHash, new Map(keys.map((k, i) => [k, i])))
    }),
  )
  const soleAxisPositions = resolved.axes
    .map(axis => positionsByAxis.get(axis.contentHash))
    .reduce(first => first)
  const rowCount = axes.find(a => a.content_hash === anchorHash)?.length ?? 0
  const byId = new Map(artifacts.map(a => [a.id, a]))
  const frame = await readEntryValuesFrame(
    sources,
    // No axis named ⇒ the SCALAR case, where there is exactly one sibling and its map is the
    // only one. Named ⇒ that side's own map, which is the correspondence.
    (entry, entryAxis) =>
      (entryAxis === undefined ? soleAxisPositions : positionsByAxis.get(entryAxis))?.get(entry),
    (source, at) => readEntryColumn(data, source, byId, at, rowCount, rowSpace),
  )
  return { status: 'ready', payload: frame }
}

/**
 * One (entry, source) pair's values, dispatched on the PRODUCER's declared encoding — never
 * on the datatype id and never on the bytes (INV-6).
 *
 * A `sparse_csc` matrix is addressed by the entry's POSITION on its axis (which is what the
 * `indptr` window is indexed by) and densified against the anchored row space's own declared
 * length: a sparse column's absent rows are zeros, and a consumer plotting per-row values
 * needs one value per row, not a scatter of the non-zeros.
 *
 * Anything else is read as a NAMED numeric member — the shape a producer that materialised one
 * column per entry writes. The two are the encodings that exist; a third fails at the typed
 * boundary naming what it found, which is the honest outcome for an encoding nobody taught
 * this seam to read.
 */
async function readEntryColumn(
  data: DataApi,
  source: EntrySource,
  byId: ReadonlyMap<string, ArtifactRow>,
  positions: readonly number[],
  rowCount: number,
  anchor: RowSpaceAnchor | undefined,
): Promise<readonly number[]> {
  const pairs = source.pairs
  // ── THE SCALAR CASE — ONE SIDE, ONE POSITION, AND THE READ IT ALWAYS WAS ──────────────────
  if (!pairs || pairs.length <= 1) {
    const position = positions.reduce(first => first)
    return await readOneEntryColumn(source, byId.get(source.artifact)?.structure, position, rowCount)
  }
  // ── THE CORRESPONDENCE (ITEM-16/ITEM-19, INV-6) ───────────────────────────────────────────
  //
  // Each side is read at its OWN column index, on its OWN row-space axis, and the sides are laid
  // end to end in the ANCHOR's declared membership order. It goes through
  // `DataApi.readColumnarFrame` rather than through `readSparseColumn` directly because CORE
  // CANNOT IMPORT THE DATA EXTENSION (`lint-layer-boundary` R2) — the capability contract is the
  // only way across, which is why the segment had to grow a column selector for this to be
  // expressible at all.
  //
  // A side whose position could not be resolved never reaches here: `readEntryValuesFrame` skips
  // the whole source rather than reading the rest short.
  const indexByRowSpace = new Map<string, { column: string; columnIndex: number; structure: unknown }>()
  pairs.forEach((pair, at) => {
    const row = byId.get(pair.artifact)
    if (!row) return
    indexByRowSpace.set(pair.rowSpace, {
      column: pair.artifact,
      columnIndex: positions[at],
      structure: row.structure,
    })
  })
  const gather = correspondenceGather(anchor, rowSpaceAxis => indexByRowSpace.get(rowSpaceAxis))
  if (!gather) {
    // REFUSED, not approximated. A correspondence the anchor's own declarations cannot support
    // (a side that is not `full` on its axis, a coordinate declaring no index body, a row space
    // with no side) has no partial answer: every partial one is a column laid against positions
    // belonging to rows it never described.
    throw new Error(
      `axis_entry_values: "${source.selector}" spans ${pairs.length} row spaces and the anchored ` +
        'coordinate does not declare a gatherable membership on each of them, so the ' +
        'correspondence cannot be read. Nothing is plotted rather than part of it.',
    )
  }
  const frame = await data.readColumnarFrame({
    artifactId: source.artifact,
    structure: byId.get(source.artifact)?.structure,
    members: {
      segments: gather.segments.map(segment => ({
        column: segment.column,
        ...(segment.columnIndex === undefined ? {} : { columnIndex: segment.columnIndex }),
        alignedTo: segment.alignedTo,
        artifact: segment.artifact,
        member: segment.member,
        count: segment.count,
      })),
    },
  })
  // ONE column by construction (a gather emits one row sequence), so it is taken as the sole
  // value rather than looked up by a name this seam would have to agree on with the extension.
  const columns = Object.values(frame)
  if (columns.length !== 1) {
    throw new Error(
      `axis_entry_values: the correspondence read for "${source.selector}" answered ` +
        `${columns.length} columns; a gather emits exactly one row sequence`,
    )
  }
  return Array.from(columns.reduce(first => first) as ArrayLike<number>)
}

async function readOneEntryColumn(
  source: EntrySource,
  structure: unknown,
  position: number,
  rowCount: number,
): Promise<readonly number[]> {
  const parsed = parseStructure(source.artifact, structure)
  if ((parsed as { encoding?: string; kind?: string }).encoding === 'zarr_v3' &&
      (parsed as { kind?: string }).kind === 'sparse_csc') {
    const column = await readSparseColumn(source.artifact, position, parsed)
    const dense = new Array<number>(rowCount).fill(0)
    for (let i = 0; i < column.row.length; i++) {
      const row = column.row[i]
      if (row < dense.length) dense[row] = column.value[i]
    }
    return dense
  }
  const numeric = await readColumn({
    id: source.artifact,
    expect: 'numeric',
    member: source.selector,
    structure,
  })
  return Array.from(numeric as ArrayLike<number>)
}

/**
 * Read an `axis_entry_rows` slice (ITEM-47 … ITEM-58): what each entry of a sibling axis
 * READS as — its displayed name, its declared group, the qualifier a contested name carries,
 * and the corpus a search matches against.
 *
 * It composes the two halves that already exist rather than re-deriving either: the axis join
 * and the bounded entry-key read are {@link resolveAxisEntries}' (so the ENTRY-BROWSE bound is
 * enforced in exactly one place and this slice cannot opt out of it), and the description is
 * `axisEntryRows`' pure resolver. What lives HERE is the IO the pure half is injected with:
 * the annotation column reads, dispatched on each producer's DECLARED member encoding.
 */
async function readAxisEntryRowsSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as AxisEntryRowsArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  let axes: Awaited<ReturnType<typeof data.catalog>>['axes']
  try {
    const [rows, catalog] = await Promise.all([data.artifacts.query({}), data.catalog()])
    artifacts = rows
    axes = catalog.axes
  } catch (e) {
    console.error(`[declarative] viewData: catalog read failed for axis_entry_rows slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // The same two readings as the `axis_entry_values` slice above, for the same reason (ITEM-8).
  const anchorHash = anchorId(args.axis_of, scope ?? {})
  const anchorHashes = anchorIds(args.axis_of, scope ?? {})
  // `show` is a `$`-REF into the section's own state (ITEM-60), so it is RESOLVED here rather
  // than read verbatim. Reading it verbatim yields the literal `"$state.show"`, which matches
  // no annotation and falls back to the key — a header select that changes nothing, which is
  // exactly the inert control this round exists to remove. Found by the e2e; no unit test on
  // the pure resolver could see it, because the pure resolver is handed the RESOLVED value.
  const resolvedArgs: AxisEntryRowsArgs = {
    ...args,
    show: typeof args.show === 'string' ? (anchorId(args.show, scope ?? {}) ?? '') : '',
    // The FRAME half, resolved for the same reason `show` is (ITEM-39): the pure resolver is
    // handed the RESOLVED value, so reading `"$scope.coordinate"` verbatim would match no
    // artifact and report unframed forever — an always-refused ▶ rather than a wrongly-emitting
    // one. Both are wrong; only one is loud.
    coordinate: typeof args.coordinate === 'string' ? (anchorId(args.coordinate, scope ?? {}) ?? '') : '',
  }
  const resolved = resolveEntryAxes(artifacts, axes, anchorHashes, args.axis)
  let entries
  try {
    entries = await resolveAxisEntries(artifacts, axes, args, anchorHashes, entryKeysOf)
  } catch (e) {
    console.error(`[declarative] viewData: entry keys read failed for "${key}"`, e)
    return { status: 'error', error: `Could not read the entries of "${key}": ${errorMessage(e)}` }
  }
  // ── A STATED NARROWING, NOT A SILENT `[0]` (ITEM-19) ───────────────────────────────────────
  //
  // The ENTRY LIST above is plural and is the CORRESPONDENCE's domain (the entries present on
  // every side). The DESCRIPTION below — which annotation columns exist, what each entry reads
  // as, which one groups — is resolved against the sibling of the FIRST row space the anchor
  // named. An annotation is an ordinary column on ONE entry axis, so a plural description would
  // have to answer what two datasets' differing annotation sets mean for one row, and this
  // round does not decide that. Narrowing to the primary side keeps the rows the correspondence
  // resolved and describes them from one dataset's declarations — which is visibly one
  // dataset's, rather than a merge nobody chose.
  const axis = resolved.ok ? resolved.axes.reduce(first => first) : undefined
  const anchor = resolveRowSpaceAnchor(artifacts, anchorHashes, anchorCoordinate(scope ?? {}))
  // The KEY's own display title, from the datatypes the PROJECT holds — see
  // {@link resolveKeyLabel} for why it cannot be read off the key artifact itself and why
  // disagreement falls back rather than picking.
  const keyLabel = axis ? resolveKeyLabel(artifacts, axis.label, id => datatypeRegistry.get(id)?.axes) : undefined
  const payload = await resolveAxisEntryRows(
    artifacts,
    axis,
    anchor,
    resolvedArgs,
    entries,
    { key_label: keyLabel },
    readAnnotationColumn,
  )
  return { status: 'ready', payload }
}

/**
 * One annotation column's values as TEXT, dispatched on the PRODUCER's declared member
 * encoding — never on the datatype id and never on the bytes (INV-6), the same rule
 * {@link readOneEntryColumn} follows one slice over.
 *
 * A `categorical` member is dictionary-encoded, so it arrives as codes + a DECLARED level
 * set and is expanded here; a `string` member is inline utf8 and is read whole. Both are
 * bounded by the same `ENTRY_BROWSE_MAX` the keys are — this slice only reaches here on the
 * browse arm.
 */
async function readAnnotationColumn(row: { id: string; structure: unknown }): Promise<readonly string[]> {
  const declared = tableColumns(row.structure).find(
    c => typeof c.kind === 'string' && (c.kind === 'string' || c.kind === 'categorical'),
  )
  if (declared?.kind === 'categorical') {
    const column = await readCategoricalColumn(row.id, parseStructure(row.id, row.structure))
    return Array.from(column.codes, code => column.categories[code] ?? '')
  }
  const column = await readColumn({ id: row.id, expect: 'string', structure: row.structure })
  return await column.readAll()
}

/**
 * Read an `axis_columns` slice (ITEM-11): every metadata column present on the declared
 * `axis` of the dataset the `of` reference anchors, merged into one columnar frame.
 *
 * `of` resolves against the view's own state, so before the anchoring control has a value
 * this returns `undefined` — SKIPPED, not `empty`. Nothing was attempted, and reporting
 * `empty` would both clear whatever the previous anchor had landed and show "Run the
 * analysis that produces its input" for a form whose actual next step is "pick a dataset".
 */
async function readAxisColumnsSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
  spec: ViewSpec | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as {
    of?: string
    axis?: string
    datatype?: string
    excludes?: string[]
    as?: string
    produced_by?: string
    /** ITEM-34 — a `$`-ref to the criteria list whose named columns' BODIES are wanted. */
    values_for?: string
  }
  // EVERY anchor `of` names, not just the first. A slice may legitimately be anchored on a
  // LIST — "which column names are already taken on the axes this run writes to" is asked of
  // every selected input, and a name free on the first and taken on the second is taken.
  const ofIds = anchorIds(args.of, scope ?? {})
  const ofId = ofIds[0]
  if (!ofId || !args.axis) return undefined
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  // The LIST read, not the project overview. `axisColumnRows` (via `siblingsOnAxis`)
  // scopes by the anchor's SOURCE DATASET, and that field is provenance-derived — the
  // overview's row type cannot carry it, so resolving off `catalog()` returned ZERO
  // columns for every slice in every project. See `ArtifactCatalogSource.artifacts`.
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    artifacts = await data.artifacts.query({})
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for axis_columns slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}" (axis ${args.axis}): ${errorMessage(e)}` }
  }
  // `produced_by: others` — answer about the columns THIS VIEW'S OWN analyses did not
  // make. Resolved from the spec's `run_processor` ops, so the slice carries no analysis
  // id of its own; any other value (including none) excludes nothing, which keeps every
  // existing slice byte-identical.
  const excludeGenerators =
    args.produced_by === AXIS_COLUMNS_PRODUCED_BY_OTHERS ? viewOwnAnalysisIds(spec) : undefined
  const filter = {
    filter: { datatype: args.datatype, excludes: args.excludes },
    excludeGenerators,
  }
  // `as: sources` — the SAME axis relation, asked for the artifact ID behind each column
  // rather than its values (so a view can bind a `column:<name>` slot). Answered from the
  // catalog rows' own declarations: no artifact is read, and the row selection is shared
  // with the frame arm, so the two cannot describe different column sets.
  if (args.as === AXIS_COLUMNS_AS_SOURCES) {
    // UNION across every anchored axis instance, minted ONCE over the COMBINED selection.
    // This used to `Object.assign` one map per anchor, which is last-write-wins by anchor
    // order — the same silent substitution the within-axis rule removes, one level out: a
    // column name carried by two of the anchored instances resolved to whichever anchor the
    // user happened to list last. `axisColumnSourcesFor` de-duplicates by artifact (two
    // anchors in ONE dataset see almost the same siblings) and qualifies a contested name
    // instead of choosing for the user.
    const sources = axisColumnSourcesFor(
      ofIds.flatMap(id => axisColumnRows(artifacts, id, args.axis, filter)),
    )
    if (Object.keys(sources).length === 0) return { status: 'empty' }
    return { status: 'ready', payload: sources }
  }
  // The FRAME arm refuses a multi-anchor slice, and refuses it LOUDLY rather than answering
  // about the first one. Two axis instances hold two different populations, so merging their
  // columns into one frame would put one instance's VALUES under a name the other also has —
  // a wrong answer that reads as a working one, which is the whole failure class this
  // subsystem exists to remove. (No shipped frame slice is anchored on a list.)
  if (ofIds.length > 1) {
    console.error(
      `[declarative] viewData: axis_columns slice "${key}" is anchored on ${ofIds.length} inputs. ` +
        'A value FRAME describes one axis instance; use `as: sources` to ask about several.',
    )
    return {
      status: 'error',
      error: `"${key}" is anchored on several inputs, and a value frame describes one at a time.`,
    }
  }
  // How many sources the frame OPENED, and how many of those refused.
  //
  // `readAxisColumnsFrame` deliberately TOLERATES a per-artifact read failure — one
  // unreadable column must not blank a form the other columns can still populate — and that
  // tolerance had no end: when it consumed every candidate, the frame came back with no
  // columns, which is the same shape as an axis that carries none. Counting HERE, at the
  // seam that injects the read, is what tells the two apart; it is the only place that sees
  // both the attempt and its outcome, and it needs no change to the frame reader's contract
  // (which is shared with the ids arm and must keep describing the same column set).
  let opened = 0
  let refused = 0
  // ITEM-34 — resolved through the SAME helper the re-resolve digest uses, so "which bodies do
  // we fetch" and "when do we refetch" can never answer differently. `undefined` (no
  // `values_for` declared) means EAGER, i.e. exactly the behaviour every existing slice has.
  const wanted =
    typeof args.values_for === 'string' && args.values_for !== ''
      ? new Set(criterionColumnNames(args.values_for, scope ?? {}))
      : undefined
  const frame = await readAxisColumnsFrame(
    artifacts,
    ofId,
    args.axis,
    async row => {
      opened += 1
      try {
        // Still the ROW-MAJOR reader, deliberately (DRIFT-1.4 / DRIFT-1.22). ITEM-34 makes this
        // read LAZY; it does not make it typed. `columnarFromTable` re-boxes on transposition,
        // and that is what keeps this frame — which lands in `$data` and reaches `primitives.ts`'s
        // unconverted `Array.isArray` guards — on the boxed representation the ITEM-26 type split
        // requires. Converting it to `readColumnarTableChecked` here would type six guards'
        // operand without converting them: silently wrong numbers, not a visible break.
        return columnarFromTable(await readColumn({ id: row.id, expect: 'table', structure: row.structure }))
      } catch (e) {
        refused += 1
        // RE-THROWN, not swallowed: the frame reader logs it and goes on reading the other
        // sources, which is the tolerance this count exists to measure rather than remove.
        throw e
      }
    },
    // No lattice threaded here: this resolver runs outside React and the workbench lattice
    // is context-held. A slice declaring `excludes`/`capabilities` therefore fails closed
    // (resolves to nothing) rather than silently ignoring the constraint — the honest
    // failure. Neither shipped `axis_columns` slice declares one; a future one that needs
    // them threads the lattice through `resolveAndApplyViewData`.
    filter,
    // ITEM-32/34 — the DECLARED level set of each categorical member, read as METADATA only.
    // One `zarr.json` per categorical member, no chunks: the picker lists a column's categories
    // without downloading the column, which is the affordance `colour-by.yaml` refused to serve
    // any other way. Member arrays are cached at the read layer, so a column later read for its
    // VALUES joins this open rather than repeating it.
    async (row, memberPath) => readDeclaredLevels(row.id, memberPath),
    // ── ITEM-34: metadata for ALL columns, values only for the ones a criterion NAMES ────────
    //
    // The whole read-reduction. `axisSource.ts` names the cost this removes: "the 65 the
    // reference dataset imported" — every one of them fetched to populate a picker that needs
    // only their names, kinds and levels. Now the picker is served from the catalog rows plus
    // one `zarr.json` per categorical, and a BODY is fetched only when a criterion refers to it.
    //
    // Omitting `values_for` keeps a slice eager, so this changes nothing for any declaration
    // that does not ask for it (`qc.yaml`'s axis_columns slice does not).
    //
    // The transition window — a criterion naming a column whose body has not landed — is NOT
    // papered over here. `keep_mask` sees the column declared but absent and returns an
    // all-FALSE mask (owner's loading gate, DRIFT-1.11), and `pendingCriterionColumns` names
    // which criterion is waiting. Conservative and visible beats permissive and invisible.
    wanted === undefined ? undefined : (name: string) => wanted.has(name),
  )
  // ── ITEM-34: "no VALUES" is not "no COLUMNS" ─────────────────────────────────────────────
  //
  // Under lazy bodies the frame legitimately holds ZERO value keys — that is the NORMAL state
  // before the user names a column in a criterion. Testing emptiness on the value keys alone
  // would report `empty` about a fully-described axis, and `empty` is a POSITIVE claim the view
  // acts on: the criteria builder would blank and offer to go and produce columns that already
  // exist. The frame is empty only when it can say nothing at all — no values AND no
  // declarations. (Caught on the first run of this change by one of the 8 run-input tests that
  // inject at the workstore boundary: exactly the assertion DRIFT-1.4 said must not be weakened.)
  const describes = Object.keys(frame).length > 0 || Object.keys(declarationsOf(frame)).length > 0
  // ── ITEM-34: under a LAZY read every refusal is material ─────────────────────────────────
  //
  // The eager reader opens every source, so one refusal among many is tolerable — the frame
  // still carries the columns that read, and only a frame with NOTHING in it is worth calling
  // unreadable. A lazy reader opens ONLY what a criterion asked for, so a refusal is always a
  // refusal of something the user is waiting on.
  //
  // Without this, a body that FAILS to read is indistinguishable from one that has not ARRIVED:
  // the frame still describes every column, so the slice reports `ready`, `keep_mask` returns
  // all-FALSE for the declared-but-absent column, and the loading alert sits there forever. A
  // gate that never opens is a worse failure than the eager read's, because nothing ever says so.
  if (wanted !== undefined && refused > 0) {
    return {
      status: 'unreadable',
      error: `Could not read ${refused} of the ${opened} source(s) behind "${key}" on axis "${args.axis}".`,
    }
  }
  if (!describes) {
    // Nothing landed, and at least one source was found and REFUSED. The axis does carry
    // columns; this client could not read them. Reporting `empty` here — which is what this
    // did — states that the dataset carries no measurements at all, and a view is entitled
    // to act on `empty` by offering to go and produce what has already been produced. See
    // `DataStatus` for why this is not `error` either.
    //
    // ONE refusal is enough, not all of them. `empty` is a POSITIVE claim about what the
    // host holds, and a source that refused is a source whose contents are unknown — so a
    // single refusal is already enough to make the claim unsupported. (The stricter
    // `refused === opened` was written first and survived mutation: its extra window is a
    // reachable mixed outcome — one source refusing while another reads cleanly and declares
    // nothing — in which it answered `empty` about an axis it had not finished reading.)
    if (refused > 0) {
      return {
        status: 'unreadable',
        error: `Could not read ${refused} of the ${opened} source(s) behind "${key}" on axis "${args.axis}".`,
      }
    }
    // Every source answered and there is genuinely nothing there: a no-data outcome, not a
    // fault — the same distinction the job.result arm draws (F3).
    return { status: 'empty' }
  }
  // Something landed. A refusal alongside it is a PARTIAL failure, and the tolerance is the
  // whole point: the columns that read are still offered, and the log carries the rest.
  return { status: 'ready', payload: frame }
}

/**
 * Read a `pane_frame` slice (visualize-pane ITEM-35/ITEM-43): what the pane's two identities
 * are CALLED.
 *
 * Like `row_space_columns` it issues no `readColumn` at all (INV-11) and is deliberately always
 * `ready`: the pre-anchor state is a fact the view has to be able to read and act on, not a
 * slice status. It costs one `catalog()` (for the axes' provenance join) and one
 * `artifacts.query({})`, both of which the pane has already paid for elsewhere in the same
 * epoch.
 */
async function readPaneFrameSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as PaneFrameArgs
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  let axes: Awaited<ReturnType<typeof data.catalog>>['axes']
  try {
    const [catalog, rows] = await Promise.all([data.catalog(), data.artifacts.query({})])
    axes = catalog.axes
    artifacts = rows
  } catch (e) {
    console.error(`[declarative] viewData: catalog read failed for pane_frame slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // Both identities are `$`-refs into pane scope, resolved through the SAME helper every other
  // anchored source uses, so a view names WHICH values and never how they are found.
  // The frame reports the anchor VERBATIM, so it reads the whole list (ITEM-8) — a frame that
  // named one of an integrated coordinate's two axes would be reporting a narrower anchor than
  // the one the sections are actually offering against.
  const axis = anchorIds(args.axis, scope ?? {})
  const coordinate = anchorId(args.coordinate, scope ?? {})
  return { status: 'ready', payload: resolvePaneFrame(axes, artifacts, axis, coordinate) }
}

/**
 * Read a `column_values` slice (visualize-pane ITEM-31): the bodies of exactly the columns a
 * user-built list names, one frame per entry.
 *
 * The ONE slice in the pane that reads column bodies, and it reads exactly as many as the user
 * asked for pictures of. An EMPTY list resolves to an empty payload rather than being skipped:
 * a skipped slice leaves the previous payload standing, and the previous payload is the rows
 * the user just closed.
 */
async function readColumnValuesSlice(
  api: WorkbenchAPI,
  key: string,
  decl: DataSourceSpec,
  scope: Scope | undefined,
  land?: SliceLandingCtx,
): Promise<SliceResolution | undefined> {
  const args = (decl.args ?? {}) as { of?: string }
  const requests = toColumnRequests(
    typeof args.of === 'string' ? evalExpr(args.of, scope ?? {}) : undefined,
  )
  if (requests.length === 0) return { status: 'ready', payload: {} }
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  let artifacts: Awaited<ReturnType<typeof data.artifacts.query>>
  try {
    artifacts = await data.artifacts.query({})
  } catch (e) {
    console.error(`[declarative] viewData: artifacts.query failed for column_values slice "${key}"`, e)
    return { status: 'error', error: `Could not load "${key}": ${errorMessage(e)}` }
  }
  // ITEM-20 — WHICH ROWS this plot is about, so an offered column is painted at the
  // coordinate's rows rather than at the parent axis's. `undefined` for every column that needs
  // no gather (all of them, on a project that has declared no subset), and the read below is
  // then byte-for-byte the read it was.
  const gatherAnchor = resolveRowSpaceAnchor(
    artifacts,
    anchorIds('$scope.axis', scope ?? {}),
    anchorCoordinate(scope ?? {}),
  )
  const payload = await readColumnValues(
    artifacts,
    requests,
    // ITEM-24 — native columnar read; see the sibling call above.
    // ITEM-42 — ONE byte route. This read goes through the `data` capability, which serves it
    // from the SAME `WorkbenchStreamingSource` the canvas streams from: the canvas iterates the
    // stream progressively while this consumer collects it whole, and the second of the two
    // JOINS the first's read instead of starting one. Reading the artifact through core's own
    // workstore call — what this line used to do — cost a measured SECOND decode of the same
    // bytes (DRIFT-1.48). The typed representation (ITEM-21) is preserved by the capability;
    // `readTable`/`columnarFromTable`'s boxed paths are not on this route and are untouched.
    // ITEM-20 — carry the correspondence gather members so an offered column is painted at the
    // coordinate's rows rather than the parent axis's.
    // incremental-landing ITEM-7: when a landing context is present, forward `onChunk` so the
    // emit-plot colour column arrives PROGRESSIVELY in the declarative arc — the same stream, now
    // landed in stages instead of collected whole. `onChunk` is undefined otherwise (reads whole).
    async (row, onChunk) =>
      data.readColumnarFrame(
        {
          artifactId: row.id,
          structure: row.structure,
          members: gatherFor(row.id, row.structure, gatherAnchor),
        },
        onChunk,
      ),
    // The ENTRY arm (ITEM-26/ITEM-59): a request naming a `selector` wants ONE entry's column
    // out of an entry-indexed artifact, addressed by the POSITION the plot captured at emit
    // time. Same dispatch-on-declaration as the values slice — one reader, one rule.
    (row, request) =>
      readOneEntryColumn(
        { artifact: row.id, selector: request.selector ?? '', datatype: row.datatype, title: '', name: '' },
        row.structure,
        request.position ?? 0,
        request.rows ?? 0,
      ),
    // incremental-landing ITEM-7: the progressive emitter — each partial slice payload is landed as
    // a `partial` chunk keyed under THIS slice, so `$data.<key>` fills as the stream arrives. Only
    // wired when a landing context is present; the resolver still lands the wholesale payload below.
    land ? partial => land.land({ [key]: partial }, false) : undefined,
  )
  return { status: 'ready', payload }
}

/**
 * THE STATE HALF OF THE RE-RESOLVE TRIGGER.
 *
 * A slice may bind its args to the view's OWN state — `column_values { of: "$state.plots" }`
 * is the emit model's values read, and `axis_entry_rows { show: "$state.show" }` is the entry
 * section's header. The catalog epoch does not move when that state changes, and neither does
 * `axisSourceRequestKey` (which digests `axis_columns` slices only), so without this a
 * state-bound slice resolves ONCE PER MOUNT and never again: the first press of a ▶ appends a
 * plot the values read never hears about, and a header select changes the display to nothing.
 *
 * Both were LIVE. Neither is visible from a unit test of a resolver (the resolver is handed
 * the resolved args) nor from an e2e that asserts a pane EXISTS (it does; it is simply empty),
 * which is why this is stated as a digest with its own test rather than as a comment.
 *
 * It digests the RESOLVED values of the `$`-refs a slice's args actually name — so it is stable
 * across every state write no slice reads (a slider drag bumps `revision` many times a second
 * and must not become a refetch storm), and it moves exactly when an answer could differ.
 */
export function dataArgsRequestKey(spec: ViewSpec, state: Record<string, unknown> | undefined): string {
  const slices = Object.entries(spec.data ?? {})
  if (slices.length === 0) return ''
  const scope: Scope = { state: state ?? {} }
  const parts: string[] = []
  for (const [key, decl] of slices) {
    const args = (decl?.args ?? {}) as Record<string, unknown>
    for (const [name, value] of Object.entries(args)) {
      // Only `$state.` refs. `$scope.` is already in the key (the pane's own half) and a
      // literal cannot change without the spec changing.
      if (typeof value !== 'string' || !value.trim().startsWith('$state.')) continue
      parts.push(`${key}.${name}=${digest(evalExpr(value, scope))}`)
    }
  }
  return parts.length === 0 ? '' : `|state:${parts.join(',')}`
}

/** A short stable digest of a resolved arg. Serialized when small, hashed when not: a request
 *  key is compared, never read, and an unbounded one would carry a whole emitted-plot list into
 *  every comparison. Truncation is deliberately NOT used — two different states truncating to
 *  one string would de-dupe a resolve that should have superseded. */
function digest(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? 'undefined'
  } catch {
    return 'unserializable'
  }
  if (text.length <= 120) return text
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `#${text.length}:${(h >>> 0).toString(36)}`
}

/**
 * The wall-clock bound on ONE resolve. Without it a hung request leaves the in-flight guard
 * set forever — dropping every later re-resolve — and pins the region on a skeleton with no
 * escape (FIX-2.3). A FIXED constant, not a settings row: it is a client-side liveness guard
 * on a single fetch, not an operational tunable an operator would ever want to raise (raising
 * it only lengthens how long a user stares at a skeleton). Named so it can be promoted later.
 */
export const VIEW_DATA_TIMEOUT_MS = 30_000

/** The IN-FLIGHT resolve for a viewId: its generation + the REQUEST KEY it was started for. */
interface InFlight {
  gen: number
  /** Identifies the REQUEST, not the call. The fanned regions (left/right/bottom share ONE
   *  viewId) all fire the same effect with the same key, so they de-dupe to one fetch; a
   *  genuinely NEW request (the catalog changed, or a retry) carries a different key and
   *  SUPERSEDES instead of being dropped. */
  key: string
}

// Per-viewId de-dupe so the fanned regions trigger exactly ONE resolve per request, not one
// per region — while a genuinely new request still gets through (FIX-2.1).
const inFlight = new Map<string, InFlight>()

// Per-viewId request generation — LAST-REQUEST-WINS. Without it, `retryViewData` cleared the
// in-flight guard and let the stale resolve keep running: whichever landed LAST won, so a slow
// failing resolve could clobber the retry's fresh data (and the stale resolve's `finally`
// would then delete the guard the RETRY had taken, letting a third resolve start). Every
// landing checks its generation is still current before touching the store.
const generation = new Map<string, number>()
const currentGeneration = (viewId: string): number => generation.get(viewId) ?? 0
/** Invalidate any in-flight resolve for `viewId` and return the new generation. */
function nextGeneration(viewId: string): number {
  const g = currentGeneration(viewId) + 1
  generation.set(viewId, g)
  return g
}

// How many resolves are still OUTSTANDING for a view (including superseded ones that have
// not settled yet). The generation counter may only be dropped when this hits ZERO
// (FIX-3.1): dropping it while a superseded resolve is still running resets the counter, so
// the NEXT request re-uses generation 1 — and the stale resolve then passes its own
// `currentGeneration === gen` check, writes its stale data, and deletes the newer request's
// in-flight entry. That breaks last-request-wins in BOTH directions.
const outstanding = new Map<string, number>()

/** Reject after `VIEW_DATA_TIMEOUT_MS` so one hung request cannot wedge the view forever. */
function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`view data timed out after ${VIEW_DATA_TIMEOUT_MS}ms`)),
      VIEW_DATA_TIMEOUT_MS,
    )
  })
  return Promise.race([p, bomb]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Resolve `spec`'s job-result data slices via the real host hook and land them — TOGETHER
 * WITH THEIR STATUS — into the shared store, so EVERY fanned region re-renders with the data
 * AND knows whether the absence of data is a failure or a genuine emptiness.
 *
 * `requestKey` identifies the REQUEST (the caller passes the workbench catalog epoch). The
 * fanned regions of one view share a viewId and fire the same effect, so the same key
 * de-dupes to a single fetch; a DIFFERENT key means the world changed and supersedes the
 * in-flight resolve rather than being silently dropped.
 *
 * TERMINAL-STATUS GUARANTEE (the anti-stuck-skeleton rule): every exit path lands a
 * non-`loading` status on the store — success, per-slice failure, the resolver's own throw,
 * and a timeout. Returns the resolved record (for tests).
 */
export async function resolveAndApplyViewData(
  viewId: string,
  spec: ViewSpec,
  api: WorkbenchAPI,
  requestKey = 'default',
): Promise<Data> {
  const running = inFlight.get(viewId)
  // Same request already in flight (a sibling fanned region) → genuine de-dupe.
  if (running && running.key === requestKey) return undefined
  const gen = nextGeneration(viewId) // supersedes `running`, if any
  inFlight.set(viewId, { gen, key: requestKey })
  outstanding.set(viewId, (outstanding.get(viewId) ?? 0) + 1)
  try {
    // The `$`-scope an `axis_columns` slice resolves its `of` reference against — read
    // LIVE off the store, so a slice anchored on a control picks up the value the user
    // actually chose (the caller's `requestKey` carries the same anchors, which is what
    // makes a changed anchor supersede rather than de-dupe).
    // `$scope` — THE PANE-LEVEL FRAME (ITEM-10). An anchored slice declares
    // `aligned_to: "$scope.axis"`, so leaving this root out of the RESOLVER's scope while the
    // RENDER scope carries it is the shape that ships a section which renders correctly and
    // resolves nothing: the ref evaluates to `undefined`, the source answers A0, and the
    // section states "no row space anchored" beside a control that says one is. Read straight
    // off the store rather than threaded, for the same reason `state` is — the resolver runs
    // outside React and must see the value the user actually chose.
    const scope: Scope = { state: getViewStore(viewId)?.state ?? {}, scope: currentPaneScope() }
    // incremental-landing ITEM-7: open a progressive landing for this resolve. A streaming slice
    // (an emit-plot colour column) lands `partial` chunks through this context as its stream
    // arrives, so `$data` paints in stages; the authoritative WHOLESALE land still happens below
    // (`store.setData`), so the final state equals the wholesale one. The epoch guards against a
    // superseded resolve's straggler landing over a fresh one. A view with no streaming slice never
    // calls `land`, so this is inert for the wholesale path.
    const landEpoch = beginViewDataLanding(viewId)
    const land: SliceLandingCtx = {
      land: (partial, done) => {
        if (currentGeneration(viewId) !== gen) return // superseded — do not paint stale chunks
        landViewDataChunk(viewId, partial, { done, epoch: landEpoch })
      },
    }
    const res = await withTimeout(
      // The spec comes from `resolveViewData`'s own third argument, never from this
      // closure: the reader must resolve a self-referential slice against the SAME spec
      // the resolver is walking.
      resolveViewData(spec, (key, decl, declaredIn) =>
        readSliceFromApi(api, key, decl, scope, declaredIn, land),
      ),
    )
    // A newer request superseded this one while it was in flight — discard, so the LAST
    // REQUEST wins rather than the last completion.
    if (currentGeneration(viewId) !== gen) return undefined
    const store = getViewStore(viewId)
    if (Object.keys(res.data).length === 0) {
      if (res.status === 'empty') {
        // AUTHORITATIVE: the host has nothing of the declared datatype. Clear any previously
        // landed slices — otherwise the region paints stale rows under a "No data yet" state
        // (FIX-2.2). An `error` is NOT authoritative (it is usually transient), so that path
        // keeps the last good data and merely reports the failure.
        store?.setData(undefined, 'empty')
      } else {
        store?.setDataStatus(res.status, res.error, res.hint)
      }
      return undefined
    }
    // On a PARTIAL failure keep whatever a previous resolve had already landed for the
    // slices that failed this round, instead of replacing the whole record with only the
    // survivors (`setData` assigns, it does not merge). `unreadable` is on this side of the
    // line with `error`: both are FAULTS, and only `empty` is authoritative about what the
    // host holds (which is why it, and only it, clears — see the branch above).
    const next = landedData((store?.data ?? {}) as Record<string, unknown>, res.status, res.data)
    store?.setData(next, res.status, res.error, res.hint)
    return next
  } catch (e) {
    if (currentGeneration(viewId) === gen) getViewStore(viewId)?.setDataStatus('error', errorMessage(e))
    return undefined
  } finally {
    // Only release the guard if it is still OURS — a newer request may have taken it over.
    if (inFlight.get(viewId)?.gen === gen) inFlight.delete(viewId)
    const left = (outstanding.get(viewId) ?? 1) - 1
    if (left <= 0) {
      // Nothing is outstanding for this view any more — NOW the generation counter has no
      // possible reader, so it can be dropped without letting a straggler alias a fresh
      // generation (FIX-3.1). This is also what keeps the maps bounded.
      outstanding.delete(viewId)
      generation.delete(viewId)
    } else {
      outstanding.set(viewId, left)
    }
  }
}

/**
 * Re-run the resolver for `viewId` after a failure — what the region's error state's
 * Try-again calls (ITEM-6 / DEC-5). It passes a UNIQUE request key, which is what makes it
 * supersede (rather than de-dupe against) any resolve still in flight; that resolve can no
 * longer write to the store because `resolveAndApplyViewData` bumps the generation. Flips the
 * store to `loading` first so the user sees the retry happen.
 */
let retryNonce = 0
export async function retryViewData(viewId: string, spec: ViewSpec, api: WorkbenchAPI): Promise<Data> {
  getViewStore(viewId)?.setDataStatus('loading')
  retryNonce += 1
  return resolveAndApplyViewData(viewId, spec, api, `retry:${retryNonce}`)
}

// ── Incremental landing (incremental-landing ITEM-2) ─────────────────────────────────────────────
// A per-viewId landing EPOCH, layered UNDER the request generation (DEC-5): the generation guard
// above is last-request-wins across whole resolves; this epoch is what discards a SUPERSEDED
// slice's LATE CHUNK while a live slice's chunks keep accumulating. A new landing bumps the epoch,
// resets the store's accumulator, and any chunk still tagged with an older epoch is dropped by the
// store's `landChunk` guard. This is the twin of the generation guard, at chunk granularity.
const landingEpochs = new Map<string, number>()

/**
 * Begin a fresh INCREMENTAL landing for `viewId` and return its epoch (ITEM-2). Resets the store's
 * chunk accumulator; the returned epoch tags every `landViewDataChunk` of this sequence. A second
 * `beginViewDataLanding` (a superseded/restarted landing) bumps the epoch, so the earlier
 * sequence's stragglers are discarded.
 */
export function beginViewDataLanding(viewId: string): number {
  const epoch = (landingEpochs.get(viewId) ?? 0) + 1
  landingEpochs.set(viewId, epoch)
  getViewStore(viewId)?.beginLanding(epoch)
  return epoch
}

/**
 * Land ONE chunk of an incremental landing (ITEM-2). Forwarded to the store, which APPENDS the
 * chunk's rows to what earlier chunks of this epoch landed, replaces the slice object (so the
 * canvas memo re-reads it — ITEM-5), and DISCARDS the chunk if `epoch` is no longer the live one (a
 * superseded resolve's straggler). `done` lands the terminal `ready` and flushes derived
 * synchronously; otherwise `partial`.
 */
export function landViewDataChunk(
  viewId: string,
  chunk: Data,
  opts: { done: boolean; epoch: number; error?: string; hint?: string },
): void {
  getViewStore(viewId)?.landChunk(chunk, opts)
}

/** Test-only reset of the per-viewId in-flight guard + request generations + landing epochs. */
export function __resetViewDataForTests(): void {
  inFlight.clear()
  generation.clear()
  outstanding.clear()
  landingEpochs.clear()
}
