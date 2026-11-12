// canvasFeed — resolve a declarative view's `canvas` block into a CanvasView feed
// (declarative-processor-ui Slice 3 / ITEM-10). GENERAL: it takes ANY declarative view's
// `canvas` VizOption declaration + the view's resolved `$data` obs slices and produces the
// `{ option, resolver }` the center CanvasView drives onto the single `@txresbench/viz` grid. This
// is the analysis-agnostic analog of `criteriaCanvas.ts::resolveCriteriaCanvas` (which is
// cell-filter-specific): both funnel through `resolveCanvasOption` + `createDatasetResolver`
// (canvasBinding.ts), but this one drives from a DECLARED canvas block + the store's data,
// carrying NO criteria/filter shape (a processor that wants before/after declares it as DATA).
//
// Pure / framework-free (no React) so the resolution is directly unit-testable.

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { DataSource, DatasetResolver, VizDataset, VizOption, VizSeries } from '@txresbench/viz'

/** The `@txresbench/viz` image-underlay payload shape (raster + 2×3 affine) — derived, not re-declared. */
type ImageUnderlay = Awaited<ReturnType<DataSource['imageUnderlay']>>
import {
  createDatasetResolver,
  parseLogicalDatasetId,
  placeSeries,
  resolveCanvasCloseActions,
  resolveCanvasCoords,
  resolveCanvasOption,
  unresolvableBinding,
  type CanvasTemplate,
  type ObsColumns,
  type ResolvedCloseAction,
} from './canvasBinding'
import { isColumn } from '@/modules/workbench/core'
import { evalExpr, type Scope } from '@/modules/workbench/core/runtime/expr'

/** The live inputs a declarative canvas resolves against: the resolved `$data` slices +
 *  optional plottable-XY positions + the reactive scope ($state/$derived/$const/$data) any
 *  `$`-refs in the option resolve against. */
export interface DeclarativeCanvasInputs {
  /** the resolved `$data` record (`{ <base>: {col:[…]}, … }`) — the store's `data`. */
  data: Record<string, unknown>
  /** the REAL plottable-XY positions (interleaved `[x0,y0,…]`, full pre-mask) for the canvas's
   *  DEFAULT dataset base — the scatter x/y (Bug 2). Resolved by the host from the project's
   *  plottable-XY layout artifact. Absent ⇒ the base's source fabricates x/y from its first two
   *  numeric columns (the legacy behavior).
   *
   *  C8: this used to be a MAP the caller keyed — and core keyed it `obs`, unconditionally, so a
   *  canvas whose default dataset was named anything else silently got no coordinates. The
   *  default base is a property of the canvas DECLARATION, so it is resolved here. */
  positions?: { positions: Float32Array; length: number }
  /**
   * The positions of the artifacts a canvas DECLARED with `coords` (ITEM-29), keyed by artifact
   * id — resolved by the host, which is the only layer that can read bytes.
   *
   * This is the half that retires `layouts[0]` for any block that declares its coordinates: a
   * base whose `coords` names an artifact present here is drawn in THOSE positions, whatever
   * the project's first plottable-xy artifact happens to be. A declared artifact that has not
   * resolved yet is simply absent, and the base falls back exactly as an undeclared one does —
   * so a late arrival re-publishes rather than blanking a plot.
   */
  positionsByArtifact?: ReadonlyMap<string, { positions: Float32Array; length: number }>
  /** the reactive scope the option's `$state`/`$derived` refs resolve against. */
  scope: Scope
}

/** True iff `v` is a columnar obs slice (`{ column: array }`) — the resolver's per-base source. */
function asObsColumns(v: unknown): ObsColumns {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as ObsColumns
}

/**
 * The `$data` frame a dataset BASE names — a top-level slice, or a PATH INTO one.
 *
 * A base has always named a slice by its own declared key (`metrics`, `frame`). That is enough while
 * a canvas declares a FIXED set of bases, and it is not enough for a canvas whose bases are a
 * `for_each` over user-built state: a `data:` block's keys are literals an author wrote, so a
 * slice cannot be minted per emitted plot — while an emitted plot genuinely needs its OWN base
 * (its columns may be a different LENGTH from its neighbour's when the two sit on different row
 * spaces, and a shared base is also a shared selection space, so two plots would brush each
 * other).
 *
 * So a base id may be dotted: `plotted.c3` is the `c3` entry of the `plotted` slice. The lookup
 * is a plain path walk with no globbing and no fallback — a base that resolves to nothing yields
 * `{}` exactly as an unknown top-level base always has, and the series bound to it is dropped by
 * the availability filter rather than drawn against someone else's columns.
 *
 * The TOP-LEVEL name is tried first and whole, so a slice whose own key contains a dot keeps
 * working byte-identically.
 */
function frameAt(data: Record<string, unknown>, base: string): unknown {
  if (base in data) return data[base]
  const parts = base.split('.')
  if (parts.length < 2) return undefined
  let cur: unknown = data
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** The `ImageUnderlay`-shaped spatial payload for a base (INV-16, Slice 6). The store's `$data`
 *  carries a spatial image under `<base>.image` (or, for the canvas's DEFAULT base, the top-level
 *  `image` / `spatial.image` shorthand) — an `{ data, width, height, channels?, affine }` object
 *  produced by the spatial ingest. Returns undefined when the base has no image (a metric-only
 *  source). Kept narrow: only an object with a numeric-ish `affine` array is treated as an underlay.
 *
 *  r3canvas: both shorthand tests used to be `base === 'obs'`, i.e. core naming the default slice by
 *  literal, so the shorthand only reached a canvas that happened to call its default slice `obs`.
 *  `defaultBase` is the base the DECLARATION chose. */
function imageForBase(
  data: Record<string, unknown>,
  base: string,
  defaultBase: string,
): Partial<ImageUnderlay> | undefined {
  const isDefault = base === defaultBase
  const direct = isDefault ? data['image'] : (data[base] as Record<string, unknown> | undefined)?.['image']
  const candidate =
    direct ?? (isDefault ? (data['spatial'] as Record<string, unknown> | undefined)?.['image'] : undefined)
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'affine' in candidate) {
    return candidate as Partial<ImageUnderlay>
  }
  return undefined
}

// ── per-dataset content revisions (`VizDataset.rev`) ────────────────────────────
// A logical dataset id names a `$data` SLICE, or the mask-filtered (`.kept`) view of one. Both
// denote CONTENT that changes while the id stays put: the base slice when a run lands new columns,
// the `.kept` view every time the user moves a threshold.
//
// Viz reuses a dataset BY ID, and `VizDataset.rev` is how a host says the content under a stable id
// changed: `DatasetStore.acquire(id, source?, rev?)` re-resolves IN PLACE when the revision it
// recorded differs, and keeps its cheap identity reuse when the revision matches or is absent. So
// each declared dataset goes onto the wire under the id the DECLARATION wrote, carrying a DIGEST OF
// THE CONTENT it currently denotes as its `rev`.
//
// That digest used to be carried IN THE ID (`<logical>#<digest>`), with a reverse map so the
// resolver could still answer in the declaration's own terms — because `rev` was documented and
// implemented nowhere, and re-publishing under the same ids left the FIRST source pinned: the
// "after" pane of a before/after pair kept reporting the rows it was first given, and editing a
// criterion's min/max changed nothing on screen. It invalidated correctly, at the price of minting
// a new dataset IDENTITY on every content change — and a resolved dataset is also an identity
// space, so each edit silently reset the state keyed to it (a brush/gate in that space most of
// all). The same digest carried as `rev` invalidates exactly as before and keeps the space.
//
// A DIGEST, not a counter. A monotonic "this object is new" token would also invalidate correctly,
// and it is what this first tried — but it makes the revision a function of WHEN a slice object was
// built rather than of what is in it, so two resolutions of identical content disagree. That is a
// real cost, not a purity argument: a landing REPLACES the `$data` slice with a NEW object (a
// wholesale `setData`, or — under incremental-landing INV-10 — a fresh accumulated frame per chunk;
// never a mutation in place, which would leave this identity memo stale and freeze the canvas), so
// equal content would re-resolve the dataset (and re-run the whole per-column filter behind it) for
// nothing; and it breaks the slice-name parity invariant pinned under `core/spec/` (two slices
// differing only in NAME must resolve to structurally identical facts — a counter made them differ
// by an unrelated ordinal). The digest is content-based, so a genuine content change (a chunk
// appended) yields a NEW revision and the canvas re-resolves; identical content is one revision,
// whatever the landing model — which is exactly what keeps INV-10's "landing may be incremental"
// safe here (ITEM-5/6).

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** Scratch for hashing a float EXACTLY (both 32-bit halves) without allocating per value. */
const F64 = new Float64Array(1)
const F64_BITS = new Uint32Array(F64.buffer)

function hashValue(h: number, v: unknown): number {
  if (typeof v === 'number') {
    F64[0] = v
    return Math.imul(Math.imul(h ^ F64_BITS[0], FNV_PRIME) ^ F64_BITS[1], FNV_PRIME)
  }
  const s = typeof v === 'string' ? v : String(v)
  let acc = Math.imul(h ^ s.length, FNV_PRIME)
  for (let i = 0; i < s.length; i++) acc = Math.imul(acc ^ s.charCodeAt(i), FNV_PRIME)
  return acc
}

/** Content digests of the resolved `$data` slices, MEMOIZED BY OBJECT IDENTITY.
 *
 *  The two halves each carry their weight. The digest is what makes the revision honest — equal
 *  content is one revision, changed content another, regardless of when either object was built.
 *  The memo is what makes it affordable: a slice can be hundreds of thousands of rows wide and this runs on
 *  every keystroke, so the O(rows × columns) walk must NOT be on the typing path. A slice object is
 *  replaced only when the store lands new data, so identity is exactly the right memo key: the walk
 *  happens once per landing, alongside the per-column copy the source constructor does anyway. */
const sliceDigests = new WeakMap<object, string>()

function sliceRevision(slice: unknown): string {
  if (slice == null || typeof slice !== 'object') return 'x'
  const known = sliceDigests.get(slice as object)
  if (known !== undefined) return known
  let h = FNV_OFFSET
  let rows = 0
  // Column ORDER must not change the answer — a re-keyed object with the same columns is the same
  // frame — so walk them sorted.
  for (const name of Object.keys(slice as Record<string, unknown>).sort()) {
    h = hashValue(h, name)
    const col = (slice as Record<string, unknown>)[name]
    // ── ITEM-20: `isColumn`, NOT `Array.isArray` ─────────────────────────────────────────────
    //
    // The single most dangerous guard in the tree, and the reason it converts FIRST.
    // `Array.isArray(new Float32Array())` is FALSE, and this guard `continue`s rather than
    // throwing — so a typed column contributes NOTHING to the digest. The digest then becomes a
    // constant (the column NAMES only) across every content change, viz sees an unchanged `rev`,
    // reuses the dataset it resolved the first time, and THE CANVAS FREEZES: sliders move, the
    // mask re-derives, and the plot never updates. No error anywhere.
    //
    // Nothing else would catch it. `canvasFeed.test.ts` had no rev-CHANGES assertion until
    // TEST-26 (below) added one, and a rendered-output test cannot see a stale dataset either —
    // that is precisely the bug the block comment at :169-176 exists to prevent recurring.
    if (!isColumn(col)) continue
    rows = Math.max(rows, col.length)
    h = Math.imul(h ^ col.length, FNV_PRIME)
    // Index access is identical for an Array and a TypedArray, and `hashValue` already hashes a
    // number bit-exactly through its Float64/Uint32 scratch pair — so no new hashing primitive
    // is needed, only a guard that admits the typed form.
    for (let i = 0; i < col.length; i++) h = hashValue(h, (col as ArrayLike<unknown>)[i])
  }
  const digest = `${rows}-${(h >>> 0).toString(36)}`
  sliceDigests.set(slice as object, digest)
  return digest
}

/** A digest of the keep-mask's CONTENT (FNV-1a over its kept/dropped bits, prefixed by length).
 *
 *  Not memoized by identity, unlike the slice above: the mask is re-derived into a FRESH array on
 *  every state change, so an identity memo would never hit. Hashing bits is one cheap pass over an
 *  array the derive just walked anyway. */
function maskRevision(mask: readonly boolean[] | undefined): string {
  if (!mask) return 'x'
  let h = FNV_OFFSET
  for (let i = 0; i < mask.length; i++) {
    h ^= mask[i] === false ? 0 : 1
    h = Math.imul(h, FNV_PRIME)
  }
  return `${mask.length}-${(h >>> 0).toString(36)}`
}

/**
 * What the user is told when a DECLARED plot's close is unavailable.
 *
 * A `controlled: true` plot does not close itself — it hands the gesture back to this app, which
 * routes it to the plot's own declared `close` action. A plot that declares no such action therefore
 * had a close that was fully live, fully styled, and did NOTHING: the user clicked and the plot
 * stayed. So the plot is declared unremovable instead, and the reason names the gesture that DOES
 * work — a declared plot exists because of the state the analysis form produces, so that form is
 * where it goes away.
 *
 * Defaulted HERE rather than made author-writable, deliberately for now: the declaration vocabulary
 * is owned elsewhere this week. Making it overridable per plot is the natural follow-up (see the
 * report) — this constant then becomes the fallback rather than the only answer.
 */
const DECLARED_PLOT_CLOSE_UNAVAILABLE =
  'The analysis declares this plot, so it cannot be closed here. Remove what produces it in the ' +
  'analysis form to take it off the canvas.'

/** Warn ONCE per (view, series, column) about a declared binding the data cannot serve. A missing
 *  column is still REPORTED (it may be an authoring typo, not just data that has not arrived), but
 *  as a non-fatal warning — the canvas re-resolves on every state/data change, so an un-deduped
 *  log would spam the console on every keystroke. */
const warnedBindings = new Set<string>()
function warnUnresolvable(viewId: string, seriesId: string, base: string, column: string): void {
  const key = `${viewId}:${seriesId}:${base}:${column}`
  if (warnedBindings.has(key)) return
  warnedBindings.add(key)
  console.warn(
    `[canvas] ${viewId}: series "${seriesId}" is not plotted — dataset "${base}" has no column ` +
      `"${column}" (the analysis may not have produced it yet, or the binding is misdeclared)`,
  )
}

// ── ONE BASE PER COORDINATE ARTIFACT (ledger #34, second half) ──────────────────────────────
//
// `cellSpaceKey` is `${datasetId}:<space-kind>:${layoutId}`. The layout half is the artifact
// (`withDeclaredLayout`, below). The DATASET half was a per-pane identity: every section mints
// one base per emitted pane (`frame-$i` / `plotted.$i`), so two panes drawn in ONE coordinate set
// still landed in two spaces and still could not link.
//
// THE PANES ARE THE SAME ROWS TWICE. A base per pane therefore also holds a second copy of the
// positions and of the columns, and that cost grows with every plot the user emits. Sharing the
// base removes the duplication and closes the key in one move.
//
// It does NOT force coupled behaviour: linking is opt-in via viz's link group, so a shared space
// is what makes linking POSSIBLE, not what makes it happen.
//
// ITEM-10's per-pane isolation was written for genuinely different DATASETS — "a brush/gate in
// dataset A cannot bleed into B" — and that case is preserved exactly: panes drawn in a different
// coordinate artifact get a different base, a different space key, and (below) canonical ids that
// cannot collide with these. What ITEM-10 was not written for is two views of one row space.

/** The dataset base every pane drawn in `artifact` shares. Derived from the artifact, NOT from a
 *  pane's position in a list: an id keyed by index would change identity — and a dataset identity
 *  is also a selection space and a camera — every time the user removes an earlier plot. The
 *  prefix keeps it out of the namespace a declaration writes its own base ids in. */
function sharedCoordinateBase(artifact: string): string {
  return `@coords:${artifact}`
}

// ── CANONICAL ROW IDS ───────────────────────────────────────────────────────────────────────
//
// A shared base publishes `pointIds`, which is what routes its panes to viz's CANONICAL selection
// space — so a filter/brush fans to every pane over the same rows, INCLUDING panes contributed by
// a different section (composition namespaces dataset ids per contributing view, so those panes
// cannot share a base, and the canonical space is the only channel that reaches across).
//
// The contract on the ids is the whole safety argument: the same row must carry the same id
// everywhere it is drawn, and rows in a DIFFERENT row space must carry ids that never collide.
// So ids are allocated in DISJOINT, DENSE ranges, one range per coordinate artifact, from a
// module-level allocator every view shares.
//
// DENSE, deliberately. `selectionSync.buildIdToRow` backs its reverse lookup with an
// `Int32Array(maxId + 1)`, and says so ("sparse/huge ids waste memory"). A fixed per-space STRIDE
// (`ordinal << 24`) would have been simpler to read and would allocate a 200 MB reverse map for
// the third artifact in a session. Ranges packed by ACTUAL row count keep `maxId` at the total
// number of rows the canvas has drawn.
const coordinateIdRanges = new Map<string, Uint32Array>()
let nextCanonicalId = 0

/** Test-only: forget the allocated ranges, so one spec's allocation cannot shift the next one's. */
export function __resetCoordinateIdsForTests(): void {
  coordinateIdRanges.clear()
  nextCanonicalId = 0
}

/**
 * The canonical ids of the `n` rows of `artifact` — the SAME array for every base and every view
 * that draws that artifact, and disjoint from every other artifact's.
 *
 * `undefined` when there is nothing to identify yet (`n === 0`: the artifact's positions have not
 * landed), or when the session has drawn so many rows that a further range would overflow a
 * `Uint32Array` id. Both degrade to the pre-#34 behaviour — no `pointIds`, so the base is its own
 * isolated space — rather than to ids that could collide, which is the one failure that would be
 * silent and wrong on screen.
 *
 * A remembered range is keyed by artifact and returned unchanged, so an artifact whose row count
 * ever disagreed with its first reading keeps its original identity rather than silently
 * re-identifying rows mid-session; a SHORTER read is served a prefix.
 */
function canonicalIdsFor(artifact: string, n: number): Uint32Array | undefined {
  if (n <= 0) return undefined
  const known = coordinateIdRanges.get(artifact)
  if (known) return n < known.length ? known.subarray(0, n) : known
  if (nextCanonicalId + n > 0xffffffff) {
    console.warn(
      `[canvas] no canonical row ids for coordinate artifact ${artifact}: this session has ` +
        'already identified more rows than a 32-bit id space holds, so its panes stay in their ' +
        'own selection space rather than risking ids that collide with another set of rows.',
    )
    return undefined
  }
  const ids = new Uint32Array(n)
  for (let i = 0; i < n; i++) ids[i] = nextCanonicalId + i
  nextCanonicalId += n
  coordinateIdRanges.set(artifact, ids)
  return ids
}

/**
 * TRANSLATE THE APP'S COORDINATE VOCABULARY INTO VIZ'S (ledger #34).
 *
 * One fact — *which coordinates is this drawn in* — has two names in this tree. The APP says it
 * with `coords: { artifact }` on a dataset entry (ITEM-29, `positionsByArtifact`), which is a
 * vocabulary `libs/viz` has never heard of. VIZ says it with `encode.layout`, which
 * `resolveLayoutId` turns into a grid pane's `layoutId` and `cellSpaceKey` composes into the
 * link-zoom / shared-camera space key. Nothing ever carried the first over to the second, so a
 * canvas that declared its coordinates precisely still reached viz having declared no layout at
 * all — and viz then answered out of the CATALOG.
 *
 * That answer was `'metric'`, for every base on the pane, always: this file's own frame source
 * declares exactly one layout under that fixed id, so `resolveLayoutId` takes its SOLE-layout arm
 * and the coordinate artifact never reaches the key. Two panes drawn in genuinely different
 * coordinate sets therefore carried the same `layoutId` — which is the hazard the space scoping
 * exists to prevent (`linkZoom.ts` calls it the coordinate-blind-zoom fix), and the same shape as
 * the `layouts[0]` guess this work already deleted from the DRAWING path. It survived here
 * because nothing connected the drawing path to the linking path.
 *
 * So: a series whose base DECLARED an artifact goes onto the wire declaring that artifact as its
 * layout. Same artifact ⇒ same `layoutId`; different artifact ⇒ different `layoutId`. The
 * declaration is the app's, the channel is viz's, and `libs/viz` is byte-unchanged — the library
 * is not taught what an artifact is.
 *
 * Deliberately narrow:
 *  - an AUTHOR-declared `encode.layout` wins, always. This translates the app's own binding into
 *    the channel viz reads; it does not overrule a declaration already written in that channel.
 *  - a base with no `coords` is untouched (byte-identical), so every canvas that never declared
 *    its coordinates keeps whatever viz resolved for it before.
 *
 * The artifact id is not checked against the catalog, and does not need to be: `resolveLayoutId`
 * passes a declared string through unvalidated, and the frame source serves the injected
 * coordinates for that base regardless of the id it is asked for (the id is a key, not a selector,
 * on this source). `useGridData`'s `ensureBuffers` files and reads the buffer under the SAME
 * `layoutId`, so the pull and the render stay in agreement.
 *
 * This is ONE of the two components of the space key (`${datasetId}:<space-kind>:${layoutId}`).
 * The other — the per-pane dataset identity that used to keep same-coordinate panes apart — is
 * closed by `sharedCoordinateBase` above, in the same vocabulary and at the same boundary.
 */
function withDeclaredLayout(
  s: VizSeries,
  declaredCoords: Record<string, string>,
  defaultDatasetId: string,
): VizSeries {
  if (typeof s.encode?.layout === 'string' && s.encode.layout !== '') return s
  const { base } = parseLogicalDatasetId(s.datasetId ?? defaultDatasetId, defaultDatasetId)
  const artifact = declaredCoords[base]
  if (artifact === undefined || artifact === '') return s
  return { ...s, encode: { ...s.encode, layout: artifact } }
}

/**
 * Resolve a view's declared `canvas` block into a `{ option, resolver }` feed, or `null`
 * when the view declares no plottable canvas (no `series`). The `DatasetResolver` maps a
 * logical dataset id (`<default>` / `<ds>.<default>` / `<ds>.kept`) onto a `CanvasObsSource` over the
 * matching `$data` slice; a `.kept` id applies the canvas's DECLARED keep-mask
 * (`canvas.mask`, an expression over the view's own state/derived). Re-call on every
 * data/state change — the resolved output feeds `VizController.setOption` (whose default
 * merge cheaply patches).
 *
 * C8: the keep-mask used to be read by CORE out of `$derived.keptMask`, by that exact name,
 * so a processor had to spell its mask `keptMask` or its `.kept` panes silently showed every
 * row. It is declared now, and resolved here — core hands over the scope and nothing else.
 */
export function resolveDeclarativeCanvas(
  spec: ViewSpec,
  inputs: DeclarativeCanvasInputs,
): { option: VizOption; resolver: DatasetResolver; closeActions: Record<string, ResolvedCloseAction> } | null {
  const canvas = spec.canvas as CanvasTemplate | undefined
  if (!canvas || !Array.isArray(canvas.series) || canvas.series.length === 0) return null

  const resolved = resolveCanvasOption(canvas, inputs.scope)

  // The canvas's DEFAULT dataset id — the id the DECLARATION named its first `datasets` entry (or,
  // failing that, its top-level `dataset`). r3canvas: this line already computed exactly that and
  // then discarded it in favour of a literal `?? 'obs'`, which is what made `obs` a name core knew.
  // A declaration with neither ⇒ `''`, i.e. NO default: every series must then name its own
  // `datasetId`, and one that does not resolves against an absent slice (honest empty canvas)
  // rather than silently against whatever the processor happened to call `obs`.
  const defaultDatasetId: string =
    (Array.isArray(resolved.datasets) ? resolved.datasets[0]?.id : undefined) ??
    (resolved as { dataset?: { id?: string } }).dataset?.id ??
    ''
  // Drop every resolved series whose declared columns the CURRENT data cannot serve. Viz validates
  // encode-explicit bindings against the dataset catalog and throws for the WHOLE option, so one
  // not-yet-produced column (a metric before its run) would otherwise blank the canvas and
  // console-error on every render. Dropping is per-series, so a partially-available slice still
  // plots the series it CAN (e.g. after the user removes one metric from the table).
  const series = (resolved.series ?? []).filter((s: VizSeries) => {
    const { base } = parseLogicalDatasetId(s.datasetId ?? defaultDatasetId, defaultDatasetId)
    const missing = unresolvableBinding(s, asObsColumns(frameAt(inputs.data, base)))
    if (missing != null) warnUnresolvable(spec.id, String(s.id ?? '?'), base, missing)
    return missing == null
  })
  // A declared canvas with no PLOTTABLE series is NOT an active canvas — either its DYNAMIC
  // (`for_each`/`when`) content expands to zero (cell-filter before any criterion is picked) or
  // none of its bindings resolve against the current data (QC before a run). Return null so the
  // center shows its honest empty hero (`workbench-canvas-empty`) until real content resolves; the
  // first picked criterion / completed run re-resolves to non-empty series and the canvas activates.
  if (series.length === 0) return null
  // The DECLARED keep-mask expression (`canvas.mask`), evaluated against the view's live
  // scope. Undeclared / non-array ⇒ no mask (every row kept), exactly as before.
  const declaredMask = typeof canvas.mask === 'string' ? evalExpr(canvas.mask, inputs.scope) : undefined
  const keptMask = Array.isArray(declaredMask) ? (declaredMask as readonly boolean[]) : undefined
  // The canvas's own DEFAULT dataset base is what the project's plottable-XY positions feed.
  const { base: defaultBase } = parseLogicalDatasetId(defaultDatasetId, defaultDatasetId)
  // The DECLARED per-base coordinates (ITEM-29), expanded from the same templates in the same
  // scope as the option above — see `resolveCanvasCoords` for why that has to be true. Keyed
  // by the parsed BASE rather than by the declared id, because that is what `positionsFor`
  // receives: a `.kept` variant of a declared base is the same points, filtered, and must be
  // drawn in the same coordinates rather than falling through to the project-wide fallback.
  const declaredCoords: Record<string, string> = {}
  for (const [id, artifact] of Object.entries(resolveCanvasCoords(canvas, inputs.scope))) {
    declaredCoords[parseLogicalDatasetId(id, defaultDatasetId).base] = artifact
  }
  // ── the shared coordinate base (see `sharedCoordinateBase`) ────────────────────────────────
  // Every declared base that names an artifact is folded onto ONE base per artifact. `shareTo`
  // maps a DECLARED base onto the base that now carries it; `membersOf` is the inverse, and is
  // what the resolver reads columns through — the shared base's columns are the union of the
  // columns of the panes that fold onto it, in declaration order, so a pane's own binding still
  // resolves against a frame that contains it. A base that declares NO artifact is absent from
  // both maps and travels byte-identically (every canvas that predates `coords` is untouched).
  const shareTo = new Map<string, string>()
  const membersOf = new Map<string, string[]>()
  for (const [base, artifact] of Object.entries(declaredCoords)) {
    const shared = sharedCoordinateBase(artifact)
    shareTo.set(base, shared)
    const members = membersOf.get(shared)
    if (members) {
      if (!members.includes(base)) members.push(base)
    } else {
      membersOf.set(shared, [base])
      // The shared base is drawn in the artifact its members declared — stated in the same map
      // `withDeclaredLayout` and `positionsFor` read, so the coordinate half of the key and the
      // positions actually served come from ONE statement rather than two that could drift.
      declaredCoords[shared] = artifact
    }
  }
  /** The logical id a declaration's id now names — same `.kept`-ness, shared base. */
  const shareId = (logicalId: string): string => {
    const { base, kept } = parseLogicalDatasetId(logicalId, defaultDatasetId)
    const shared = shareTo.get(base)
    if (shared === undefined) return logicalId
    return kept ? `${shared}.kept` : shared
  }
  /**
   * The columns a base denotes: for a shared base, the union of its members' frames.
   *
   * A union is only safe if two members naming ONE column mean the same column, and here they do:
   * the emitting sections key a plot's column by an identity that is already disambiguated when
   * two entries would otherwise contest a name (`tests/e2e/15-visualize/entries-contested.spec.ts`
   * — "disambiguated by its DECLARED group, never by a storage index", and by the entry KEY when
   * no grouping is declared). Two members that DO name one column are the same column drawn twice,
   * which is the case this whole change exists to stop paying for twice.
   */
  const columnsAt = (base: string) => asObsColumns(frameAt(inputs.data, base))
  const columnsFor = (base: string) => {
    const members = membersOf.get(base)
    if (!members) return columnsAt(base)
    if (members.length === 1) return columnsAt(members[0])
    const merged: Record<string, readonly number[] | readonly string[]> = {}
    for (const m of members) Object.assign(merged, columnsAt(m))
    return merged
  }

  // The CONTENT revision of each logical dataset id (see the block comment above), memoized per
  // resolve so one logical id carries exactly one revision within an option.
  const revOf = new Map<string, string>()
  const datasetRev = (logicalId: string): string => {
    const known = revOf.get(logicalId)
    if (known !== undefined) return known
    const { base, kept } = parseLogicalDatasetId(logicalId, defaultDatasetId)
    // The base slice's revision always participates: a `.kept` view of NEW columns is new content
    // even when the mask bits are unchanged.
    //
    // A SHARED base is the union of its members, so its revision is the COMBINATION of theirs —
    // each still memoized by slice identity, which is what keeps the O(rows × columns) walk off
    // the typing path. Combining the members' digests rather than digesting the merged object is
    // what preserves that memo: the merged object is rebuilt on every resolve, so it would hit
    // the identity cache never. The member COUNT participates through the join, so emitting a
    // second pane over one artifact is a content change even when its columns duplicate the
    // first's.
    const members = membersOf.get(base)
    const own = members
      ? members.map(m => sliceRevision(frameAt(inputs.data, m))).join('+')
      : sliceRevision(frameAt(inputs.data, base))
    const slice = kept ? `${own}.${maskRevision(keptMask)}` : own
    // ── THE DECLARED COORDINATES ARE CONTENT (ledger #21) ─────────────────────────────────
    //
    // `rev` is what tells viz a dataset it already resolved has changed; without a change it
    // REUSES the source it built the first time. The declared coordinates are read
    // ASYNCHRONOUSLY (`canvasHostProvider` fires the read and re-publishes when it lands), so
    // the first publish of an emitted plot resolves a base with NO positions, and the second —
    // the one carrying them — computed a byte-identical `rev` out of a slice that never moved.
    // Viz kept the empty source, and the bare-frame plot rendered zero points forever: the
    // owner's *"I saw nothing plot"*, and a live control that does nothing.
    //
    // A bare frame is the case that makes it total rather than rare: it binds no column at all,
    // so the slice it would otherwise take a revision from is EMPTY BY DESIGN and its positions
    // are the only content it has. Both halves participate — WHICH artifact (a different
    // coordinate set is different content) and WHETHER its positions have arrived (the
    // transition this fix exists for) — so the id changes exactly once, when the read lands.
    const artifact = declaredCoords[base]
    const coords =
      artifact === undefined
        ? ''
        : `.${artifact}:${inputs.positionsByArtifact?.get(artifact)?.length ?? 'pending'}`
    const rev = `${slice}${coords}`
    revOf.set(logicalId, rev)
    return rev
  }
  // WHERE each surviving plot sits. Derived from the plots themselves (`placeSeries`) rather than
  // from a parallel `grid` list, so a `for_each` can place an unbounded, user-built set — and so a
  // plot the availability filter above just dropped cannot leave an empty pane behind. A
  // declaration that places nothing yields an empty grid and keeps viz's auto one-row placement.
  const placed = placeSeries(series)
  // The per-cell controlled cell-close routing (ITEM-17) — `{ coordId → {action, params} }`,
  // resolved from the canvas' declared per-series `close` bindings (empty for a static canvas).
  // Resolved HERE, above the option, because the option now has to STATE which plots it cannot serve.
  const closeActions = resolveCanvasCloseActions(canvas, inputs.scope)
  // A `controlled` plot with no declared close is one this app has nowhere to route: `controlled`
  // means "do not remove yourself, tell the app", and the app's router answers `if (!binding) return`
  // — so its X was live, styled, and inert. The plot now says it cannot be closed AND why, and viz
  // renders the X unavailable rather than dead. Untouched otherwise: a plot with a close binding, and
  // every uncontrolled plot, goes onto the wire byte-identical.
  const wireSeries = placed.series.map((s: VizSeries) => {
    const withClose =
      s.controlled === true && !closeActions[s.coordId]
        ? { ...s, removeBlockedReason: DECLARED_PLOT_CLOSE_UNAVAILABLE }
        : s
    // Re-pointed only when the id it names actually folds onto a shared base. A series that
    // declares nothing keeps declaring nothing (viz's own "the first entry" default), and a base
    // with no coordinate artifact keeps its declared id — both byte-identical to before.
    const declaredId = withClose.datasetId ?? defaultDatasetId
    const sharedId = shareId(declaredId)
    const shared =
      sharedId === declaredId || sharedId === '' ? withClose : { ...withClose, datasetId: sharedId }
    return withDeclaredLayout(shared, declaredCoords, defaultDatasetId)
  })
  const single = (resolved as { dataset?: VizDataset }).dataset
  // The declared entries, folded onto ONE per coordinate artifact. The FIRST entry that names an
  // artifact keeps its other properties and carries the shared id; the rest are dropped, because
  // they denote the same rows drawn in the same coordinates — which is the whole point (one
  // entry, one copy of the positions and the columns, one identity, one space).
  const declaredDatasets = Array.isArray(resolved.datasets) ? resolved.datasets : []
  const sharedDatasets: VizDataset[] = []
  const emitted = new Set<string>()
  for (const d of declaredDatasets) {
    const id = shareId(d.id)
    if (emitted.has(id)) continue
    emitted.add(id)
    sharedDatasets.push({ ...d, id, rev: datasetRev(id) })
  }
  const option: VizOption = {
    ...resolved,
    ...(placed.grid.length > 0 ? { grid: placed.grid } : {}),
    // Only the `rev` and the SHARING are the feed's to say; a declaration's own id travels
    // unchanged whenever it declares no coordinate artifact.
    // A declared `rev` is overwritten rather than combined: every dataset a canvas names is
    // resolved BY THIS FEED out of `$data`, so the digest below measures exactly the content the
    // resolver will hand back, and any second opinion could only restate or contradict it.
    ...(single?.id ? { dataset: { ...single, id: shareId(single.id), rev: datasetRev(shareId(single.id)) } } : {}),
    ...(sharedDatasets.length > 0 ? { datasets: sharedDatasets } : {}),
    // Series name the base that now carries them (identical to the declaration's own id for any
    // base that declares no coordinate artifact). A series with NO `datasetId` still defaults to
    // the first `datasets` entry, resolved through the same map so it cannot name a dropped one.
    series: wireSeries,
  }

  const resolver = createDatasetResolver(
    {
      // A SHARED base serves the union of its members' columns — one frame for the panes that are
      // the same rows twice, so each pane's own binding still resolves and nothing is copied twice.
      obsFor: columnsFor,
      keptMaskFor: () => keptMask,
      // INV-16 (Slice 6): a spatial base's tissue-image underlay, so a declared `image` series
      // (a before/after spatial toggle) paints on the general canvas — no viz change.
      // A shared base has no `$data` slice of its own, so it asks on behalf of its members and
      // takes the first underlay any of them carries (they are the same rows in the same
      // coordinates; a spatial raster that belongs to one belongs to all of them).
      imageFor: base =>
        (membersOf.get(base) ?? [base])
          .map(m => imageForBase(inputs.data, m, defaultBase))
          .find(img => img !== undefined),
      // Bug 2: the REAL plottable-XY coordinates for the DEFAULT base's scatter x/y (resolved from
      // the project's layout artifact by the canvas host). Any other base ⇒ column fabrication.
      // ITEM-29 — a base that DECLARED its coordinates is drawn in them; a base that did not
      // keeps the legacy project-wide fallback, and only for the DEFAULT base. The declared
      // arm is checked first, so a canvas that says which coordinates it means is never
      // overruled by the project's first plottable-xy artifact.
      positionsFor: base => {
        const artifact = declaredCoords[base]
        if (artifact !== undefined) return inputs.positionsByArtifact?.get(artifact)
        return base === defaultBase ? inputs.positions : undefined
      },
      // #34 — the canonical row ids of a base drawn in a declared coordinate artifact, so panes
      // over those rows share viz's canonical selection space (and panes over any OTHER rows
      // carry ids that cannot collide with them). A base with no declared artifact gets none and
      // stays its own isolated space, exactly as before.
      pointIdsFor: base => {
        const artifact = declaredCoords[base]
        if (artifact === undefined) return undefined
        const positions = inputs.positionsByArtifact?.get(artifact)
        return positions ? canonicalIdsFor(artifact, positions.length) : undefined
      },
    },
    defaultDatasetId,
  )
  return { option, resolver, closeActions }
}
