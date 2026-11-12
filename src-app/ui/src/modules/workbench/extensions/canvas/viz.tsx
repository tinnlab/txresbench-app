// Viz widget RENDERERS (PLAN.md ITEM-8) — the `scatter` / `violin` kinds, wrapping
// `@txresbench/viz`'s `<Viz option source>` (replacing the wave-2 throwing stubs). A viz
// widget is pure config-over-`<Viz>`: it builds a strict-JSON `VizOption` from its
// `encode` bindings + reads its columnar frame off the render scope, then wires
// the viz's interaction callbacks back through `ctx.dispatch` to the declared gate /
// range actions (view_id injected by the host). It never ships a plot compiler or a JS
// closure (research §11 boundary): the plot logic lives entirely in `@txresbench/viz`.
//
// DEC-1 (no per-point mask): the dense scatter renders the per-metric thresholds as
// value-range `filters` (sliders) + the brushed gate as a selection-dim; the violins /
// before-after / kept-counts render the EXACT client mask by feeding the "after" violin a
// pre-filtered frame. `buildScatterOption` / `buildViolinOption` and their source
// builders `buildScatterSource` / `buildViolinSource` are exported PURE so TEST-8 asserts
// the `VizOption` + source shape without a DOM.

import * as React from 'react'
import { Viz, toSpaceFromLevelAffine, type VizOption, type DataSource } from '@txresbench/viz'
import type {
  ScatterWidget,
  ViolinWidget,
  BarWidget,
  HistogramWidget,
  ImageWidget,
  WidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'

// The wire column types are the DataSource methods' resolved return types (the index
// re-exports only `DataSource` itself, not each column shape). Deriving them here keeps
// the widget DataSource structurally faithful without a subpath import.
type Positions = Awaited<ReturnType<DataSource['positions']>>
type SparseColumn = Awaited<ReturnType<DataSource['valueColumn']>>
type CategoricalColumn = Awaited<ReturnType<DataSource['categorical']>>
type ContinuousColumn = Awaited<ReturnType<DataSource['continuous']>>
type DatasetCatalog = Awaited<ReturnType<DataSource['catalog']>>
type DataTable = Awaited<ReturnType<DataSource['table']>>
type GraphData = Awaited<ReturnType<DataSource['graph']>>
type ImageUnderlay = Awaited<ReturnType<DataSource['imageUnderlay']>>
import { evalExpr, type Scope } from '@/modules/workbench/core/runtime/expr'
import { asNumsZeroMissing, asStrs } from '@/modules/workbench/core'
import type { WidgetRenderContext, WidgetRenderer } from '@/modules/workbench/core/render/registry'


const testid = (spec: WidgetSpec, fallback: string): string =>
  `widget-${(spec as { id?: string }).id ?? fallback}`

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
// ITEM-25 — one shared coercer; the LOOSE (0-for-missing) semantics this file always had.
const asNums = asNumsZeroMissing

/** Resolve a channel binding to a COLUMN NAME. `encode.x`/`.y`/`.colorBy` are either a
 *  plain column-name literal (`nCount`) or a `$`-ref resolving to one. */
function col(binding: unknown, scope: Scope): string | undefined {
  if (binding == null) return undefined
  const v = evalExpr(binding, scope)
  return v == null ? undefined : String(v)
}

/**
 * The INTERNAL logical dataset id a single-widget `VizOption` uses.
 *
 * A widget renderer hands `<Viz>` BOTH the option and the `DataSource` it built, so this id only
 * has to agree with that source's own `catalog().datasetId` — it names nothing in the view_spec and
 * resolves against no `$data` slice. r3canvas: it used to be the literal `'obs'` written out at
 * five sites, which read as core privileging a slice name. It is one neutral constant now, so the
 * self-consistency is visible and there is no domain word to mistake for a binding.
 */
const WIDGET_DATASET_ID = 'widget'

/**
 * The columnar frame a viz widget reads: its declared `frame:` binding (DUAL-ACCEPTING the
 * pre-r3canvas spelling `obs:`), or — when the widget declares NEITHER — the view's FIRST declared
 * `$data` slice.
 *
 * r3canvas: the fallback used to be the literal `evalExpr('$data.obs', scope)`, repeated at eight
 * sites. That made `obs` a slice name CORE knew: a view whose slice was called anything else got an
 * empty frame from an undeclared widget, silently. "The view's first declared slice" is the same
 * convenience with no name baked in — and a widget that wants a specific slice says so via `frame:`.
 */
function widgetFrame(w: { frame?: unknown; obs?: unknown }, scope: Scope): Record<string, unknown> {
  const binding = w.frame ?? w.obs
  if (binding != null) return asRecord(evalExpr(binding, scope))
  const data = asRecord(scope.data)
  const first = Object.keys(data)[0]
  return first === undefined ? {} : asRecord(data[first])
}

// ── the frame-backed DataSource ───────────────────────────────────────────────
// A `DataSource` over the resolved columnar frame: the metric layout is the
// interleaved (x, y) metric pair; continuous channels are the numeric metric columns;
// the sample/ident column is the categorical. `hidden` (a per-point mask) drops the
// hidden points so the "after" violin plots only the kept cells (client mask, DEC-1).

export interface FrameSourceOptions {
  /** the frame columns: `{ column: number[] | string[] }`.
   *
   *  Named after the STRUCTURE, not after one axis. This option carried an axis name, which made
   *  a domain word part of the app's own API for a thing that is just columns; `widgetFrame`
   *  above already resolves the neutral binding first for the same reason. Renamed rather than
   *  aliased — an alias keeps the old spelling alive at the one place every caller must type. */
  frame: Record<string, unknown>
  /** the metric layout's x column (e.g. `nCount`). */
  layoutX?: string
  /** the metric layout's y column (e.g. `nFeature`). */
  layoutY?: string
  /** the categorical grouping column (sample/ident). */
  groupKey?: string
  /** the continuous value column (violin y). */
  valueKey?: string
  /** the color-by continuous column (scatter, e.g. `pct_mito`). */
  colorKey?: string
  /** per-point HIDDEN mask; hidden points are excluded (the "after" client mask). */
  hidden?: boolean[]
  /** dataset id surfaced in the catalog. */
  datasetId?: string
}

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

/** Apply a hidden mask, keeping only unhidden entries (parallel arrays). */
function keepUnhidden<T>(xs: T[], hidden: boolean[] | undefined): T[] {
  if (!hidden) return xs
  return xs.filter((_, i) => !hidden[i])
}

/**
 * A `DataSource` (the `@txresbench/viz` wire contract) synthesized from a columnar frame
 * — so a declarative scatter/violin renders REAL rows with no backend. Pure /
 * framework-free (runs in a node test): TEST-8 builds one and reads `positions()`.
 */
export class FrameDataSource implements DataSource {
  private readonly frame: Record<string, number[] | string[]>
  private readonly opts: FrameSourceOptions
  private readonly n: number
  /** Numeric / string column ids, read off the UNMASKED frame — for the same reason
   *  the sibling canvas source keeps its own: `hidden` is a row filter, and a frame whose "after" mask
   *  hides every row still has the columns it had. Classifying after the mask made the schema a
   *  function of the survivors (`typeof col[0]` on an empty array is `'undefined'`), so hiding
   *  everything erased every column and viz rejected the option. */
  private readonly numericIds: string[]
  private readonly stringIds: string[]

  constructor(opts: FrameSourceOptions) {
    this.opts = opts
    const frame: Record<string, number[] | string[]> = {}
    let n = 0
    for (const [k, v] of Object.entries(opts.frame ?? {})) {
      if (Array.isArray(v)) {
        frame[k] = v as number[] | string[]
        n = Math.max(n, v.length)
      }
    }
    this.numericIds = Object.keys(frame).filter(k => typeof (frame[k] as unknown[])[0] === 'number')
    this.stringIds = Object.keys(frame).filter(k => typeof (frame[k] as unknown[])[0] === 'string')
    // Apply the client "after" mask up front so every channel is the kept subset.
    if (opts.hidden) {
      for (const k of Object.keys(frame)) frame[k] = keepUnhidden(frame[k] as unknown[], opts.hidden) as never
      n = keepUnhidden(new Array(n).fill(0), opts.hidden).length
    }
    this.frame = frame
    this.n = n
  }

  async catalog(): Promise<DatasetCatalog> {
    const continuousColumns = this.numericIds.map(id => ({ id, kind: 'continuous' as const, label: id }))
    const categoricalColumns = this.stringIds.map(id => ({ id, kind: 'categorical' as const, label: id }))
    return {
      datasetId: this.opts.datasetId ?? WIDGET_DATASET_ID,
      pointCount: this.n,
      layouts: [{ id: 'metric', kind: 'layout', label: 'Metric space' }],
      // A numeric column serves BOTH a violin/box `value` channel and a scatter/histogram
      // `continuous` one, so it is listed on both — the same rule the sibling canvas source publishes.
      // This was hardcoded `[]` while `buildViolinOption` binds an explicit `valueKey`, so EVERY
      // violin widget threw `encode binds "…" which is not a value column` at parse and the
      // registered `violin`/`box` widgets could never render.
      valueColumns: [...this.numericIds],
      categoricalColumns,
      continuousColumns,
      hasImage: false,
    }
  }

  async positions(_layoutId: string): Promise<Positions> {
    const x = asNums(this.frame[this.opts.layoutX ?? ''] ?? [])
    const y = asNums(this.frame[this.opts.layoutY ?? ''] ?? [])
    const positions = new Float32Array(this.n * 2)
    for (let i = 0; i < this.n; i++) {
      positions[i * 2] = x[i] ?? 0
      positions[i * 2 + 1] = y[i] ?? 0
    }
    return { positions, length: this.n }
  }

  async valueColumn(key: string): Promise<SparseColumn> {
    // No sparse feature columns in a frame slice; project the dense continuous column.
    const dense = asNums(this.frame[key] ?? [])
    const row = new Uint32Array(dense.length)
    for (let i = 0; i < dense.length; i++) row[i] = i
    return { row, value: Float32Array.from(dense), length: this.n }
  }

  async categorical(key: string): Promise<CategoricalColumn> {
    const { codes, categories } = encodeCategorical(asStrs(this.frame[key] ?? []))
    return { codes, categories, length: codes.length }
  }

  async continuous(key: string): Promise<ContinuousColumn> {
    const value = Float32Array.from(asNums(this.frame[key] ?? []))
    return { value, length: value.length }
  }

  async imageUnderlay(): Promise<ImageUnderlay> {
    throw new Error('FrameDataSource has no image underlay')
  }

  async table(_name?: string): Promise<DataTable> {
    return { rowLabels: [], columns: {} }
  }

  async graph(_id?: string): Promise<GraphData> {
    return { nodeKey: '', paths: [] }
  }
}

// ── option builders (pure, exported for TEST-8) ────────────────────────────────

/** Build the metric-scatter `VizOption` from a `scatter` widget's `encode` (x×y layout,
 *  colorBy continuous) + its threshold `filters` + brushed `selection` gate. */
export function buildScatterOption(w: ScatterWidget, scope: Scope): VizOption {
  const colorKey = col(w.encode?.colorBy, scope)
  // per-metric thresholds → value-range `filters` (DEC-1). Keyed by metric column.
  const ranges = asRecord(w.filters != null ? evalExpr(w.filters, scope) : undefined)
  const filters: Record<string, readonly [number, number]> = {}
  for (const [metric, range] of Object.entries(ranges)) {
    if (Array.isArray(range) && range.length === 2) {
      filters[metric] = [Number(range[0]), Number(range[1])]
    }
  }
  // brushed gate → selection-dim (canonical ids).
  const gateIds = w.selection != null ? asNums(evalExpr(w.selection, scope)) : []

  const option: VizOption = {
    dataset: { id: WIDGET_DATASET_ID },
    grid: [{ id: 'metric', region: { row: 0, col: 0 } }],
    selection: { mode: 'lasso', link: ['scatter'], ids: gateIds },
    series: [
      {
        id: 'scatter',
        type: 'scatter',
        coordId: 'metric',
        encode: {
          layout: 'metric',
          ...(colorKey ? { colorBy: { mode: 'continuous', key: colorKey } } : {}),
        },
        emphasis: { consumesSelection: true },
        select: { produces: true },
      },
    ],
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  }
  return option
}

/** Build a violin `VizOption` from a `violin` widget's `encode` (groupKey + valueKey). */
export function buildViolinOption(w: ViolinWidget, scope: Scope): VizOption {
  const groupKey = col(w.encode?.groupBy ?? w.encode?.groupKey ?? w.groups, scope)
  const valueKey = col(w.encode?.y ?? w.encode?.valueKey ?? w.points, scope)
  const option: VizOption = {
    dataset: { id: WIDGET_DATASET_ID },
    grid: [{ id: 'violin', region: { row: 0, col: 0 } }],
    series: [
      {
        id: 'violin',
        type: 'violin',
        coordId: 'violin',
        encode: {
          ...(groupKey ? { groupKey } : {}),
          ...(valueKey ? { valueKey } : {}),
        },
        emphasis: { consumesSelection: true },
      },
    ],
  }
  return option
}

/** Build the frame DataSource a `scatter` widget's `<Viz>` reads. */
export function buildScatterSource(w: ScatterWidget, scope: Scope): FrameDataSource {
  const frame = widgetFrame(w, scope)
  return new FrameDataSource({
    frame,
    layoutX: col(w.encode?.x, scope),
    layoutY: col(w.encode?.y, scope),
    colorKey: col(w.encode?.colorBy, scope),
    groupKey: col(w.encode?.groupBy ?? w.groups, scope),
  })
}

/** Build the frame DataSource a `violin` widget's `<Viz>` reads, honoring `hidden`
 *  (the "after" client mask, DEC-1). */
export function buildViolinSource(w: ViolinWidget, scope: Scope): FrameDataSource {
  const frame = widgetFrame(w, scope)
  const hidden = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  return new FrameDataSource({
    frame,
    groupKey: col(w.encode?.groupBy ?? w.encode?.groupKey ?? w.groups, scope),
    valueKey: col(w.encode?.y ?? w.encode?.valueKey ?? w.points, scope),
    hidden: Array.isArray(hidden) ? hidden : undefined,
  })
}

// ── renderers ──────────────────────────────────────────────────────────────────
//
// The renderers are thin config functions that mount a small React component so the
// `FrameDataSource` can be MEMOIZED (`useMemo`). `<Viz>` keys its data pull on `source`
// IDENTITY, so a fresh source on every store revision (a slider drag / gate / select)
// would blank the chart and re-pull + re-upload the whole dataset. Memoizing on the
// STABLE frame reference (+ the static encode column names) means only a real
// data arrival (`setData` replaces the slice) rebuilds the source; a threshold drag only
// changes `option.filters` (already diff-gated inside `<Viz>`), never the source.
//
// CAVEAT (ViolinViz `hidden`): a source input bound to a `$derived` value (the AFTER violin's
// `hidden` = `$derived.keptMask`) is NOT stable — `store.ts` recomputes `derived` WHOLESALE on
// every `set`, so `hidden` gets a fresh array identity each revision and its memo rebuilds per
// mutation (not only on a real mask change). That rebuild is the INTENDED reshape while dragging,
// but it also fires on unrelated sets; making `derived` content-stable (so an unchanged entry keeps
// its reference) is the deeper fix and is deferred — the memo above only stabilizes `$data`-backed
// inputs (scatter), which is why the scatter source stays put across a live drag.

function ScatterViz({ w, ctx }: { w: ScatterWidget; ctx: WidgetRenderContext }): React.ReactElement {
  const { scope } = ctx
  const option = buildScatterOption(w, scope)
  const frame = widgetFrame(w, scope)
  const layoutX = col(w.encode?.x, scope)
  const layoutY = col(w.encode?.y, scope)
  const colorKey = col(w.encode?.colorBy, scope)
  const groupKey = col(w.encode?.groupBy ?? w.groups, scope)
  const source = React.useMemo(
    () => new FrameDataSource({ frame, layoutX, layoutY, colorKey, groupKey }),
    [frame, layoutX, layoutY, colorKey, groupKey],
  )
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid={testid(w, 'scatter')}>
      <Viz
        option={option}
        source={source}
        onSelect={ids => ctx.dispatch(w.onSelect, { ids: Array.from(ids) })}
        // A filter-cleared event forwards `range: null` (the "clear this metric's filter"
        // signal) verbatim so the declared action can distinguish clear from a new range.
        onFilter={(id, range) => ctx.dispatch(w.onFilter, { metric: id, range: range ?? null })}
      />
    </div>
  )
}

function ViolinViz({ w, ctx }: { w: ViolinWidget; ctx: WidgetRenderContext }): React.ReactElement {
  const { scope } = ctx
  const option = buildViolinOption(w, scope)
  const frame = widgetFrame(w, scope)
  const groupKey = col(w.encode?.groupBy ?? w.encode?.groupKey ?? w.groups, scope)
  const valueKey = col(w.encode?.y ?? w.encode?.valueKey ?? w.points, scope)
  const hiddenRaw = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  const hidden = Array.isArray(hiddenRaw) ? hiddenRaw : undefined
  const source = React.useMemo(
    () => new FrameDataSource({ frame, groupKey, valueKey, hidden }),
    [frame, groupKey, valueKey, hidden],
  )
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid={testid(w, 'violin')}>
      {w.title ? <span className="absolute start-2 top-1 text-xs text-muted-foreground">{w.title}</span> : null}
      <Viz option={option} source={source} />
    </div>
  )
}

export const ScatterRenderer: WidgetRenderer = (spec, ctx: WidgetRenderContext) => (
  <ScatterViz w={spec as ScatterWidget} ctx={ctx} />
)

export const ViolinRenderer: WidgetRenderer = (spec, ctx: WidgetRenderContext) => (
  <ViolinViz w={spec as ViolinWidget} ctx={ctx} />
)

// ── bar / histogram / image (DEC-12 — GENERAL kinds lowering onto existing @txresbench/viz) ──────────
//
// Each is a THIN config-over-`<Viz>` renderer (INV-5: no second render path, no plot compiler).
// `bar` lowers onto the viz `bar` chart kind (a categorical GROUP channel → grouped counts),
// `histogram` onto `histogram` (a CONTINUOUS value channel → distribution), `image` onto the
// `image` view-kind + `imageUnderlay()` data source. The viz encode-key vocabulary is
// source-based (`overlayEncode`): a categorical channel reads `encode.groupKey`, a continuous
// channel reads `encode.continuousKey`.

/** Build a bar `VizOption` — a categorical GROUP channel (`encode.groupBy`/`.x`/`groups`). */
export function buildBarOption(w: BarWidget, scope: Scope): VizOption {
  const groupKey = col(w.encode?.groupBy ?? w.encode?.x ?? w.groups, scope)
  return {
    dataset: { id: WIDGET_DATASET_ID },
    grid: [{ id: 'bar', region: { row: 0, col: 0 } }],
    series: [
      {
        id: 'bar',
        type: 'bar',
        coordId: 'bar',
        encode: { ...(groupKey ? { groupKey } : {}) },
        emphasis: { consumesSelection: true },
      },
    ],
  }
}

/** Build a histogram `VizOption` — a CONTINUOUS value channel (`encode.x`/`.value`/`points`). */
export function buildHistogramOption(w: HistogramWidget, scope: Scope): VizOption {
  const valueKey = col(w.encode?.x ?? w.encode?.value ?? w.points, scope)
  return {
    dataset: { id: WIDGET_DATASET_ID },
    grid: [{ id: 'histogram', region: { row: 0, col: 0 } }],
    series: [
      {
        id: 'histogram',
        type: 'histogram',
        coordId: 'histogram',
        // histogram's value channel is CONTINUOUS → `encode.continuousKey` (overlayEncode).
        encode: { ...(valueKey ? { continuousKey: valueKey } : {}) },
      },
    ],
  }
}

/** Build an image-underlay `VizOption` — the dense `image` view-kind (world2d, no channels). */
export function buildImageOption(_w: ImageWidget, _scope: Scope): VizOption {
  return {
    dataset: { id: 'image' },
    grid: [{ id: 'image', region: { row: 0, col: 0 } }],
    series: [{ id: 'image', type: 'image', coordId: 'image' }],
  }
}

/** Build the frame DataSource a `bar` widget's `<Viz>` reads (honoring `hidden`). */
export function buildBarSource(w: BarWidget, scope: Scope): FrameDataSource {
  const frame = widgetFrame(w, scope)
  const hidden = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  return new FrameDataSource({
    frame,
    groupKey: col(w.encode?.groupBy ?? w.encode?.x ?? w.groups, scope),
    hidden: Array.isArray(hidden) ? hidden : undefined,
  })
}

/** Build the frame DataSource a `histogram` widget's `<Viz>` reads (honoring `hidden`). */
export function buildHistogramSource(w: HistogramWidget, scope: Scope): FrameDataSource {
  const frame = widgetFrame(w, scope)
  const hidden = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  return new FrameDataSource({
    frame,
    valueKey: col(w.encode?.x ?? w.encode?.value ?? w.points, scope),
    hidden: Array.isArray(hidden) ? hidden : undefined,
  })
}

/**
 * A `DataSource` serving ONLY an image underlay (+ optional point overlay) — the `image`
 * view-kind's data plane. The underlay payload (`$data.image`) is an `ImageUnderlay`-shaped
 * object (`{ data, width, height, channels, affine }`); optional `positions` (`$data.spatial`)
 * overlay points in the raster's pixel space. Pure / framework-free so the option + source can
 * be unit-tested without a DOM. Non-image reads throw (this source is image-only).
 */
/**
 * The coordinate space an `image` widget's raster and its `points` share (#228).
 *
 * A widget declares its frame by construction — `image.affine` is *"the affine mapping the point
 * positions into the underlay's shared coordinate space"* — so the space id exists only to say
 * "these two halves are the same declaration". The `$widget:` prefix keeps it out of the
 * namespace a real producer writes into (`coordinate_space` is a run's slide/library id).
 */
export const IMAGE_WIDGET_SPACE = '$widget:image'

export interface ImageSourceOptions {
  image: Partial<ImageUnderlay> | undefined
  positions?: number[] | Float32Array
  datasetId?: string
}

export class ImageDataSource implements DataSource {
  private readonly opts: ImageSourceOptions
  constructor(opts: ImageSourceOptions) {
    this.opts = opts
  }
  async catalog(): Promise<DatasetCatalog> {
    const img = this.opts.image
    // ── THE WIDGET'S OWN FRAME (#228) ──────────────────────────────────────────────────────
    //
    // `ImageWidget.points` has been in the spec vocabulary since DEC-12/INV-16 — *"an optional
    // spatial positions map overlaid on the raster"* — and the grid dropped it on the floor: the
    // dense `image` pane drew the raster and skipped past the point emit, so the positions
    // reached this source and went nowhere. #159's DEC-2 named that as a live gap.
    //
    // The binding the grid now honours is "the raster and the layout declare the SAME
    // `coordinate_space`", and this widget's frame is not read from an artifact — it is the
    // WIDGET AUTHOR's declaration, written in the spec as `image` + `points` and related by
    // `image.affine`. So it is stated once, here, and stated explicitly rather than left to a
    // special case in the grid: both halves of THIS source name one id.
    //
    // The id is local to this source and cannot collide with a real one. A pane only ever reads
    // the catalog of the dataset it is bound to, two `ImageDataSource`s are two datasets, and the
    // `$widget:` prefix is not a shape any producer emits (a real `coordinate_space` is a run's
    // slide/library id). It is NOT a wildcard: a layout with no positions still declares it, and
    // an image payload with no `affine` declares nothing at all, so an incomplete widget refuses
    // rather than overlaying on a guess.
    // PLACEABLE means the placement can actually be USED, not merely that a key is present.
    // `toSpaceFromLevelAffine` inverts the widget's affine and REFUSES a singular one, and a
    // refusal escaping `catalog()` would take the whole dataset down — for a widget payload that
    // could not throw at all before this item. So it is caught here and the widget declares NO
    // frame, which is the honest answer: an affine that collapses the raster onto a line states
    // no relationship between the points and the picture.
    let toSpace: readonly number[] | undefined
    if (img?.width && img?.height && img?.affine) {
      try {
        toSpace = toSpaceFromLevelAffine(
          img.affine as readonly [number, number, number, number, number, number],
        )
      } catch (e) {
        console.warn(
          '[canvas] the image widget declares an affine that cannot be inverted; its points will ' +
            'not be overlaid on its raster (a refusal, not a fabricated placement)',
          e,
        )
      }
    }
    const placeable = toSpace !== undefined
    const space = placeable ? IMAGE_WIDGET_SPACE : undefined
    return {
      datasetId: this.opts.datasetId ?? 'image',
      pointCount: this.opts.positions ? Math.floor((this.opts.positions as ArrayLike<number>).length / 2) : 0,
      layouts: [
        {
          id: 'image',
          kind: 'layout',
          label: 'Image space',
          ...(space ? { space } : {}),
          // The widget's `points` are declared IN the raster's coordinate space — that is what
          // `image.affine` relating the two MEANS — so their own placement into it is identity.
          // Stated rather than omitted: the binding refuses a layout that names a space without
          // saying where in it its numbers sit, and this widget genuinely does say.
          ...(space ? { toSpace: [1, 0, 0, 0, 1, 0] as const } : {}),
        },
      ],
      valueColumns: [],
      categoricalColumns: [],
      continuousColumns: [],
      hasImage: true,
      ...(placeable && img
        ? {
            image: {
              width: img.width as number,
              height: img.height as number,
              channels: (img.channels ?? 4) as 3 | 4,
              affine: img.affine as readonly [number, number, number, number, number, number],
              space: IMAGE_WIDGET_SPACE,
              // The widget's placement is natively an `ImageUnderlay.affine` (space -> raster
              // pixels); `ImageMeta.toSpace` runs the other way and is what says the raster knows
              // WHERE in its space it sits. Without it the binding refuses — correctly, because a
              // space named with no placement is half a declaration. This widget's single texture
              // IS its level 0, so the two are exact inverses. Derived through the viz package so
              // affine arithmetic stays out of a module that should know only about transport.
              toSpace,
            },
          }
        : {}),
    }
  }
  async positions(_layoutId: string): Promise<Positions> {
    const src = this.opts.positions ?? []
    const positions = Float32Array.from(src as ArrayLike<number>)
    return { positions, length: Math.floor(positions.length / 2) }
  }
  async imageUnderlay(): Promise<ImageUnderlay> {
    const img = this.opts.image
    if (!img || !img.data || !img.width || !img.height || !img.affine) {
      throw new Error('ImageDataSource: missing/incomplete image underlay payload')
    }
    return {
      data: img.data as Uint8Array,
      width: img.width,
      height: img.height,
      channels: (img.channels ?? 4) as 3 | 4,
      affine: img.affine as readonly [number, number, number, number, number, number],
    }
  }
  async valueColumn(): Promise<SparseColumn> {
    throw new Error('ImageDataSource has no value columns')
  }
  async categorical(): Promise<CategoricalColumn> {
    throw new Error('ImageDataSource has no categorical columns')
  }
  async continuous(): Promise<ContinuousColumn> {
    throw new Error('ImageDataSource has no continuous columns')
  }
  async table(): Promise<DataTable> {
    return { rowLabels: [], columns: {} }
  }
  async graph(): Promise<GraphData> {
    return { nodeKey: '', paths: [] }
  }
}

/** Build the image DataSource an `image` widget's `<Viz>` reads (`$data.image` + `$data.spatial`). */
export function buildImageSource(w: ImageWidget, scope: Scope): ImageDataSource {
  const image = w.image != null ? (evalExpr(w.image, scope) as Partial<ImageUnderlay> | undefined) : undefined
  const pos = w.points != null ? evalExpr(w.points, scope) : undefined
  return new ImageDataSource({
    image,
    positions: Array.isArray(pos) ? (pos as number[]) : undefined,
  })
}

function BarViz({ w, ctx }: { w: BarWidget; ctx: WidgetRenderContext }): React.ReactElement {
  const { scope } = ctx
  const option = buildBarOption(w, scope)
  const frame = widgetFrame(w, scope)
  const groupKey = col(w.encode?.groupBy ?? w.encode?.x ?? w.groups, scope)
  const hiddenRaw = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  const hidden = Array.isArray(hiddenRaw) ? hiddenRaw : undefined
  const source = React.useMemo(() => new FrameDataSource({ frame, groupKey, hidden }), [frame, groupKey, hidden])
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid={testid(w, 'bar')}>
      {w.title ? <span className="absolute start-2 top-1 text-xs text-muted-foreground">{w.title}</span> : null}
      <Viz option={option} source={source} />
    </div>
  )
}

function HistogramViz({ w, ctx }: { w: HistogramWidget; ctx: WidgetRenderContext }): React.ReactElement {
  const { scope } = ctx
  const option = buildHistogramOption(w, scope)
  const frame = widgetFrame(w, scope)
  const valueKey = col(w.encode?.x ?? w.encode?.value ?? w.points, scope)
  const hiddenRaw = w.hidden != null ? (evalExpr(w.hidden, scope) as boolean[] | undefined) : undefined
  const hidden = Array.isArray(hiddenRaw) ? hiddenRaw : undefined
  const source = React.useMemo(() => new FrameDataSource({ frame, valueKey, hidden }), [frame, valueKey, hidden])
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid={testid(w, 'histogram')}>
      {w.title ? <span className="absolute start-2 top-1 text-xs text-muted-foreground">{w.title}</span> : null}
      <Viz option={option} source={source} />
    </div>
  )
}

function ImageViz({ w, ctx }: { w: ImageWidget; ctx: WidgetRenderContext }): React.ReactElement {
  const { scope } = ctx
  const option = buildImageOption(w, scope)
  const image = w.image != null ? (evalExpr(w.image, scope) as Partial<ImageUnderlay> | undefined) : undefined
  const posRaw = w.points != null ? evalExpr(w.points, scope) : undefined
  const positions = Array.isArray(posRaw) ? (posRaw as number[]) : undefined
  const source = React.useMemo(() => new ImageDataSource({ image, positions }), [image, positions])
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid={testid(w, 'image')}>
      {w.title ? <span className="absolute start-2 top-1 text-xs text-muted-foreground">{w.title}</span> : null}
      <Viz option={option} source={source} />
    </div>
  )
}

export const BarRenderer: WidgetRenderer = (spec, ctx: WidgetRenderContext) => (
  <BarViz w={spec as BarWidget} ctx={ctx} />
)

export const HistogramRenderer: WidgetRenderer = (spec, ctx: WidgetRenderContext) => (
  <HistogramViz w={spec as HistogramWidget} ctx={ctx} />
)

export const ImageRenderer: WidgetRenderer = (spec, ctx: WidgetRenderContext) => (
  <ImageViz w={spec as ImageWidget} ctx={ctx} />
)
