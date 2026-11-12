// canvasBinding.ts — the CANVAS resolution seam (declarative-canvas-plots ITEM-2/3/4/8/10).
//
// A processor declares its canvas plot as a strict-JSON `@txresbench/viz` `VizOption` in the
// view_spec's `canvas` block (schema.ts / ITEM-1). The workbench RESOLVES that declaration and
// drives the SINGLE canvas `GridWorkspace` via `VizController.setOption` — it never spawns a
// second `<Viz>`. Two resolution seams keep `@txresbench/viz` pure:
//
//   1. `DatasetResolver(id) → DataSource` (ITEM-2/10) — maps the LOGICAL dataset ids a
//      declaration uses (`<default>` / `<default>.kept` / `<ds>.<default>` / `<ds>.kept`) onto
//      array-backed `DataSource`s over the analysis output, where `<default>` is whatever the
//      declaration named its FIRST `canvas.datasets` entry. `*.kept` = the base slice filtered by
//      the canvas's DECLARED `mask` expression. Each resolved id is its OWN ISOLATED identity space
//      (it exposes NO `pointIds`), so a brush/gate in dataset A cannot bleed into B (viz auto-shards
//      by identity space — Coordination.store's per-space selection).
//   2. `$ref` + `for_each` resolution (ITEM-3/8) — `$state`/`$derived` refs in option VALUES are
//      resolved (reusing `expr.ts`) BEFORE `setOption`, and a `for_each` on a `series`/`datasets`
//      template is expanded per selected dataset. Viz keeps receiving strict JSON.
//
// Pure / framework-free (no React) so the whole mechanism is directly unit-testable.

import type {
  VizController,
  VizDataset,
  VizGridEntry,
  VizOption,
  VizRegion,
  VizSeries,
  DataSource,
  DatasetResolver,
  DatasetCatalog,
} from '@txresbench/viz'
import { evalExpr, evalWhen, expandForEach, interpolate, isRef, type Scope } from '@/modules/workbench/core/runtime/expr'
import { asNumsZeroMissing, asStrs, isColumn, isIdentifierColumn } from '@/modules/workbench/core'

// ── logical dataset ids ────────────────────────────────────────────────────────
// The declaration uses LOGICAL ids, decoupled from the concrete data plane: `<default>` (the
// canvas's OWN default slice — its first declared `canvas.datasets` entry), `<default>.kept` (that
// slice filtered by the declared keep-mask), `<ds>.<default>` / `<ds>.kept` (a NAMED dataset's
// slice / filtered slice). The resolver maps each to a source.
//
// ── the de-privileging (r3canvas) ───────────────────────────────────────────────
// This parser used to hardcode the literal `'obs'` as the default slice name, in three of its five
// arms. Two of them (`id === 'obs'`, `id === 'obs.kept'`) were already redundant with the generic
// arms below them — they answered exactly what the fallthrough / the `.kept` arm answers — so they
// were pure privilege with no behaviour attached, and are simply gone. The third (`.obs` suffix) is
// the only arm that genuinely needs to know the default name, so it is now PARAMETERIZED: the
// caller supplies the id the DECLARATION chose. `obs` remains a perfectly legal name for a
// processor to pick; it is no longer a name core knows.

/** The parsed shape of a logical dataset id: which base namespace + whether it is the
 *  `.kept` (mask-filtered) variant. */
export interface LogicalDataset {
  /** the base namespace — the canvas's default slice id, or a named `<ds>`. */
  readonly base: string
  /** `true` ⇒ the `.kept` variant (the base slice filtered by the declared keep-mask). */
  readonly kept: boolean
}

/**
 * Parse a logical dataset id into `{ base, kept }`.
 *
 * `defaultDatasetId` is the id the DECLARATION named its default slice (its first
 * `canvas.datasets` entry). It is needed for exactly one shape — the `<ds>.<default>` suffix form
 * (`primary.obs` when the declaration's default is `obs`, `primary.frame` when it is `frame`) —
 * which strips the suffix to yield the NAMED base. Omitted / empty ⇒ that arm is skipped and a
 * dotted id is taken verbatim as its own base.
 *
 * The other shapes need no default: `<default>` and `<ds>` both fall through to `{ base: id }`, and
 * `<anything>.kept` is stripped by the generic `.kept` arm.
 */
export function parseLogicalDatasetId(id: string, defaultDatasetId?: string): LogicalDataset {
  if (id.endsWith('.kept')) return { base: id.slice(0, -'.kept'.length), kept: true }
  const suffix = defaultDatasetId != null && defaultDatasetId !== '' ? `.${defaultDatasetId}` : ''
  if (suffix !== '' && id.length > suffix.length && id.endsWith(suffix)) {
    return { base: id.slice(0, -suffix.length), kept: false }
  }
  return { base: id, kept: false }
}

// ── the obs-backed DataSource (an isolated identity space) ──────────────────────
// A `DataSource` over a resolved `/obs` columnar slice: numeric columns are exposed as BOTH
// `value` and `continuous` (so a violin's value channel + a scatter's colorBy both bind), string
// columns are categorical. `keepMask` drops the non-kept rows (the `.kept` variant). With no
// canonical ids it exposes NO `pointIds` → an ISOLATED identity space (ITEM-10): two resolved ids
// never cross-select. With canonical ids (a base SHARED by panes over one row space, ledger #34)
// it publishes them and joins viz's canonical space.

type Positions = Awaited<ReturnType<DataSource['positions']>>
type SparseColumn = Awaited<ReturnType<DataSource['valueColumn']>>
type CategoricalColumn = Awaited<ReturnType<DataSource['categorical']>>
type ContinuousColumn = Awaited<ReturnType<DataSource['continuous']>>
type ImageUnderlay = Awaited<ReturnType<DataSource['imageUnderlay']>>
type DataTable = Awaited<ReturnType<DataSource['table']>>
type GraphData = Awaited<ReturnType<DataSource['graph']>>

/** An obs columnar slice: `{ column: number[] | string[] }`. */
export type ObsColumns = Record<
  string,
  // ITEM-21 — a column is boxed OR typed. The union is the honest type: the typed migration
  // delivers `Float32Array`/`Uint16Array`/`Uint32Array` here, and typing this as boxed-only
  // would mean a cast at every call site, which is how a representation change becomes
  // invisible to the type system and then to the reader.
  readonly number[] | readonly string[] | ArrayLike<number>
>

// ITEM-25 — one shared coercer. This file keeps the LOOSE (`Number(x)`, 0-for-missing) semantics
// it always had, imported under its explicit name: switching it to the NaN semantics would put a
// NaN into the fabricated `Float32Array` coordinates below, which is an UNRENDERABLE point rather
// than a dropped one. Changing it is a behaviour change, not a tidy-up.
const asNums = asNumsZeroMissing
const isNumericCol = (v: ArrayLike<unknown>): boolean =>
  // A TypedArray is numeric BY CONSTRUCTION — no need to read a value, and reading one would be
  // wrong for a zero-length one. The boxed path keeps its head peek.
  ArrayBuffer.isView(v) ? true : v.length > 0 && typeof v[0] === 'number'

/** The kind of catalog column a channel validates against (viz `catalogColumnSet`). */
type BoundColumnKind = 'value' | 'categorical'

/**
 * The catalog channel a column is advertised on, or `null` when it is advertised on none.
 *
 * THE single classifier. The frame-backed source's `catalog()` publishes what viz may bind, and
 * `unresolvableBinding` predicts what viz will accept — two readings of one rule, and while they
 * were written out separately they disagreed: the catalog withholds a per-row identifier from its
 * categorical channel (a column with a distinct value in every row is not a grouping) and the
 * predicate accepted any non-numeric column. So a binding the catalog refuses to advertise passed
 * the pre-filter, reached viz, and was rejected there — where the failure aborts the WHOLE option
 * and blanks the canvas, which is precisely what the pre-filter exists to prevent (G3).
 *
 * A numeric column is catalogued as BOTH `value` and `continuous`, so `'value'` covers either
 * channel; everything else is a grouping unless it is a per-row identifier.
 *
 * An EMPTY column has no kind — `null`, not `'categorical'`. It used to fall through to the
 * grouping branch, so a column with no values at all was advertised as a category axis: a
 * confident claim about a column nothing is known about. `isNumericCol` needs a value to read
 * (`typeof v[0]`), so "no values" is the absence of evidence, and the two callers both want the
 * honest answer — the catalog should not offer a grouping it cannot serve, and the pre-filter
 * should drop a series binding it rather than let viz reject the whole option.
 */
function columnKind(col: ArrayLike<unknown>): BoundColumnKind | null {
  if (isNumericCol(col)) return 'value'
  if (col.length === 0) return null
  return isIdentifierColumn(col as readonly unknown[]) ? null : 'categorical'
}

/** The single category an UNGROUPED distribution reports. It is shown in a legend, so it says
 *  what it means rather than repeating the phantom channel id (`group`) the resolver invented. */
export const UNGROUPED_CATEGORY = 'All'

/** Encode a `string[]` into `{ codes, categories }` (first-seen category order). */
function encodeCategorical(values: string[]): { codes: Uint16Array; categories: string[] } {
  const categories: string[] = []
  const index = new Map<string, number>()
  const codes = new Uint16Array(values.length)
  values.forEach((v, i) => {
    let c = index.get(v)
    if (c === undefined) {
      c = categories.length
      categories.push(v)
      index.set(v, c)
    }
    codes[i] = c
  })
  return { codes, categories }
}

/**
 * A `DataSource` (the `@txresbench/viz` wire contract) synthesized from a `/obs` columnar slice, with an
 * optional client keep-mask (the `.kept` variant). Its catalog lists numeric columns as BOTH value
 * and continuous columns, and string columns as categorical.
 *
 * ── IDENTITY SPACE (ITEM-10, and the ledger-#34 correction) ─────────────────────────────
 *
 * A source given NO `pointIds` implements no `pointIds` method, so it remains its OWN isolated
 * identity space — unchanged, and still the right answer for a base that denotes rows nothing
 * else on the canvas shares (the shipped before/after pair's two bases).
 *
 * A source given `pointIds` publishes them, which routes its panes to viz's CANONICAL selection
 * space. That is only correct for ids that are canonical — the same row carries the same id in
 * every view that draws it, and rows in a DIFFERENT row space carry ids that never collide with
 * these. `canvasFeed`'s coordinate-identity allocator is the one producer, and it owns that
 * guarantee; this class only serves what it is handed (mask-filtered, exactly as `positions` is,
 * so a `.kept` view publishes the ids of the rows that SURVIVED).
 */
export class CanvasObsSource implements DataSource {
  /** Present ONLY when canonical ids were supplied (mirrors viz's own fixture source): an absent
   *  method is the wire contract's "isolated identity space". */
  readonly pointIds?: (layoutId?: string) => Promise<Uint32Array>
  private readonly id: string
  private readonly cols: Record<string, number[] | string[]>
  private readonly n: number
  /** Optional spatial image underlay (INV-16, Slice 6): when present, `catalog().hasImage` is
   *  true and `imageUnderlay()` serves it — this is what lets the general canvas feed PAINT a
   *  spatial `image` before/after series (cell-filter's `showSpatial` toggle). Absent ⇒ the
   *  source is metric-only and `imageUnderlay()` throws (byte-identical to before). */
  private readonly image?: Partial<ImageUnderlay>
  /** Optional REAL embedding positions (interleaved `[x0,y0,x1,y1,…]`) for the SCATTER x/y — the
   *  fix for the metric-column fabrication (Bug 2): when present, `positions()` serves these layout
   *  coords (mask-filtered to the kept rows), instead of interleaving the first two numeric obs
   *  columns. Absent ⇒ the legacy metric-column fabrication (byte-identical to before). The array
   *  is the FULL (pre-mask) per-position embedding; the mask below filters it to the kept subset. */
  private readonly injectedPositions?: { positions: Float32Array; length: number }
  /** The keep-mask retained (not just applied) so `positions()` can filter the FULL injected
   *  embedding to the kept rows (the columns are already filtered in the ctor). */
  private readonly keepMask?: readonly boolean[]
  /** The COMMON GLOBAL PREFIX depth the keep-mask applies over (incremental-landing ITEM-8/DEC-37):
   *  `min(present buffer depths)` when a mask is active, so `positions()` and the canonical ids mask
   *  the SAME `[0, keepDepth)` the columns were masked over — a kept slot then addresses one row on
   *  every buffer even while the colour column is still landing. `undefined` ⇒ no mask (full range). */
  private readonly keepDepth?: number
  /** The catalog kind of each column, classified from the UNMASKED base slice.
   *
   *  A `.kept` source is a ROW-SUBSET VIEW of its base; which rows survive a threshold says
   *  nothing about what KIND of column each one is. Classifying after the mask made the schema a
   *  function of the data that happened to survive: tighten a criterion past its last cell and
   *  every column became a zero-length array, so `prot:total_counts` — a numeric metric — was
   *  published as CATEGORICAL and the frame advertised no value column at all. Viz then rejected
   *  the whole option (a violin needs one `value` channel), which aborts `setOption` for the
   *  ENTIRE grid: the before pane froze at the previous threshold alongside the after pane, and
   *  the only trace was a console error per render. An empty selection is a legitimate answer —
   *  the pane should paint an empty distribution — and it can only be one if the frame keeps its
   *  schema when it loses its rows. */
  private readonly kinds: Record<string, BoundColumnKind | null>
  /** Latch for the "no declared coordinates and no determined numeric pair" warning in
   *  {@link positions} — the refusal is a property of this frame, so it is said once per source
   *  rather than once per repaint. */
  private warnedNoPositions = false

  constructor(
    id: string,
    obs: ObsColumns,
    keepMask?: readonly boolean[],
    image?: Partial<ImageUnderlay>,
    positions?: { positions: Float32Array; length: number },
    canonicalIds?: Uint32Array,
  ) {
    this.id = id
    this.image = image
    this.injectedPositions = positions
    this.keepMask = keepMask
    const cols: Record<string, number[] | string[]> = {}
    let n = 0
    for (const [k, v] of Object.entries(obs ?? {})) {
      // ITEM-20 — `isColumn`, not `Array.isArray`. This guard FAILS OPEN: an unrecognised column
      // is skipped, leaving `n = 0`, so the catalog publishes `pointCount: 0` and the pane draws
      // nothing — silently, with a clean console.
      if (isColumn(v)) {
        // ITEM-24 — REFERENCE, not a copy. This was `[...v]`, a full N-length allocation per
        // column per construction, and nothing needed it: every read of `this.cols` below is
        // read-only (`isNumericCol`, `asNums`, `Float32Array.from`, `encodeCategorical`), and the
        // keep-mask branch below REASSIGNS with `.filter`, which returns a new array rather than
        // mutating this one. So the source never writes through the alias.
        //
        // Aliasing `$data` is safe for the same reason it is aliased everywhere else: a slice is
        // REPLACED on every landing with a NEW object, never mutated in place (`canvasFeed.ts:146`),
        // and this source is rebuilt per resolve. That holds under incremental landing too — each
        // chunk lands a fresh accumulated frame (incremental-landing ITEM-5/6) — so the alias is
        // never written through by a later chunk. The cross-source alignment the successor DID
        // change (positions vs a now-partial colour column) is handled below at the keep-mask.
        cols[k] = v as number[] | string[]
        n = Math.max(n, (v as ArrayLike<unknown>).length)
      }
    }
    // Classify BEFORE masking — the schema belongs to the base slice, not to the survivors.
    const kinds: Record<string, BoundColumnKind | null> = {}
    for (const k of Object.keys(cols)) kinds[k] = columnKind(cols[k])
    this.kinds = kinds
    // Apply the keep-mask up front so every channel is the kept subset (a cell is KEPT where
    // `keepMask[i] === true`). A missing/short mask entry defaults to kept (never silently drops).
    if (keepMask) {
      // ── INV-10 EXTENDED (incremental-landing ITEM-8 / DEC-7/DEC-37) ─────────────────────────────
      //
      // A keep-mask indexes by GLOBAL row `i`. Positions come from a DIFFERENT path than the `$data`
      // colour columns (`buildCanvasDataSource().positions`, never the declarative arc), and under
      // incremental landing the two can be at DIFFERENT depths — a partial `$data` colour column
      // beside a fully-landed positions buffer. Filtering EACH by the same mask over its OWN local
      // extent would mask column `i` of one against row `i` of another and paint the right points the
      // wrong colours: full-length, plausible, clean console — this codebase's named worst failure.
      //
      // The fix (DEC-37 — "index both by the same GLOBAL offset"): serve the COMMON GLOBAL PREFIX.
      // Cap every buffer at `keepDepth = min(present depths)` and apply the mask over `[0, keepDepth)`
      // only, so a kept slot addresses ONE row across every buffer (row `i` is row `i` on both
      // sides) and the rows past the shortest buffer are simply NOT PAINTED YET — they arrive with
      // the next chunk. This is index-ALIGNED (INV-10 upheld) and is NOT "filtering independently".
      // At equal depths (every wholesale landing, every completed accumulation) `keepDepth` is the
      // full length and this is byte-identical to before.
      let keepDepth = Infinity
      for (const k of Object.keys(cols)) keepDepth = Math.min(keepDepth, (cols[k] as ArrayLike<unknown>).length)
      if (positions && positions.length > 0) keepDepth = Math.min(keepDepth, positions.length)
      if (!Number.isFinite(keepDepth)) keepDepth = n // no present buffers ⇒ fall back to the sized n
      this.keepDepth = keepDepth
      for (const k of Object.keys(cols)) {
        // ITEM-21 — the `.map`/`.filter` BODY converts with its guard, in the same commit.
        // `.filter` on a TypedArray returns a TypedArray, so the old cast to `number[] | string[]`
        // was a lie that poisoned every downstream column check. Compacting through an explicit
        // loop keeps ONE representation (boxed) for the masked result, whatever arrived. Capped at
        // `keepDepth` so a longer column is truncated to the common prefix, not filtered past it.
        const src = cols[k] as ArrayLike<unknown>
        const kept: unknown[] = []
        for (let i = 0; i < keepDepth && i < src.length; i++) if (keepMask[i] !== false) kept.push(src[i])
        cols[k] = kept as number[] | string[]
      }
      let count = 0
      for (let i = 0; i < keepDepth; i++) if (keepMask[i] !== false) count++
      n = count
    }
    // A base that DECLARED its coordinates and binds no column is still a real, drawable set of
    // points — the BARE frame (visualize-pane ITEM-43): *"without it an uncoloured frame is
    // unreachable in a pane where only colour-by rows emit."* Its length comes from
    // the positions, because there is no column to take it from; before this, such a base
    // reported `pointCount: 0` and the plot rendered nothing at all, which is a live control that
    // does nothing — the class of defect this round removes.
    //
    // Only when there are NO columns: a base WITH columns keeps taking its length from them, so
    // every existing canvas is byte-identical, and a positions array longer than the columns
    // cannot silently inflate a masked count.
    if (n === 0 && positions && positions.length > 0) {
      n = keepMask
        ? Array.from({ length: positions.length }, (_, i) => i).filter(i => keepMask[i] !== false).length
        : positions.length
    }
    this.cols = cols
    this.n = n
    // The canonical ids, filtered to the SAME kept rows as the columns and the positions above —
    // a `.kept` view publishes the ids of the rows that survived, which is what makes a filter in
    // one pane land on the right rows of another. Assigned as an OWN property (viz's own fixture
    // source does the same) so an unsupplied id set leaves the method genuinely absent rather
    // than present-and-throwing: `DatasetStore` reads the presence of the method as the
    // declaration of a canonical namespace.
    if (canonicalIds) {
      // Capped at the same COMMON PREFIX (`keepDepth`) the columns + positions were masked over,
      // so the published ids are exactly the kept rows that are addressable on every buffer this
      // frame (ITEM-8/DEC-37). `keepDepth` is the full length once landing completes.
      const idDepth = this.keepDepth ?? canonicalIds.length
      const ids = keepMask
        ? canonicalIds.filter((_, i) => i < idDepth && keepMask[i] !== false)
        : canonicalIds
      this.pointIds = async () => ids
    }
  }

  async catalog(): Promise<DatasetCatalog> {
    // An IDENTIFIER column (a distinct value in every row) is not advertised as categorical.
    // A chart that requires a `group` channel resolves the first categorical column it is
    // offered, so leaving one here means the per-row identifier gets bound as the grouping —
    // producing one group per row. The predicate is shared with the criteria builder
    // (`isIdentifierColumn`) rather than restated, because a column that is not a grouping
    // here is not a keep-set there, and two copies of one rule drift — which is exactly what
    // `columnKind` now prevents between this catalog and `unresolvableBinding` (G3).
    const numeric = Object.keys(this.cols).filter(k => this.kinds[k] === 'value')
    const strings = Object.keys(this.cols).filter(k => this.kinds[k] === 'categorical')
    return {
      datasetId: this.id,
      pointCount: this.n,
      layouts: [{ id: 'metric', kind: 'layout', label: 'Metric space' }],
      // numeric metric columns bind BOTH a violin/box `value` channel and a scatter/histogram
      // `continuous` channel — list them in both so either declaration validates.
      valueColumns: numeric,
      continuousColumns: numeric.map(id => ({ id, kind: 'continuous' as const, label: id })),
      categoricalColumns: strings.map(id => ({ id, kind: 'categorical' as const, label: id })),
      // INV-16: a spatial slice advertises its tissue-image underlay so the `image` view-kind paints.
      hasImage: this.hasCompleteImage(),
    }
  }

  private hasCompleteImage(): boolean {
    const i = this.image
    return !!(i && i.data && i.width && i.height && i.affine)
  }

  async positions(_layoutId: string): Promise<Positions> {
    // REAL embedding path (Bug 2 fix): when a producer layout artifact was resolved for this
    // base, serve its coordinates as the scatter x/y — mask-filtered to the SAME kept rows the obs
    // columns were filtered to, so the `.kept` variant paints visibly FEWER points (the thinning).
    if (this.injectedPositions) {
      const src = this.injectedPositions.positions
      // Cap at the COMMON GLOBAL PREFIX the columns were masked over (ITEM-8/DEC-37): while the
      // colour column is still landing, positions past `keepDepth` have no colour to pair with, so
      // they are not painted yet — masking them here too keeps a kept slot addressing ONE row on
      // both buffers. `keepDepth` is the full length once landing completes, so nothing changes then.
      const total = this.keepDepth ?? this.injectedPositions.length
      if (this.keepMask) {
        const out = new Float32Array(this.n * 2)
        let j = 0
        for (let i = 0; i < total; i++) {
          if (this.keepMask[i] === false) continue
          out[j * 2] = src[i * 2] ?? 0
          out[j * 2 + 1] = src[i * 2 + 1] ?? 0
          j++
        }
        return { positions: out.subarray(0, j * 2), length: j }
      }
      const kept = total === this.n ? src : src.subarray(0, this.n * 2)
      return { positions: kept, length: this.n }
    }
    // ── Legacy metric layout — and the `[0]`/`[1]` it no longer takes (ITEM-7) ──────────────
    //
    // With no embedding resolved, the only coordinates a metric-only frame can offer are two of
    // its OWN numeric columns. This used to be written `numeric[0]` / `numeric[1]` over
    // `Object.keys(this.cols)` — i.e. INSERTION order — so which columns became the scatter's x
    // and y depended on how the frame happened to be built. That is the owner-reported defect: a
    // frame carrying `metric_a`, `metric_b`, `metric_c` plotted the first two of them as a
    // coordinate space, and a frame whose builder happened to insert an id-like or unrelated
    // metric first plotted THAT as an axis. Catalog/insertion order is real, stable, and
    // meaningless — a plausible answer, which is what made it survive.
    //
    // So the fallback may only bind when the choice is NOT A CHOICE: EXACTLY TWO numeric columns,
    // where the pair itself determines the axes. Zero, one, or three-or-more is a resolution the
    // frame cannot make, and the honest answer is a REFUSAL — a zero-length `Positions` and one
    // warning naming the candidates — not fabricated coordinates that paint a confident scatter
    // of the wrong two columns (INV-1: a resolver may not take `[0]`).
    //
    // (Even in the two-column case the ASSIGNMENT of x vs y is still the frame's own column
    // order; there is no declared axis order here to prefer. The pair bounds the damage to
    // "possibly transposed", never "the wrong columns entirely". A canvas that means specific
    // coordinates declares them — `coords` / `positionsFor` — and takes the branch above.)
    //
    // Charts that don't read positions (violin/box/histogram) ignore the result either way.
    const numeric = Object.keys(this.cols).filter(k => isNumericCol(this.cols[k]))
    if (numeric.length !== 2) {
      // ONE warning per source (not per render): the refusal is a property of the frame, and a
      // per-call warn would bury it under a repaint loop. Named candidates, because "this canvas
      // has no coordinates" is not actionable and "these four columns could each have been an
      // axis and none of them was chosen" is — the same reason `categorical()` names its key.
      if (!this.warnedNoPositions) {
        this.warnedNoPositions = true
        console.warn(
          `[declarative] canvas: frame "${this.id}" declares no coordinates and has ` +
            `${numeric.length} numeric column(s) [${numeric.join(', ')}] — exactly two are needed ` +
            'to stand in for x/y, so no positions are served rather than two of them being ' +
            'picked by column order.',
        )
      }
      return { positions: new Float32Array(0), length: 0 }
    }
    const x = asNums(this.cols[numeric[0]] ?? [])
    const y = asNums(this.cols[numeric[1]] ?? [])
    const positions = new Float32Array(this.n * 2)
    for (let i = 0; i < this.n; i++) {
      positions[i * 2] = x[i] ?? 0
      positions[i * 2 + 1] = y[i] ?? 0
    }
    return { positions, length: this.n }
  }

  async valueColumn(key: string): Promise<SparseColumn> {
    const dense = asNums(this.cols[key] ?? [])
    const row = new Uint32Array(dense.length)
    for (let i = 0; i < dense.length; i++) row[i] = i
    return { row, value: Float32Array.from(dense), length: this.n }
  }

  /**
   * A categorical column — and, for a key this frame does not have, ONE group over every row.
   *
   * A chart whose schema REQUIRES a grouping (the violin) has its channel auto-resolved by
   * `resolveBinding`, which falls back to `catalog.categoricalColumns[0]?.id ?? 'group'`. When
   * the frame has no categorical column at all — the ordinary case for a metrics-only frame,
   * and now the case whenever the only string columns were per-row identifiers — that literal
   * `'group'` names nothing here. Returning an empty column for it made the chart receive ZERO
   * rows and paint nothing: a blank pane where a single distribution belongs.
   *
   * One group spanning all rows is not a fabricated category; it is what "ungrouped" MEANS, and
   * it is the honest answer to "group these rows by nothing in particular". The row count comes
   * from `this.n`, which the constructor already reduced by any keep-mask, so the `.kept`
   * variant degrades to its own survivor count rather than the unfiltered one.
   *
   * An unknown key is still worth saying out loud — a view naming a column that does not exist
   * is an authoring error, and it used to fail silently as an empty chart.
   */
  async categorical(key: string): Promise<CategoricalColumn> {
    const raw = this.cols[key]
    if (raw === undefined) {
      if (key !== '') {
        console.warn(
          `[declarative] canvas: no column "${key}" on this frame — grouping every row together`,
        )
      }
      return { codes: new Uint16Array(this.n), categories: [UNGROUPED_CATEGORY], length: this.n }
    }
    const { codes, categories } = encodeCategorical(asStrs(raw))
    return { codes, categories, length: codes.length }
  }

  async continuous(key: string): Promise<ContinuousColumn> {
    const value = Float32Array.from(asNums(this.cols[key] ?? []))
    return { value, length: value.length }
  }

  async imageUnderlay(): Promise<ImageUnderlay> {
    // INV-16 (Slice 6): serve the spatial tissue-image underlay (raster + the 2×3 affine that is
    // the single alignment source of truth). Routes into the EXISTING `@txresbench/viz` ImageUnderlay —
    // NO new viz API (VIZ_REQUIREMENTS.md §4g). A metric-only source (no image) still throws.
    const i = this.image
    if (!this.hasCompleteImage()) {
      throw new Error(`CanvasObsSource "${this.id}" has no image underlay`)
    }
    return {
      data: i!.data as Uint8Array,
      width: i!.width as number,
      height: i!.height as number,
      channels: (i!.channels ?? 4) as 3 | 4,
      affine: i!.affine as readonly [number, number, number, number, number, number],
    }
  }

  async table(_name?: string): Promise<DataTable> {
    return { rowLabels: [], columns: {} }
  }

  async graph(_id?: string): Promise<GraphData> {
    return { nodeKey: '', paths: [] }
  }
  // NB: `pointIds` is declared + assigned in the CONSTRUCTOR (above), and only when canonical ids
  // were supplied. Absent ⇒ an ISOLATED identity space (ITEM-10 / the `DataSource.pointIds`
  // contract), so its selection never cross-links.
}

// ── the DatasetResolver seam (ITEM-2/10) ────────────────────────────────────────

/** How the engine supplies the analysis data + keep-mask a `DatasetResolver` maps onto sources.
 *  Injected so tests drive it over in-memory obs slices (no backend). */
export interface CanvasBindingDeps {
  /** the columnar slice for a base namespace (the canvas's own default slice id, or `<ds>`). */
  obsFor(base: string): ObsColumns
  /** the client keep-mask for a base namespace (the form's `$derived.keptMask`); `undefined` ⇒ all
   *  cells kept (the `.kept` variant then equals the unfiltered slice). */
  keptMaskFor(base: string): readonly boolean[] | undefined
  /** the spatial tissue-image underlay for a base namespace (INV-16, Slice 6): an
   *  `ImageUnderlay`-shaped `{ data, width, height, channels?, affine }` (raster + 2×3 affine).
   *  Absent/undefined ⇒ a metric-only source (no image); the `.kept` variant shares the base's
   *  image (the raster doesn't change when cells are filtered — only the point overlay does). */
  imageFor?(base: string): Partial<ImageUnderlay> | undefined
  /** The REAL embedding positions (interleaved `[x0,y0,…]`, full pre-mask per-cell) for a base's
   *  scatter x/y (Bug 2). Resolved from the project's plottable-xy artifact — mirrors the
   *  hero `WorkbenchDataSource.positions()` read. Absent/undefined ⇒ the source fabricates x/y from
   *  the first two numeric obs columns (the legacy behavior). The `.kept` variant shares the base's
   *  positions (the array is unfiltered; `CanvasObsSource` masks it to the kept rows). */
  positionsFor?(base: string): { positions: Float32Array; length: number } | undefined
  /**
   * The CANONICAL row ids for a base (full, pre-mask), or undefined when this base denotes rows
   * no other base on the canvas shares — in which case the resolved source stays its own isolated
   * identity space, exactly as every source was before (ITEM-10).
   *
   * "Canonical" is a promise about the ids, not a formatting convention: the same row must carry
   * the same id in every base that draws it, and two bases over DIFFERENT rows must carry ids
   * that never collide. `canvasFeed` is the one producer and owns that; see its allocator.
   */
  pointIdsFor?(base: string): Uint32Array | undefined
}

/**
 * Build the `DatasetResolver` the canvas `VizController` consumes: it maps a LOGICAL dataset id
 * (`<default>` / `<default>.kept` / `<ds>.<default>` / `<ds>.kept`) to a `CanvasObsSource`. A
 * `.kept` id resolves the base slice filtered by `keptMaskFor(base)`. A base and its `.kept`
 * variant are DISTINCT ids ⇒ distinct sources.
 *
 * IDENTITY SPACE (ITEM-10, as corrected by ledger #34): a source is its OWN isolated space unless
 * `pointIdsFor` hands it canonical ids. ITEM-10's isolation was written for genuinely different
 * DATASETS — a brush in dataset A must not bleed into B — and it still holds for them, because
 * canonical ids in different row spaces never collide. It was NOT written for two views of ONE
 * row space, which is what a canvas of panes drawn in the same coordinates is.
 *
 * `defaultDatasetId` is the DECLARATION's own default slice id, forwarded to
 * {@link parseLogicalDatasetId} so the `<ds>.<default>` suffix form strips correctly whatever the
 * processor named it. Omitted ⇒ dotted ids other than `.kept` are taken verbatim.
 */
export function createDatasetResolver(deps: CanvasBindingDeps, defaultDatasetId?: string): DatasetResolver {
  return (id: string): DataSource => {
    // The id arrives in the DECLARATION's own vocabulary and is used as such throughout. It used to
    // arrive content-addressed (`<logical>#<digest>`) and be translated back through a reverse map
    // supplied by `canvasFeed`, because viz reused a resolved dataset by id and ignored the
    // `VizDataset.rev` content token its own option type documents. `rev` is implemented now, so
    // the feed varies THAT and leaves the id alone, and the translation has nothing left to do.
    const { base, kept } = parseLogicalDatasetId(id, defaultDatasetId)
    const obs = deps.obsFor(base)
    const mask = kept ? deps.keptMaskFor(base) : undefined
    // INV-16: the spatial image underlay travels with BOTH the base and its `.kept` variant (the
    // tissue raster is unchanged by filtering — only the point overlay is masked).
    const image = deps.imageFor?.(base)
    // Bug 2: the REAL embedding coordinates for this base's scatter x/y (unfiltered; the source
    // masks it to the kept rows for the `.kept` variant). Undefined ⇒ metric-column fabrication.
    const positions = deps.positionsFor?.(base)
    // #34: the canonical row ids for a SHARED base (undefined ⇒ isolated, as before).
    const canonicalIds = deps.pointIdsFor?.(base)
    return new CanvasObsSource(id, obs, mask, image, positions, canonicalIds)
  }
}

// ── declared-binding availability ───────────────────────────────────────────────
// A processor declares its canvas as DATA, so it can legitimately bind a column that is not
// present YET — QC's violins bind `<modality>:total_counts`, which only exists once a QC run has
// produced `/obs` (`qc.yaml`'s `data.obs` is explicitly "absent until a QC run is present") — or
// no longer, e.g. a metric the user removed from the editable metric table.
//
// Viz validates ENCODE-EXPLICIT bindings against the dataset catalog and THROWS
// (`parse.ts::validateBindings`). That assertion is correct and stays, but it aborts the WHOLE
// option, so ONE unresolvable series blanks the entire canvas and logs a console error on every
// render. The host therefore resolves availability BEFORE driving: `seriesBoundColumns` mirrors
// viz's `encodeExplicitChannelIds` + `catalogColumnSet` pair to list the dataset columns a series
// binds, and `unresolvableBinding` reports the first one the base obs slice cannot serve. Callers
// drop those series (showing the honest empty hero when none survive) rather than handing viz an
// option it is guaranteed to reject. Viz stays the backstop for anything that gets past this.

/**
 * The dataset columns a RESOLVED series binds, each with the kind viz will validate it against.
 * Mirrors `parse.ts::encodeExplicitChannelIds`: viz validates ONLY encode-explicit channels, and
 * only these four name a dataset column (`table` names a table, not a column; a catalog-DEFAULT
 * binding is viz's own fallback and never throws).
 */
export function seriesBoundColumns(series: VizSeries): Array<{ id: string; kind: BoundColumnKind }> {
  const enc = (series as { encode?: Record<string, unknown> }).encode
  if (!enc || typeof enc !== 'object') return []
  const out: Array<{ id: string; kind: BoundColumnKind }> = []
  const add = (v: unknown, kind: BoundColumnKind): void => {
    if (typeof v === 'string' && v !== '') out.push({ id: v, kind })
  }
  add(enc['valueKey'], 'value')
  // A `continuous` channel validates against continuous ∪ value — both are the NUMERIC columns.
  add(enc['continuousKey'], 'value')
  add(enc['groupKey'], 'categorical')
  if (Array.isArray(enc['valueKeys'])) for (const k of enc['valueKeys']) add(k, 'value')
  // ── colorBy ── the channel BOTH shipped emit sections use, and the one this predicate
  // could not see.
  //
  // `colorBy` is not part of viz's `bindingSchema`, so `encodeExplicitChannelIds` does not
  // enumerate it and `validateBindings` never checks it; and viz's own `validateColorBy`
  // throws only for the `blend` pair. A single-channel `colorBy` naming a column the slice
  // cannot serve therefore passed EVERY gate and painted a full-point scatter coloured
  // uniformly "All" — indistinguishable from a legitimate plot of a constant column, with
  // nothing in the console. That is the failure mode the whole availability layer exists to
  // remove, and until now `unresolvableBinding` was a no-op for the only channel the
  // Visualize pane emits: a failed read, or an artifact deleted under an open plot, left the
  // plot standing and lying.
  const cb = enc['colorBy']
  if (cb && typeof cb === 'object' && !Array.isArray(cb)) {
    const c = cb as { mode?: unknown; key?: unknown; categoryKey?: unknown; valueKey?: unknown }
    if (c.mode === 'blend') {
      // The blend pair — the two columns viz itself validates, mirrored here so the series is
      // DROPPED rather than throwing and blanking the whole canvas.
      add(c.categoryKey ?? c.key, 'categorical')
      add(c.valueKey, 'value')
    } else if (c.mode === 'categorical') {
      add(c.key, 'categorical')
    } else if (c.mode === 'continuous' || c.mode === 'value') {
      add(c.key, 'value')
    }
    // An unknown/absent `mode` binds nothing here on purpose: `assertColorByShape` is viz's
    // LOUD refusal for that shape, and silently dropping the series would hide an authoring
    // mistake behind an empty canvas.
  }
  return out
}

/**
 * The first column `series` binds that `obs` cannot serve as the required KIND, or `null` when
 * every declared binding resolves. The kind test runs the SAME `columnKind` classifier
 * `CanvasObsSource.catalog()` publishes from — not a second statement of it — so this predicate
 * cannot disagree with what viz's validator will see for the same slice (G3). An empty slice (no
 * run yet) therefore makes every column-binding series unresolvable, while a series that binds no
 * column (e.g. an `image` underlay) is always resolvable.
 */
export function unresolvableBinding(series: VizSeries, obs: ObsColumns): string | null {
  for (const { id, kind } of seriesBoundColumns(series)) {
    const col = obs[id]
    // ITEM-20 — this guard decides whether a series is DROPPED. Under `Array.isArray` a typed
    // column made EVERY column-binding series unresolvable, so the canvas fell back to its empty
    // hero: a blank surface with no error, which is the fail-open shape this migration is most
    // likely to ship.
    if (!isColumn(col) || columnKind(col as readonly unknown[]) !== kind) return id
  }
  return null
}

// ── $ref + for_each resolution (ITEM-3/8) ───────────────────────────────────────
// A canvas declaration is a `VizOption` whose `series`/`datasets` may carry a `for_each` clause and
// whose leaf VALUES may be `$state`/`$derived` refs. `resolveCanvasOption` expands the templates per
// selected dataset and resolves the refs, yielding a concrete strict-JSON `VizOption` for `setOption`.

/** A per-cell CLOSE binding (Slice 4, ITEM-17 / DEC-8 controlled cell-close): when a `controlled`
 *  cell's X is clicked, the app routes `cell-close(coordId)` to this declared action (never a raw
 *  `removePane`), which mutates the state the cell derives from — the reopen-loop guard (DEC-7).
 *  `args` are `$`-refs resolved against the (`for_each`-bound) iteration scope, so a per-criterion
 *  cell closes the RIGHT criterion (`args: { index: $i }`). */
export interface CanvasCloseBinding {
  action: string
  args?: Record<string, string>
}

/** A `series` entry that may carry a `for_each` clause (multi-dataset expansion), a `when`
 *  visibility gate (a plot appears only when its predicate holds — e.g. a criterion whose column
 *  is picked / a standalone plot the user toggled on), and an app-only `controlled`/`close`
 *  cell-close binding (all four stripped from the viz wire option). */
export type CanvasSeriesTemplate = VizSeries & {
  for_each?: string
  when?: string
  controlled?: boolean
  close?: CanvasCloseBinding
  /** WHERE this plot sits, declared on the plot itself rather than in a parallel `grid` list
   *  (see {@link placeSeries}). App-only: lifted into a `VizGridEntry` and stripped before the
   *  wire option. `col` may be omitted — the feed fills it from the plot's position within its
   *  own row, which is what lets a `for_each` place an unbounded number of plots. */
  region?: VizRegion
}
/** A `datasets` entry that may carry a `for_each` clause and the app-level `coords` binding. */
export type CanvasDatasetTemplate = VizDataset & { for_each?: string; coords?: CanvasCoordsBinding }

/**
 * `coords` — THE ONE NEW CANVAS KEY (visualize-pane ITEM-29, design §7.1).
 *
 * It says WHICH ARTIFACT supplies a dataset base's x/y positions, as a `$`-ref the view
 * resolves in its own scope (`{ artifact: "$scope.coordinate" }`, `{ artifact: "$e" }` inside
 * a `for_each`). It is an APP field, not a viz field: `resolveCanvasOption` strips it, so it
 * never reaches `parseOption`, exactly as `mask` does.
 *
 * ── Why a key and not an effect op ──────────────────────────────────────────────────────
 *
 * `EFFECT_OPS` stays closed (ITEM-29). The canvas is a PROJECTION — a view republishes its
 * whole block on every change — so "attach these coordinates" as an op would be a mutation of
 * something that is re-derived, i.e. the shape the reopen-loop guard exists to prevent. A
 * declared key on the dataset is re-derived with everything else.
 *
 * ── What it replaces ────────────────────────────────────────────────────────────────────
 *
 * `CanvasBindingDeps.positionsFor(base)` was ALREADY keyed on the dataset base; what fed it
 * was `cat.layouts[0]` — the project's first plottable-xy artifact, handed to every base. That
 * is the degenerate `[0]` the design names, and a declared `coords` is what lets a canvas say
 * which coordinates it means instead of being told. A block that declares NO `coords` is
 * untouched and still gets the legacy project-wide fallback; see `canvasHostProvider`.
 */
export interface CanvasCoordsBinding {
  /** a `$`-ref (or a literal id) naming the artifact whose positions this base is drawn in. */
  artifact: string
}

/**
 * `{ datasetId → artifact id }` for every dataset entry that DECLARES `coords`, expanded and
 * resolved against `scope`.
 *
 * A sibling of {@link resolveCanvasOption} rather than a second return value, so its signature
 * is untouched — but it MUST expand identically, because a base named here that the option
 * does not carry (or vice versa) would silently hand one base another's coordinates. Both use
 * the same `expandTemplates` over the same array in the same scope, so the ids agree by
 * construction, and `canvasBinding.test.ts` asserts that agreement rather than assuming it.
 *
 * A `coords` whose ref resolves to nothing yields NO entry — unset propagates as absence
 * (INV-4), so the base falls back to whatever the host supplies rather than to a guess.
 */
export function resolveCanvasCoords(template: CanvasTemplate, scope: Scope): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { spec, scope: s } of expandTemplates(template.datasets, scope)) {
    const declared = (spec as CanvasDatasetTemplate).coords
    if (!declared || typeof declared.artifact !== 'string') continue
    const id = resolveRefsDeep(declared.artifact, s)
    const dataset = resolveRefsDeep(spec.id, s)
    if (typeof id === 'string' && id !== '' && typeof dataset === 'string' && dataset !== '') {
      out[dataset] = id
    }
  }
  return out
}

/** A canvas declaration: a `VizOption` whose `series`/`datasets` may be `for_each` templates,
 *  plus the app-level `mask` binding (stripped before the option reaches viz). */
export interface CanvasTemplate extends Omit<VizOption, 'series' | 'datasets'> {
  readonly series: readonly CanvasSeriesTemplate[]
  readonly datasets?: readonly CanvasDatasetTemplate[]
  /** C8 — the DECLARED keep-mask for the `.kept` dataset variants: an expression over the
   *  view's own `$state`/`$derived` resolving to a boolean array parallel to the base slice
   *  (e.g. `"$derived.keptMask"`). Absent ⇒ no mask. This is an APP field, not a viz field:
   *  `resolveCanvasOption` strips it so it never reaches `parseOption`. Before it existed,
   *  core read `$derived.keptMask` by that literal name. */
  readonly mask?: string
}

/** Deep-resolve every `$`-ref string leaf against `scope`. A PURE `$`-ref (`$c.column`) resolves
 *  via `evalExpr` (TYPE-preserving — a numeric filter bound stays a number). A MIXED text+ref leaf
 *  (`"before-$i"` — a `for_each` coordId/id) is INTERPOLATED to a string (safe: `interpolate` only
 *  substitutes well-formed ref tokens, never evals arbitrary code — the same trust boundary). Plain
 *  strings + scalars pass through; arrays/objects recurse. */
function resolveRefsDeep(node: unknown, scope: Scope): unknown {
  if (typeof node === 'string') {
    if (isRef(node)) return evalExpr(node, scope)
    if (node.includes('$')) return interpolate(node, scope)
    return node
  }
  if (Array.isArray(node)) return node.map(v => resolveRefsDeep(v, scope))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveRefsDeep(v, scope)
    return out
  }
  return node
}

/** The `encode` keys that NAME A DATASET COLUMN, and for which `''` is viz's own in-band spelling
 *  of "no column": `validateBindings` skips an empty binding, `seriesBoundColumns` skips it,
 *  `resolveBinding`'s `value` fallback PRODUCES it, and the frame-backed source's `categorical('')`
 *  returns one group over every row. Every other `encode` key (`layout`, `colorBy`, `table`, …) names
 *  something that has no meaningful empty form, so an empty one is still dropped. */
const UNSETTABLE_COLUMN_ENCODE_KEYS: ReadonlySet<string> = new Set([
  'groupKey',
  'valueKey',
  'continuousKey',
])

/** True for a `colorBy` that names no column to colour BY — a `{ mode, key }` object whose `key`
 *  resolved empty (an unset group-by), or a shape carrying no usable key at all. Blend carries its
 *  key as `categoryKey`, so it is judged on that. */
function isKeylessColorBy(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const cb = v as { mode?: unknown; key?: unknown; categoryKey?: unknown }
  if (cb.mode === 'blend') return typeof cb.categoryKey !== 'string' || cb.categoryKey === ''
  return typeof cb.key !== 'string' || cb.key === ''
}

/**
 * Normalize an `encode` whose refs resolved to nothing (Slice 4).
 *
 * A column channel that resolved EMPTY — `groupKey: "$state.groupBy"` with no group-by chosen —
 * is preserved as `''`, which is viz's "bind no column". It used to be DELETED, and that was the
 * bug behind "the violin shows many groups before I choose anything": an absent channel is how a
 * series says *I never mentioned this*, so `resolveBinding` filled it from the catalog and the
 * chart grouped by whichever categorical column happened to be first. Explicitly-unset and
 * never-mentioned were the same wire shape, so the honest answer — one distribution over every
 * row — was not expressible at all.
 *
 * `undefined` still drops, and so does a `null` on a key that names no column: those mean the
 * key was not authored, not that it was cleared. A non-column key that resolved empty also still
 * drops (see the key set above).
 *
 * ITEM-28 / INV-2 — a COLUMN key that resolved to `null` is normalized to `''` rather than
 * dropped, and that is not a widening, it is the same rule stated in the vocabulary R1 settled
 * on. `null` is now the ONLY unset a closed-set control's state may hold (`parseViewSpec`
 * refuses `""` as such a default), so `groupKey: "$state.groupBy"` with nothing chosen resolves
 * to `null` where it used to resolve to `""` — the identical proposition, "the author named this
 * channel and it is currently unbound". Dropping it would restore, verbatim, the bug the note
 * above records: an ABSENT channel is how a series says *I never mentioned this*, `resolveBinding`
 * then fills it from the catalog, and the violins group by whichever categorical column happens
 * to be first. The distinction that matters is authored-vs-not, and an authored `$`-ref
 * resolving to null was never "not authored".
 */
function stripEmptyEncode(series: VizSeries): VizSeries {
  const enc = (series as { encode?: Record<string, unknown> }).encode
  if (!enc || typeof enc !== 'object') return series
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(enc)) {
    if (v === null && UNSETTABLE_COLUMN_ENCODE_KEYS.has(k)) {
      cleaned[k] = ''
      continue
    }
    if (v === undefined || v === null) continue
    if (v === '' && !UNSETTABLE_COLUMN_ENCODE_KEYS.has(k)) continue
    // `colorBy` is not a binding channel — it has no catalog default to fall back to, so ABSENT
    // already means "colour by nothing". Its key, however, is nested (`{ mode, key }`), so an
    // unset ref leaves `key: ''` where the empty-value check above cannot see it. Drop the whole
    // channel in that case: viz now REFUSES a key-less colorBy at parse (a bare column name used
    // to resolve to a silent no-op), so passing one through would blank the canvas instead.
    if (k === 'colorBy' && isKeylessColorBy(v)) continue
    cleaned[k] = v
  }
  return { ...series, encode: cleaned }
}

/** Strip the app-only `for_each`/`when`/`close` fields off a resolved series before it reaches the
 *  viz wire option (viz understands `controlled`; it does NOT understand `for_each`/`when`/`close`). */
function stripAppSeriesFields(series: VizSeries): VizSeries {
  const {
    for_each: _f,
    when: _w,
    close: _c,
    ...wire
  } = series as VizSeries & { for_each?: string; when?: string; close?: unknown }
  return wire as VizSeries
}

/** Expand a `for_each`-bearing template array into concrete `{ spec, scope }` entries (the loop var
 *  bound per iteration), reusing `expr.ts` `expandForEach`. An entry with no `for_each` yields
 *  itself once. Refs are NOT resolved here — the caller resolves each against its iteration scope. */
function expandTemplates<T extends { for_each?: string; when?: string }>(
  items: readonly T[] | undefined,
  scope: Scope,
): Array<{ spec: T; scope: Scope }> {
  const out: Array<{ spec: T; scope: Scope }> = []
  for (const item of items ?? []) {
    for (const e of expandForEach(item, scope)) {
      // A `when` gate on a canvas template (Slice 4): drop the expansion whose predicate is false
      // (an empty-column criterion → no plot; a toggled-off standalone plot → absent). Evaluated
      // per-iteration against the loop-bound scope; `when` never reaches the viz wire option.
      if (!evalWhen((e.spec as { when?: string }).when, e.scope)) continue
      out.push({ spec: e.spec, scope: e.scope })
    }
  }
  return out
}

/**
 * Resolve a canvas `VizOption` declaration into a concrete strict-JSON `VizOption` (ITEM-3/8):
 * expand the `datasets`/`series` `for_each` templates over the selected set, then resolve every
 * `$state`/`$derived` ref in the resulting values. Re-run on form-state change to re-patch the live
 * link (the resolved output feeds `VizController.setOption`, whose default MERGE cheaply patches).
 */
export function resolveCanvasOption(template: CanvasTemplate, scope: Scope): VizOption {
  const datasets = expandTemplates(template.datasets, scope).map(({ spec, scope: s }) => {
    // `coords` is an APP binding (ITEM-29), resolved separately by `resolveCanvasCoords` and
    // stripped here for the same reason `mask` is: viz reads a dataset's `id`/`rev` and the
    // wire option should not carry a key it has no meaning for.
    const { coords: _c, ...rest } = resolveRefsDeep(spec, s) as VizDataset & { coords?: unknown }
    return rest as VizDataset
  })
  const series = expandTemplates(template.series, scope).map(({ spec, scope: s }) =>
    stripAppSeriesFields(stripEmptyEncode(resolveRefsDeep(spec, s) as VizSeries)),
  )
  // Resolve refs in the rest of the option (grid / dataset / filters / selection / …) against the
  // base scope; `series`/`datasets` were expanded+resolved above. `mask` is an APP binding
  // (resolved by `canvasFeed`), not part of the viz option — strip it here so `parseOption`
  // never sees a field it does not know.
  const { series: _s, datasets: _d, mask: _m, ...rest } = template
  const resolvedRest = resolveRefsDeep(rest, scope) as Omit<VizOption, 'series' | 'datasets'>
  return {
    ...resolvedRest,
    ...(datasets.length > 0 ? { datasets } : {}),
    series,
  }
}

// ── declared placement: a plot says which ROW it belongs to ─────────────────────
//
// With no `grid`, viz auto-derives one entry per distinct series `coordId` and places them all in
// ROW 0 — a single row of N panes, each 1/N of the canvas. For a canvas of independent plots that
// is fine. For a canvas of PAIRS it is not: two plots meant to be compared end up side by side
// only while nothing separates them, and reading order is whatever order the templates happened to
// expand in. A declaration that repeats plots with `for_each` cannot fix that by writing a `grid`
// either — a static list cannot enumerate an unbounded, user-built set.
//
// So placement is declared ON the plot (`region`), and the grid is DERIVED from the plots that
// actually survived: the row is the declaration's, and the column is the plot's position within
// its own row. Two `for_each` templates that declare the same row therefore stay column-aligned
// with each other however many iterations each produces, and however the families interleave.

/**
 * Lift each series' declared `region` into a `VizGridEntry`, returning the derived grid and the
 * series with the app-only field stripped. A `region` with no `col` gets the running position
 * within its row.
 *
 * Returns an EMPTY grid when no series declares a `region` — the canvas then keeps viz's
 * auto-derived one-row placement, byte-identical to before.
 */
export function placeSeries(series: readonly VizSeries[]): {
  grid: VizGridEntry[]
  series: VizSeries[]
} {
  const declares = series.some(s => (s as CanvasSeriesTemplate).region != null)
  const stripped = series.map(s => {
    const { region: _r, ...wire } = s as CanvasSeriesTemplate
    return wire as VizSeries
  })
  if (!declares) return { grid: [], series: stripped }
  const grid: VizGridEntry[] = []
  const placed = new Set<string>()
  const nextCol = new Map<number, number>()
  for (const s of series) {
    const coordId = s.coordId
    // A `coordId` several series share is ONE pane (an overlay); it is placed once, by the first.
    if (typeof coordId !== 'string' || coordId === '' || placed.has(coordId)) continue
    placed.add(coordId)
    const declared = (s as CanvasSeriesTemplate).region
    const row = typeof declared?.row === 'number' ? declared.row : 0
    const auto = nextCol.get(row) ?? 0
    const col = typeof declared?.col === 'number' ? declared.col : auto
    nextCol.set(row, Math.max(auto, col) + 1)
    grid.push({ id: coordId, region: { row, col } })
  }
  return { grid, series: stripped }
}

// ── drive the single canvas via ONE VizController (ITEM-4) ──────────────────────

/**
 * Drive the SINGLE canvas `GridWorkspace` from a resolved canvas option via ONE
 * `VizController.setOption` (clean replace) — the analysis-active path. The controller's
 * `resolveDataset` is a {@link createDatasetResolver} `DatasetResolver`, so the option's logical
 * dataset ids resolve to their isolated sources. Returns once the plan is applied.
 */
export async function driveCanvas(controller: VizController, option: VizOption): Promise<void> {
  await controller.setOption(option, { replace: true })
}

/**
 * Tear the canvas down when the analysis closes (ITEM-4) — remove every cell the declaration
 * placed (DEC-4: explicit removal, never by omission), then RELEASE what the controller held (G2).
 *
 * Both halves are needed and neither implies the other. `removePane` clears the shared grid so the
 * surface stops showing panes nobody drives any more, and touches no dataset ref-count. `dispose`
 * gives back the `DatasetStore` references `applyOption` took — the resolved source, catalog,
 * per-layout positions and colour buffer behind each declared slice. Without it those entries stay
 * pinned for the life of the page: the controller's only OTHER release site is `applyOption`'s
 * previous-ids sweep, which runs on the NEXT `setOption`, and every caller of this function nulls
 * its reference immediately after, so that next `setOption` never comes.
 *
 * THIS IS THE WHOLE-CANVAS EVENT, NOT THE PER-VIEW ONE. Retiring one contributing view is a
 * different thing: the feed recomposes and the SHARED controller is re-driven with the smaller
 * option, which acquires the surviving views' slices before releasing the previous set — so the
 * closed view's dataset drops out and everyone else's is carried through under the same identity.
 * Disposing there would take the canvas down while other panes are still plotting on it. This
 * function is reached only when the controller itself is being abandoned: the feed went inactive
 * (its last contribution retired), an explicit-prop controller was replaced, or the view unmounted.
 *
 * `dispose` RELEASES rather than evicts, so a slice a second live controller still holds is left
 * standing, and it is idempotent, so a double teardown cannot steal that holder's reference.
 */
export function teardownCanvas(controller: VizController): void {
  for (const g of controller.getOption().grid ?? []) {
    controller.dispatch({ type: 'removePane', id: g.id })
  }
  controller.dispose()
}

// ── controlled cell-close resolution (Slice 4, ITEM-17 / DEC-7/DEC-8) ────────────
/** A resolved close action for one canvas cell — the declared action id + its resolved params. */
export interface ResolvedCloseAction {
  action: string
  params: Record<string, unknown>
}

/**
 * Resolve a canvas template's per-series `close` bindings into a `{ coordId → {action, params} }`
 * map, keyed by the RESOLVED cell coordId (Slice 4). Expanding each `for_each` series against
 * `scope` yields one entry per iteration whose `close.args` `$`-refs resolve against that
 * iteration's scope — so a criterion's before/after cells map to a close action that removes the
 * RIGHT criterion (`args: { index: $i }`). Series without a `close` binding contribute nothing.
 * The app routes a controlled pane's `cell-close(coordId)` event through this map to the declared state
 * mutation (never a raw `removePane` — the reopen-loop guard, DEC-7).
 */
export function resolveCanvasCloseActions(
  template: CanvasTemplate,
  scope: Scope,
): Record<string, ResolvedCloseAction> {
  const out: Record<string, ResolvedCloseAction> = {}
  for (const { spec, scope: s } of expandTemplates(template.series, scope)) {
    const close = (spec as CanvasSeriesTemplate).close
    if (!close || typeof close.action !== 'string' || close.action.length === 0) continue
    const coordId = resolveRefsDeep((spec as VizSeries).coordId, s)
    if (typeof coordId !== 'string' || coordId.length === 0) continue
    const params: Record<string, unknown> = {}
    for (const [k, expr] of Object.entries(close.args ?? {})) params[k] = evalExpr(expr, s)
    out[coordId] = { action: close.action, params }
  }
  return out
}
