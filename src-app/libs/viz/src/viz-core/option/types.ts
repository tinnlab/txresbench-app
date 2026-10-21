// option/types.ts — the DECLARATIVE `VizOption` contract (EXTENSIBILITY_STUDY Part 4 /
// Part 6 STEP 6) + the PURE resolved-plan shape `parseOption` produces.
//
// A `VizOption` describes a whole coordinated grid declaratively (ECharts `setOption`
// spirit): a `dataset`, the `grid` regions (coordinate systems), the decoupled COMPONENTS
// composed BY ID (`dataZoom` / `selection` / `colorScale`), and the `series` (each names a
// registry `type`, its `coordId`, and its `encode` bindings). NOTHING here is chart-specific
// — `series[].type` is a registry key resolved via `getChartType`, `encode` is interpreted by
// that series' own descriptor (`bindingSchema` / `model()`), and the components reference
// series/regions purely by id + capability flags.
//
// PURE types only (no React, no deck, no store): `parse.ts` turns a `VizOption` +
// `DatasetCatalog` into a `ResolvedOption`; the `VizController` (adapter) then drives the
// existing stores from that plan. Additive — the imperative API is untouched.

import type { ColorBy, ColorMode, SingleChannelColorBy, BlendChannel, BlendAggregateOp } from '../data/engine'
import type { ContinuousColormap, DomainScale } from '../data/color'
import type { GridCell } from '../grid/gridModel'
import type { LayoutNode, SplitDir } from '@ziee/dock'
import type { ChartModel, CoordSystemId } from '../registry/types'
import type { TransitionConfig, TransitionProp } from '../charts/transitions'
// DEC-15 (Part D, Agent 4's domain): the multi-container pop-out DOCKING snapshot rides in the
// option so `getOption` round-trips pop-out windows + their docking. TYPE-ONLY import (erased at
// build) — the runtime type lives with its producer (`GridWorkspace.store.serialize()`); a single
// `LayoutNode` can't carry container identity (F3), so the consolidated shape is imported, not
// re-declared, keeping ONE source of truth for the wire form.
import type { DockingSnapshot } from '../../adapter/GridWorkspace.store'

// ── the declarative option ────────────────────────────────────────────────────────────

/** The dataset section — resolves to a `DataSource` via the controller's `resolveDataset`.
 *  `rev` (DEC-4) is an OPTIONAL, EXPLICIT content-invalidation token: same `id` + new `rev` ⇒
 *  re-acquire/re-stream; same `id` + same `rev` ⇒ no-op reuse. Absent ⇒ pure identity reuse. */
export interface VizDataset {
  readonly id: string
  readonly rev?: string | number
}

/** A grid region's slot. `col`/`row` place it in a (row-major) grid; a single entry ⇒ a
 *  lone leaf. Omitted axis ⇒ 0 (all-`col` ⇒ one row of columns; all-`row` ⇒ one column of
 *  rows; both present ⇒ a `row`-of-`col`s grid). */
export interface VizRegion {
  readonly col?: number
  readonly row?: number
}

/** A SPLIT directive placement (DEC-5): put this pane by splitting an EXISTING pane `from`, in
 *  direction `dir`, at fraction `at` (0..1; default 0.5). Normalized into the split tree by
 *  `parse.ts::resolveLayout`; equivalent to a user drag-split gesture captured declaratively. */
export interface VizSplit {
  readonly from: string
  readonly dir: SplitDir
  readonly at?: number
}

/** One coordinate-system region (ECharts `grid[i]`). `id` is the `coordId` a series binds to
 *  AND the grid leaf/cell id it becomes.
 *
 *  PLACEMENT (DEC-5) — a pane expresses WHERE it lives in EXACTLY one of three additive forms,
 *  all normalized to the SAME split tree by `resolveLayout`:
 *   - `region` — a simple row-major grid coord (the original, back-compat form);
 *   - `split`  — split an existing pane (`{ from, dir, at? }`), for nested splits;
 *   - `layout` — a full resolved `LayoutNode` subtree (round-trips pop-out docking, DEC-15).
 *  ALL THREE OPTIONAL: an entry with none is UNPLACED (DEC-5b aim-to-place; TRANSIENT, handled by
 *  the controller, never serialized) — at the pure-parse level it defaults to `region {}`. */
export interface VizGridEntry {
  readonly id: string
  readonly region?: VizRegion
  readonly split?: VizSplit
  readonly layout?: LayoutNode
}

export type VizAxis = 'x' | 'y'
export type VizDataZoomType = 'inside' | 'slider'

/** A dataZoom component instance, composed over a region BY ID (never baked into a series). */
export interface VizDataZoom {
  readonly id: string
  readonly type: VizDataZoomType
  readonly coordId: string
  readonly axes: readonly VizAxis[]
  /** The RESOLVED live zoom window in DATA units (`[lo, hi]`) — the `dataZoom` action payload
   *  captured by `getOption`. Strict-JSON (a plain number pair). Absent ⇒ full extent / no zoom. */
  readonly window?: readonly [number, number]
}

export type VizSelectionMode = 'lasso' | 'rect'

/** A camera / viewport state (DEC-16), strict-JSON. Mirrors the Coordination store's
 *  `VizViewState` but is option-owned (no adapter/store coupling). */
export interface VizViewportState {
  readonly target: readonly [number, number]
  readonly zoom: number
}

/** How one selection op folds onto the ops before it. 1:1 with `SelectionController.CombineMode`
 *  (`selection/SelectionController.ts:79`) — the SAME vocabulary the live fold uses, so an op list
 *  re-derives through the same `combineMask` the producer folded with (INV-2). */
export type VizSelectionCombine = 'add' | 'subtract' | 'intersect'

/** ONE recorded selection gesture: what was drawn, where, in which pane's identity space, and how it
 *  combines with what came before. The ORDER of a `VizSelectionOp[]` is load-bearing — it is a
 *  recipe, not a set (DEC-5: a merge-patch replaces the list wholesale, never concatenates).
 *
 *  `tool` is 1:1 with `SelectionController.Area.kind` — `'polygon'`, NOT `'lasso'` (DEC-1); the
 *  separate `VizSelectionMode` (`'lasso' | 'rect'`) vocabulary is untouched. Regions are in the
 *  pane's WORLD coordinates and strict JSON (no `Float32Array`, no `Set`). */
export type VizSelectionOp =
  | {
      readonly tool: 'rect'
      readonly op: VizSelectionCombine
      /** Grid CELL id the gesture was drawn on (DEC-3) — also the selection origin id. */
      readonly pane: string
      /** Identity space the pane resolves to; a region lives in exactly ONE space (DEC-2). */
      readonly space: string
      /** `[x0, y0, x1, y1]` in world coords, corner order free. */
      readonly region: readonly [number, number, number, number]
    }
  | {
      readonly tool: 'polygon'
      readonly op: VizSelectionCombine
      readonly pane: string
      readonly space: string
      /** An ordered ring of `[x, y]` world-coord vertices (>= 3). */
      readonly region: readonly (readonly [number, number])[]
    }
  | {
      readonly tool: 'ids'
      readonly op: VizSelectionCombine
      /** The origin id, or `null` for a purely programmatic `select()` with no origin (DEC-12). */
      readonly pane: string | null
      readonly space: string
      /** Canonical point ids — the provenance a NON-area producer records so that no selection is
       *  silently provenance-less. */
      readonly region: readonly number[]
    }

/** The DISPLAY state that explains a selection — captured at selection time so a saved figure can
 *  say what the user was looking at, and so `partitionSelection` can report which of the reported
 *  ids were hidden or outside a filter.
 *
 *  IT DOES NOT FILTER (DEC-20 / INV-1): the ruling is that the API reports EVERY point in the
 *  region, hidden or not. `context` is captured for EXPLANATION and PARTITIONING only — a context
 *  change never changes `ids`. The vocabulary is deliberately the one the package already uses
 *  (`VizOption.filters`, `VizColorBy.hidden`, `FigureManifest.filters`), not a third dialect. */
export interface VizSelectionContext {
  /** Per-plot continuous clamps in DATA units, keyed by the same stable plot id as
   *  `VizOption.filters`. Captured from the LIVE per-cell range (DEC-4). */
  readonly filters?: Record<string, readonly [number, number]>
  /** Per-plot hidden category codes — sorted `number[]`, never a `Set` (matching the
   *  `VizColorBy.hidden` wire discipline at `:225-228`). */
  readonly hidden?: Record<string, readonly number[]>
  /** Per-pane content hash of the point positions the ops were derived against (FNV-1a, 16 hex).
   *  The STALENESS detector: a moved hash means the underlying DATA changed, so the cached ids
   *  reference points that may no longer exist and a full re-derive is required (INV-8). */
  readonly panes?: Record<string, string>
}

/** The selection component (our brush/`connect()` analog): a set of series that fan a
 *  point-selection to each other, PLUS the resolved live selection (canonical point ids). */
export interface VizSelection {
  readonly mode: VizSelectionMode
  /** Series ids that link (a selection made in one fans to the others). */
  readonly link: readonly string[]
  /** RESOLVED live selection: the CANONICAL point ids of the DEFAULT identity space (DEC-16),
   *  a sorted `number[]` (never array indices, never a `Set`). Absent/empty ⇒ no selection.
   *
   *  A CACHE, not the source of truth (INV-7): when `ops` are present the ids are re-derivable from
   *  them, and `getOption({ selection: 'ops-only' })` omits this field entirely (DEC-21). Existing
   *  consumers that read only `ids` keep working unchanged (INV-4) — the DEFAULT emission stays
   *  byte-identical to pre-provenance. */
  readonly ids?: readonly number[]
  /** RESOLVED per-SPACE selection (DEC-16 / multi-dataset F6b): identity-space id → its canonical
   *  point ids. The default space also appears here; `ids` mirrors it for single-space readers. A
   *  selection in space A never bleeds into space B. Absent ⇒ single-space (only `ids`). */
  readonly spaces?: Record<string, readonly number[]>
  /** PROVENANCE (optional, additive): the ordered gesture list that produced `ids`. Absent on a
   *  pre-provenance option and on any selection whose producer records none. */
  readonly ops?: readonly VizSelectionOp[]
  /** PROVENANCE (optional, additive): the display state at selection time. */
  readonly context?: VizSelectionContext
  /** Schema tag for the provenance block, mirroring `FigureManifest.schema` (DEC-7). */
  readonly provenance?: 'ziee-viz-selection/1'
}

/** The linked color-scale component: the series that share ONE color domain (ITEM-64). */
export interface VizColorScale {
  /** Series ids that share a linked color domain. */
  readonly link: readonly string[]
  /** RESOLVED shared color DOMAINS, keyed by color-scale scope id (the color-by column key) →
   *  `[min, max]` (DEC-16). Captured by `getOption` so a restored `setOption` re-applies the exact
   *  shared scale instead of re-deriving it. Absent ⇒ each cell auto-scales to its own domain. */
  readonly domains?: Record<string, readonly [number, number]>
}

/** Per-color-by-column display overrides (DEC-16), strict-JSON. Mirrors the colorOverride store's
 *  `ColumnColorOverride`, option-owned (no adapter coupling): raw category NAME → swatch / label. */
export interface VizColorOverride {
  readonly categoryColors?: Record<string, string>
  readonly categoryLabels?: Record<string, string>
}

// ── plot-editing: per-control edit capabilities ────────────────────────────────────────────────
/** One in-cell edit control's capability: whether it is SHOWN and whether it is EDITABLE (mutable).
 *  A control with `editable:false` renders READ-ONLY. Either flag absent ⇒ that control's default. */
export interface VizControlCap {
  readonly show?: boolean
  readonly editable?: boolean
}
/** Declarative enable/disable/show/hide of the in-cell EDIT controls (plot-editing). Each key gates
 *  one control (legend / continuous colormap / titles / point-size+opacity). An absent key uses that
 *  control's DEFAULT (see `resolveControls`). */
export interface VizControls {
  readonly legend?: VizControlCap
  readonly colormap?: VizControlCap
  readonly titles?: VizControlCap
  readonly pointSize?: VizControlCap
}
/** The four control ids. */
export type VizControlId = 'legend' | 'colormap' | 'titles' | 'pointSize'
/** A control cap with both flags resolved to concrete booleans. */
export interface ResolvedControlCap {
  readonly show: boolean
  readonly editable: boolean
}
/** `VizControls` with every key present + defaults filled. */
export type ResolvedControls = Record<VizControlId, ResolvedControlCap>

/** Per-control defaults (DEC-4, revised after the byte-identical audit — FIND-1/2/3): absent `controls`
 *  is BYTE-IDENTICAL to the pre-feature render. So the NET-NEW chrome is opt-in:
 *  - `legend`: `show:true` (the categorical legend already rendered), `editable:false` — the read-only
 *    CANVAS legend (byte-identical). `editable:true` swaps in the DOM recolor/rename editor.
 *  - `colormap`: `show:false` — the new colormap PICKER is hidden (the existing VisualMap bar always
 *    renders regardless); opt in with `show:true`.
 *  - `titles`: `show:true` (a title-less cell renders NOTHING, so byte-identical), `editable:false`.
 *  - `pointSize`: `show:false` — the new Marks control is hidden; opt in with `show:true`.
 *  An app that WANTS the full editing surface opts every control in (see VisualizationPage). */
export const CONTROL_DEFAULTS: ResolvedControls = {
  legend: { show: true, editable: false },
  colormap: { show: false, editable: false },
  titles: { show: true, editable: false },
  pointSize: { show: false, editable: false },
}

/** The four control ids, in a stable order. */
export const CONTROL_IDS: readonly VizControlId[] = ['legend', 'colormap', 'titles', 'pointSize']

/** Resolve a (possibly-absent) `VizControls` into a full `ResolvedControls` — each control's flags
 *  default per `CONTROL_DEFAULTS`, overridden by whatever the option specified. */
export function resolveControls(controls?: VizControls): ResolvedControls {
  const out = {} as { [K in VizControlId]: ResolvedControlCap }
  for (const id of CONTROL_IDS) {
    const d = CONTROL_DEFAULTS[id]
    const c = controls?.[id]
    out[id] = { show: c?.show ?? d.show, editable: c?.editable ?? d.editable }
  }
  return out
}

/** Project a `ResolvedControls` back to the MINIMAL `VizControls` carrying only the controls whose
 *  flags differ from `CONTROL_DEFAULTS` (each such control emits only its differing flag). Returns
 *  `undefined` when everything is default — so `getOption()` output is byte-identical to pre-feature
 *  when the caller never set `controls`. Inverse of `resolveControls` up to defaults. */
export function diffControls(resolved: ResolvedControls): VizControls | undefined {
  const out: { [K in VizControlId]?: { show?: boolean; editable?: boolean } } = {}
  let any = false
  for (const id of CONTROL_IDS) {
    const d = CONTROL_DEFAULTS[id]
    const r = resolved[id]
    const cap: { show?: boolean; editable?: boolean } = {}
    if (r.show !== d.show) cap.show = r.show
    if (r.editable !== d.editable) cap.editable = r.editable
    if (cap.show !== undefined || cap.editable !== undefined) {
      out[id] = cap
      any = true
    }
  }
  return any ? out : undefined
}

/** A window over one/both axes in DATA units — the `dataZoom` action payload. */
export interface VizWindow {
  readonly x?: readonly [number, number]
  readonly y?: readonly [number, number]
}

/** A declarative `encode.colorBy` (the parser fills defaults → a full `ColorBy`). A single-
 *  channel mode names ONE `key`; `blend` names a `categoryKey` (→ hue) + a `valueKey` (→
 *  lightness/alpha modulation). Phase 2 ADDITIVELY accepts `categoricalColumns` (concatenated
 *  into one composite category) + `continuousColumns` (aggregated via `aggregate`) — the
 *  single `categoryKey`/`valueKey` remain the primary/first columns (and the fallback).
 *
 *  The single-channel variant inherits the ADDITIVE categorical override fields
 *  (`palette` / `categoryColors` / `categoryLabels`) via `Partial<SingleChannelColorBy>`; the
 *  `blend` variant names them explicitly (they drive the base-hue palette). */
export type VizColorBy =
  | (Omit<Partial<SingleChannelColorBy>, 'hidden'> & {
      readonly mode: ColorMode
      readonly key: string
      /** Legend-hidden category indices. STRICT-JSON (DEC-12): the canonical wire form is a sorted
       *  `number[]`; a `ReadonlySet` is still ACCEPTED on input (back-compat) and normalized to a
       *  `Set` for the engine by `resolveColorBy`. `getOption` always EMITS the sorted array. */
      readonly hidden?: ReadonlySet<number> | readonly number[]
    })
  | {
      readonly mode: 'blend'
      readonly categoryKey: string
      readonly valueKey: string
      readonly channel?: BlendChannel
      readonly alphaFloor?: number
      readonly perGroupDomain?: boolean
      readonly scale?: DomainScale
      readonly colormap?: ContinuousColormap
      /** Legend-hidden category indices — strict-JSON `number[]` (DEC-12); a `Set` is accepted on
       *  input and normalized. See the single-channel variant's note. */
      readonly hidden?: ReadonlySet<number> | readonly number[]
      readonly palette?: ColorBy['palette']
      readonly categoryColors?: ColorBy['categoryColors']
      readonly categoryLabels?: ColorBy['categoryLabels']
      /** Phase-2: extra categorical columns concatenated with `categoryKey` into one composite
       *  category (the observed cross-product). */
      readonly categoricalColumns?: readonly string[]
      /** Phase-2: extra continuous columns aggregated with `valueKey` into one value. */
      readonly continuousColumns?: readonly string[]
      /** Phase-2: the aggregate operator for `continuousColumns` (default 'mean'). */
      readonly aggregate?: BlendAggregateOp
      /** Phase-2: optional per-continuous-column weights (sum/mean only). */
      readonly continuousWeights?: readonly number[]
    }

/**
 * A series' data bindings — interpreted by the series' OWN descriptor (`bindingSchema`),
 * the core NEVER enumerates them. Well-known optional channels are typed for ergonomics;
 * arbitrary chart-specific keys ride through the index signature (e.g. heatmap `cluster`).
 */
export interface VizEncode {
  /** The positions/layout id a dense (world2d) series reads (→ `GridCell.layoutId`). */
  readonly layout?: string
  /** A dense series' color-by intent (→ `GridCell.colorBy`). */
  readonly colorBy?: VizColorBy
  /** Categorical grouping (→ the `categorical` channel). */
  readonly groupKey?: string
  /** Primary value column (→ the `value` channel). */
  readonly valueKey?: string
  /** Continuous value column (→ a `continuous` channel, e.g. histogram). */
  readonly continuousKey?: string
  /** Several value columns (→ the `valueList` channel, e.g. heatmap/dotplot). */
  readonly valueKeys?: readonly string[]
  /** A bulk table name (→ the `table` channel, e.g. volcano). */
  readonly table?: string
  readonly [k: string]: unknown
}

/** One series: a registry `type`, a `coordId`, its `encode` bindings + participation flags. */
export interface VizSeries {
  readonly id: string
  /** The registry key (`getChartType(type)`), e.g. `'scatter'` / `'heatmap'`. */
  readonly type: string
  /** The `grid[].id` region this series binds to. */
  readonly coordId: string
  /**
   * COMPOSED CANVAS (host-supplied): the id the DECLARING author wrote for this cell, when the host
   * had to namespace `coordId` to fold several independently-authored declarations onto one grid
   * (two of them may legitimately name a pane the same thing, and a collision on a shared grid is a
   * silent merge of two unrelated plots).
   *
   * It is the cell's DOM identity and nothing else: `coordId` remains the grid's own key — for
   * layout, for the store, for the drag hit-test — and is never derived from this. Absent ⇒
   * `coordId` IS the authored id, which is every un-composed caller; nothing changes for them.
   *
   * It is NOT required to be unique: two contributions naming a pane `emb` both keep `emb` here,
   * which is exactly the case `ownerId` disambiguates.
   */
  readonly localId?: string
  /** COMPOSED CANVAS (host-supplied): which contributing declaration placed this cell — the other
   *  half of `localId`, so two views that both named a pane `emb` stay tellable apart in the DOM.
   *  Absent ⇒ nothing composed this cell. */
  readonly ownerId?: string
  /**
   * MULTI-DATASOURCE (ITEM-2): which dataset (a `datasets[]`/`dataset` id) this series reads. Unset ⇒
   * the first/sole dataset (single-dataset callers omit it). MANY series may share one `datasetId`
   * (1:N dataset→series); each series names exactly one dataset. An unknown id fails LOUD at parse.
   */
  readonly datasetId?: string
  /** Data bindings, validated by this series' own descriptor. */
  readonly encode?: VizEncode
  /** CONSUME the shared selection (dim/emphasis). Overrides the descriptor default. */
  readonly emphasis?: { readonly consumesSelection?: boolean }
  /** PRODUCE a selection (has a brush/lasso gesture). Overrides the descriptor default. */
  readonly select?: { readonly produces?: boolean }
  /**
   * CONTROLLED close (Phase 3): when `true`, this cell's close X does NOT remove the cell directly — it
   * emits a `cell-close` event so the APP owns the removal. Use for a STATE-DERIVED cell (e.g. one
   * declared `for_each`), whose existence is a function of state: an imperative close would be re-emitted
   * on the next render (a reopen loop), so the app must route the close to the state mutation instead.
   * Absent/false ⇒ the built-in remove (byte-identical).
   */
  readonly controlled?: boolean
  /**
   * WHY the user cannot remove this cell — present ⇒ its close X renders UNAVAILABLE and says this,
   * absent ⇒ removable (byte-identical to today). See `GridCell.removeBlockedReason` for why the
   * reason and the blocking are ONE field.
   *
   * The case it exists for: a `controlled: true` cell whose close the host has nowhere to route.
   * `controlled` means "do not self-remove, tell the app instead", so a host with no handler for
   * this cell leaves a fully live, fully styled X that does NOTHING when clicked. Declaring the
   * reason turns that silent no-op into a stated one.
   */
  readonly removeBlockedReason?: string
  /**
   * A PROVENANCE MARKER this cell carries, verbatim — rendered as a persistent badge in the pane
   * chrome AND as a line under the categorical legend. Absent ⇒ no mark (byte-identical).
   *
   * It exists because a marker seen only at the moment of choosing is not a marker: it is a
   * disclaimer nobody sees again. The chrome leg keeps the fact beside the picture for as long as
   * the picture is open, and the legend leg is what makes it survive a screenshot — the legend
   * geometry is shared with the vector export, so the mark leaves the building with the figure.
   *
   * Viz renders the string and knows nothing about what it means; deciding that is the host's.
   */
  readonly provenanceNote?: string
  /**
   * The EXPLICIT set of chart types this cell's kind switcher may offer (the allowed alternatives).
   * When given, it takes PRECEDENCE over the chrome's auto-inferred `compatibleChartTypes(...)` set
   * (explicit wins); when omitted the chrome auto-infers from binding-schema compatibility against
   * the dataset. `parseOption` validates each entry is (a) a registered chart type and (b) data-
   * compatible (its binding schema satisfiable by the dataset's columns) — an unknown / incompatible
   * declared alternative throws a clear `[viz]` error (consistent with the encode binding-validation).
   */
  readonly switchTo?: readonly string[]
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ visual changes snap
   * (byte-identical to today); `{ duration?, easing? }` ⇒ the AGGREGATED, attribute-based Views
   * (bar/box/violin/dotplot/histogram) GPU-interpolate a recolor / data change. Threaded onto the
   * resolved series + cell so a declarative `<Viz option>` enables + tunes it per plot (mirrors
   * how `dataZoom` is threaded). Ignored on the dense scatter + heatmap-texture kinds (perf /
   * not-attribute-tweenable). `parseOption` validates it minimally (duration ≥ 0, known easing).
   */
  readonly transitions?: TransitionProp
  /**
   * SERIES-LEVEL color-by intent (DEC-16), an ADDITIVE alias/home for `encode.colorBy`. When both
   * are set `encode.colorBy` WINS (back-compat); `parseOption` resolves from `encode.colorBy ??
   * colorBy`, so a single-dataset caller can hang the colorBy off the series directly. Same
   * `VizColorBy` shape (strict-JSON `hidden`).
   */
  readonly colorBy?: VizColorBy
  /** Per-cell node-link GRAPH overlay toggle (→ `GridCell.graphOverlay`; DEC-14/16). Meaningful on
   *  a dense (scatter) cell; ignored elsewhere. Absent ⇒ off (byte-identical). */
  readonly graphOverlay?: boolean
  /** Per-cell ANNOTATION overlay opt-in (→ `GridCell.annotate`; ITEM-3). When `true` on a DENSE
   *  (world2d) cell — typically an `image` cell — the grid mints a per-cell `AnnotateStore` and
   *  composes `buildAnnotationLayers(...)` into the shared deck; ignored on a chart cell.
   *  Absent ⇒ off (byte-identical). */
  readonly annotate?: boolean
  /** Per-cell SEGMENTATION opt-in (→ `GridCell.segment`; segmentation-scale ITEM-3). When `true` on a
   *  DENSE (world2d) cell — typically an `image` cell — the grid enables the in-grid label-mask surface
   *  (`buildLabelMaskLayers` on the shared deck + the live `MaskReviewControls` review/correct panel);
   *  ignored on a chart cell. Independent of `annotate` (a cell may have either, both, or neither).
   *  Absent ⇒ off (byte-identical). The resolved mask data itself is supplied out-of-band on the cell. */
  readonly segment?: boolean
  /** Per-series presentation style (DEC-14): `radius` re-homes the old `GridWorkspace` `radius` prop
   *  onto the series; `opacity` (0..1, plot-editing DEC-7) is the mark layer alpha. Threaded onto the
   *  resolved series (no `GridCell` field to change). */
  readonly style?: { readonly radius?: number; readonly opacity?: number }
  /** Plot-editing (ITEM-4, DEC-8): an editable per-cell PLOT title + optional x/y AXIS titles. The plot
   *  title renders as an inline-editable in-cell header (gated by `controls.titles`); the axis titles
   *  thread to the chart's `ChartFrame` (declarative, gated by `controls.titles.show`). Absent ⇒ the
   *  View's default titles (byte-identical). */
  readonly title?: string
  readonly axisTitles?: { readonly x?: string; readonly y?: string }
  /** MATRIX charts (heatmap/dotplot): the continuous VALUE colormap for the cell/dot fill scale. Absent
   *  ⇒ the view's built-in default. Round-trips through `getOption`/`setOption` (edit-form Color section). */
  readonly valueColormap?: ContinuousColormap
  /** Per-series camera / viewport (DEC-16): the resolved `{ target, zoom }` of this series' cell,
   *  captured by `getOption` so a restored `setOption` re-centers the view. Strict-JSON. */
  readonly viewState?: VizViewportState
  /** Chart-specific options validated by the series' `model()` (rides through). */
  readonly [k: string]: unknown
}

/** The whole declarative option (EXTENSIBILITY_STUDY Part 4) — the COMPLETE, strict-JSON,
 *  data-independent state model (ECharts `setOption` spirit). Every field is JSON-serializable, so
 *  `getOption()` → app store → `setOption(saved)` round-trips byte-for-byte. */
export interface VizOption {
  /** The `VizOption` schema version (DEC-16 / ITEM-7). Absent ⇒ current (`VIZ_OPTION_VERSION`);
   *  `migrateOption` normalizes an older/legacy blob forward and refuses a newer one. */
  readonly version?: number
  /**
   * MULTI-DATASOURCE: the datasets this option renders (1:N with `series` — many series may bind one
   * dataset). At least one of `datasets`/`dataset` must be present; `parseOption` normalizes `dataset`
   * → `datasets` (both present ⇒ `dataset` prepended, de-duped by id).
   */
  readonly datasets?: readonly VizDataset[]
  /** Back-compat sugar for a single dataset — prefer `datasets: [ … ]`. Normalized into `datasets`. */
  readonly dataset?: VizDataset
  readonly grid: readonly VizGridEntry[]
  /**
   * The RESOLVED split-tree `LayoutNode` (DEC-5) — the AUTHORITATIVE layout form. When present it
   * supersedes the per-`grid`-entry `region`/`split` placement: its leaves MUST correspond 1:1 with
   * the `grid` entry ids, and `resolveLayout` returns it verbatim (so nested splits + pop-out docking
   * round-trip). `getOption` ALWAYS emits this resolved tree. Absent ⇒ the tree is built from the
   * grid entries' `region`/`split` placement.
   */
  readonly layout?: LayoutNode
  readonly dataZoom?: readonly VizDataZoom[]
  readonly selection?: VizSelection
  readonly colorScale?: VizColorScale
  /** Explicit link-zoom override. When set, it WINS over the auto-derivation (≥2 world2d series in one
   *  coordinate space ⇒ linked). Set `false` to keep same-space cells zooming INDEPENDENTLY by default
   *  (the user still opts into linking via the Link-zoom toggle); `true` forces linking. Absent ⇒ the
   *  auto-derived default. Mirrors the resolved plan's `gridLinked`. */
  readonly gridLinked?: boolean
  /** RESOLVED per-plot continuous FILTER clamps (DEC-16), keyed by a stable plot id → `[lo, hi]` in
   *  DATA units. Lifted from the old component-local `visualMap` range so a restore re-applies it.
   *  Absent ⇒ no filters. */
  readonly filters?: Record<string, readonly [number, number]>
  /** RESOLVED "color-by the current selection" axis (DEC-16): the column key the workspace colors by
   *  selection, or `null` when off. Mirrors the Coordination store's `colorBySelection`. */
  readonly colorBySelection?: string | null
  /** RESOLVED per-color-by-column display overrides (DEC-16), keyed by color-by column key. */
  readonly colorOverrides?: Record<string, VizColorOverride>
  /** Declarative enable/disable/show/hide of the in-cell EDIT controls (plot-editing). Absent ⇒ each
   *  control's default (legend shown+editable; colormap/titles/pointSize shown+read-only). */
  readonly controls?: VizControls
  /**
   * DEC-15 (Part D): the multi-container pop-out DOCKING snapshot (containers list + per-pane
   * container binding + return-to-origin anchors), captured verbatim from the grid store's
   * `serialize().docking`. Present ONLY when ≥1 pane is docked out (single-window sessions omit it);
   * `getOption` passes it through so a pop-out layout round-trips. The gesture-free REOPEN policy
   * that consumes it (ITEM-19) is Agent 4's integration — `parseOption` ignores it today, so it is a
   * pure pass-through carried on the wire form until then.
   */
  readonly docking?: DockingSnapshot
  readonly series: readonly VizSeries[]
}

// ── the resolved plan (parseOption output) ─────────────────────────────────────────────

/** A resolved series: its descriptor-derived `model` (bindings overlaid with `encode`), the
 *  coordinate system it lives in, and its RESOLVED participation flags. */
export interface ResolvedSeries {
  readonly id: string
  readonly type: string
  readonly coordId: string
  /** MULTI-DATASOURCE (ITEM-3): the resolved dataset id this series reads (the default when unset). */
  readonly datasetId: string
  readonly coordinateSystem: CoordSystemId
  /** The resolved model: the descriptor's catalog defaults, overlaid with `encode` bindings. */
  readonly model: ChartModel
  readonly consumesSelection: boolean
  readonly producesSelection: boolean
  /** The dense-cell color-by intent (present only when `encode.colorBy` was given). */
  readonly colorBy?: ColorBy
  readonly linkColorScale: boolean
  /** The resolved per-plot transition config (present ONLY when `transitions` enabled it — a
   *  `false`/omitted series carries no field, so the default-off render is unchanged). */
  readonly transitions?: TransitionConfig
  /** Resolved per-cell GRAPH overlay toggle (present only when the series set `graphOverlay`). */
  readonly graphOverlay?: boolean
  /** Resolved per-series style (present only when the series set `style`, e.g. `{ radius, opacity }`). */
  readonly style?: { readonly radius?: number; readonly opacity?: number }
  /** Resolved plot title (ITEM-4; present only when the series set it). */
  readonly title?: string
  /** Resolved x/y axis titles (ITEM-4; present only when the series set them). */
  readonly axisTitles?: { readonly x?: string; readonly y?: string }
  /** Resolved per-series camera / viewport (present only when the series carried a `viewState`). */
  readonly viewState?: VizViewportState
}

/** A resolved dataZoom: its config + the coordinate-space key of the region it targets. */
export interface ResolvedDataZoom {
  readonly id: string
  readonly type: VizDataZoomType
  readonly coordId: string
  /** The `cellSpaceKey` of the target region (the link-zoom scope for world2d). */
  readonly spaceKey: string
  readonly axes: readonly VizAxis[]
  /** The resolved live zoom window (present only when the option carried one). */
  readonly window?: readonly [number, number]
}

/**
 * The PURE plan `parseOption` produces from a `VizOption` + catalog. The controller drives
 * the existing `GridWorkspace` + `Coordination` stores from these fields — it is NOT a new
 * render pipeline: `layout`/`cells`/`seq` populate the grid store; `series` carry the
 * resolved models; `dataZoom`/`selection`/`colorScale`/`gridLinked` configure the components.
 */
export interface ResolvedOption {
  /** The resolved `VizOption` schema version (echoed from the option, else `VIZ_OPTION_VERSION`). */
  readonly version: number
  /** MULTI-DATASOURCE (ITEM-3): every referenced dataset id, in declared order. */
  readonly datasetIds: readonly string[]
  /** Back-compat: the FIRST/default dataset id (single-dataset readers, `capture()`). */
  readonly datasetId: string
  /** The split-tree the `GridWorkspace` store renders (built from `grid[].region`). */
  readonly layout: LayoutNode
  /** The per-cell configs, keyed by region/cell id (`kind` from the bound series' `type`). */
  readonly cells: Record<string, GridCell>
  /** The grid store's `seq` (so subsequent imperative `addCell` ids don't collide). */
  readonly seq: number
  /** Region ids in grid order. */
  readonly order: readonly string[]
  readonly series: readonly ResolvedSeries[]
  readonly dataZoom: readonly ResolvedDataZoom[]
  readonly selection:
    | {
        readonly mode: VizSelectionMode
        readonly link: readonly string[]
        /** RESOLVED default-space selection ids (present only when the option carried them). */
        readonly ids?: readonly number[]
        /** RESOLVED per-space selection ids (present only when the option carried them). */
        readonly spaces?: Record<string, readonly number[]>
        /** RESOLVED provenance op list (present only when the option carried it). */
        readonly ops?: readonly VizSelectionOp[]
        /** RESOLVED provenance context (present only when the option carried it). */
        readonly context?: VizSelectionContext
        /** RESOLVED provenance schema tag (present only when the option carried it). */
        readonly provenance?: 'ziee-viz-selection/1'
      }
    | null
  readonly colorScale:
    | {
        readonly link: readonly string[]
        /** RESOLVED shared color domains (present only when the option carried them). */
        readonly domains?: Record<string, readonly [number, number]>
      }
    | null
  /** RESOLVED per-plot filter clamps (present only when the option carried them). */
  readonly filters?: Record<string, readonly [number, number]>
  /** RESOLVED "color-by selection" axis (present only when the option carried it). */
  readonly colorBySelection?: string | null
  /** RESOLVED per-column display overrides (present only when the option carried them). */
  readonly colorOverrides?: Record<string, VizColorOverride>
  /** RESOLVED per-control edit capabilities with defaults filled in (plot-editing) — every control
   *  key present with concrete `{show, editable}` booleans. */
  readonly controls: ResolvedControls
  /** Whether the grid's linked cells should zoom/pan in lockstep (derived: ≥2 world2d
   *  series share one coordinate space). */
  readonly gridLinked: boolean
}
