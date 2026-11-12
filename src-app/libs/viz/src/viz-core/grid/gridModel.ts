// gridModel.ts — PURE grid-workspace logic (DEC-19/20/21): the split-tree ↔
// per-cell mapping and the layer→view routing map. No React, no deck.gl context,
// no DOM — plain data transforms over the `LayoutNode` tree + the cell configs, so
// the whole file is unit-testable in node. Generic, domain-agnostic naming
// (DEC-28): a "cell" is a logical view bound to a pane; nothing here knows biology.

import type { LayoutNode } from '@txresbench/dock'
import { leafIds } from '@txresbench/dock'
import type { PixelSource } from '@vivjs/types'
// From the deck-FREE `layerIds` module, NOT `multiView` (which imports `@deck.gl/core`).
// This file is pure data read by the option parser and the grid STORE; taking a value from
// `multiView` gave both of those a live path to deck.gl. See `layerIds.ts` for the numbers.
import { cellLayerId } from '../layers/layerIds'
import type { ChannelLabels, RasterChannelState } from '../spatial/rasterImageLayers'
import type { BitmapTexture } from '../layers/bitmapTexture'
import type { DatasetCatalog } from '../data/wire'
import type { ColorBy } from '../data/engine'
import type { CategoricalOverrides, ContinuousColormap } from '../data/color'
import { resolveSharedDomain, type ColorScaleScope } from '../coordination/colorScale'
import { getChartType } from '../registry/registry'
import type { ResolvedBindings } from '../registry/types'
import type { TransitionConfig } from '../charts/transitions'
import type { Typography } from '../controls/typography'
import type { LegendCorner } from '../controls/legendRender'
import type { GridViewState } from './linkZoom'

/**
 * A named category for the in-grid label-mask review panel (segmentation-scale ITEM-1/2):
 * a category CODE (as it appears in `LabelMaskData.categoryForId`) + an optional human
 * label + swatch color. Absent labels default to `Class {code}` in the panel. Pure data —
 * mirrors `MaskCategory` in `MaskReviewControls.tsx` but lives here so the pure grid model
 * can carry it without importing a React component.
 */
export interface LabelMaskCategoryMeta {
  readonly code: number
  readonly label?: string
  readonly color?: readonly [number, number, number]
}

/**
 * The RESOLVED in-grid label mask a `segment` cell renders (segmentation-scale ITEM-1).
 * One integer id per pixel (row-major, 0 = background), the id→category LUT, and the
 * placement of the pixel grid into the cell's world space. The `raster`/`categoryForId`
 * arrays are mutated IN PLACE by the per-cell `createMaskCorrectController` (one raster,
 * dirty-rect sub-upload) — the layer + the controller share these exact references.
 */
export interface LabelMaskData {
  /** integer id per pixel, row-major, 0 = background. Mutated in place by corrections. */
  readonly raster: Uint32Array
  readonly width: number
  readonly height: number
  /** id→category code (index = id, 0 = background). Mutated in place by relabel/merge. */
  readonly categoryForId: Uint16Array
  /** optional named categories for the review panel; absent ⇒ derived as `Class {code}`. */
  readonly categories?: readonly LabelMaskCategoryMeta[]
  /**
   * placement of the FULL-RES pixel grid into world space — a column-major 16 `number[]`
   * (from the image's `imageModelMatrix`). Absent ⇒ identity (pixel space == world, the
   * same registration the image `loader`/`BitmapLayer` uses), so the mask overlays the image 1:1.
   */
  readonly modelMatrix?: number[]
}

/**
 * Per-cell view-kind (DEC-21 / DEC-28 glossary). Formerly a closed 10-member union; now
 * an OPEN string keyed against the chart-type REGISTRY (EXTENSIBILITY_STUDY Part 6 STEP
 * 1). A `kind` is valid IFF `hasChartType(kind)` — an unregistered kind renders the
 * visible "unsupported kind" fallback rather than being a compile error. The built-in
 * ten (scatter/image/grid/violin/box/bar/dotplot/heatmap/volcano/histogram) are
 * registered by `installBuiltins()`.
 */
export type CellKind = string

/**
 * Dense vs. chart cells (Phase C1): DENSE kinds render into the shared single-`<DeckGL>`
 * / N-views deck (one WebGL context, DEC-20); every other kind is a companion
 * statistical CHART that renders its OWN `ChartCanvas` in the flat content overlay,
 * positioned at the pane's measured rect. This predicate is the single source of truth
 * for that partition — the grid, the overlay, and `CellView` all key off it.
 *
 * A cell is DENSE iff its registered chart type's coordinate system is `world2d`
 * (scatter / image) — the registry-backed replacement for the old hard-coded
 * `kind === 'scatter' || kind === 'image'`. An unregistered kind (registry miss) is
 * NOT dense (it renders the chart-overlay fallback). REQUIRES `installBuiltins()` to
 * have run so the registry is populated.
 */
export function isDenseKind(kind: CellKind): boolean {
  return getChartType(kind)?.coordinateSystem === 'world2d'
}

// ── `defaultBindings` / `CellBindings` were DELETED here ────────────────────────────────
//
// They were a byte-identical second copy of the chart-binding guess, at ordinal 0:
//
//     const groupKey      = catalog.categoricalColumns[0]?.id ?? 'group'
//     const valueKeys     = catalog.valueColumns.slice(0, 6)
//     const valueKey      = valueKeys[0] ?? ''
//     const continuousKey = catalog.continuousColumns[0]?.id ?? 'qcA'
//
// The same four picks the registry's `resolveBindingChannel` made, spelled a second time in a
// second file — which is why the two had to be kept in agreement, and why a test existed
// asserting they agreed. That test proved only that the guess had been copied faithfully.
//
// It had ZERO production callers: every render path resolves through the descriptor's own
// `model()` (`registry/model.ts`). The remaining callers were tests using it as the ORACLE for
// "what the bindings should be" — an oracle that could only ever certify the defect.
//
// Deleted rather than fixed twice: a rule that must hold in two places holds in neither for
// long. See `docs/design/binding-resolution-refusal.md`.

/** The config a grid cell carries: its id, chosen view-kind, and data binding. */
export interface GridCell {
  id: string
  kind: CellKind
  /**
   * COMPOSED CANVAS: the id the DECLARING author wrote for this cell, when the host namespaced `id`
   * to fold several independently-authored declarations onto one grid. Stamped by `parseOption`
   * from `series.localId`. It is the cell's DOM identity ONLY (`cellTestId`); `id` remains the
   * grid's own key — layout, store, drag hit-test — and is never derived from this.
   *
   * It stays with the cell's IDENTITY, not its content: `swapCellContent` spreads it and does not
   * trade it, because a drag-swap trades what two panes DISPLAY, and this names the pane.
   */
  localId?: string
  /** COMPOSED CANVAS: which contributing declaration placed this cell (`series.ownerId`) — the
   *  disambiguator for two contributions that both named a pane the same thing. */
  ownerId?: string
  /** Data binding — the layout (positions set) id this cell reads from the `DataSource`. */
  layoutId: string
  /**
   * MULTI-DATASOURCE (ITEM-4 / DEC-M8): which dataset this cell reads from (the `datasets[]` id).
   * Absent ⇒ the DEFAULT (first/sole) dataset — a single-dataset workspace omits it and stays
   * byte-identical. Many cells may share one `datasetId` (the 1:N dataset→series relationship).
   */
  datasetId?: string
  /**
   * IMAGE cell (ITEM-1): the resolved Viv resolution pyramid this cell renders — index 0 =
   * full resolution, each subsequent entry half-scale (`length > 1` ⇒ MultiscaleImageLayer,
   * `length === 1` ⇒ ImageLayer). Fed to `buildRasterImageLayers`; sourced from
   * `DataSource.imagePixelSource()`. Meaningful only on an `image` (dense/world2d) cell.
   * ABSENT ⇒ the cell falls back to the legacy single-tile `imageUnderlay()` BitmapLayer
   * (byte-identical to pre-ITEM-1 behavior). Additive — non-image cells never set it.
   */
  loader?: PixelSource<ChannelLabels>[]
  /**
   * IMAGE cell (ITEM-1): per-channel display state (name / color / contrastLimits / visible)
   * driving the Viv XRLayer channel model, aligned 1:1 to `loader`'s channel axis. Paired
   * with `loader`; absent ⇒ no per-channel rendering (the fallback path). Meaningful only on
   * an `image` cell.
   */
  channels?: RasterChannelState[]
  /**
   * IMAGE cell (ITEM-1 / ITEM-2 seam): an OPTIONAL single additive colormap name (e.g.
   * `'viridis'`) applied via Viv's `AdditiveColormapExtension` — mutually exclusive with the
   * per-channel `channels[].color` palette. Absent ⇒ per-channel additive colors. Meaningful
   * only on an `image` cell.
   *
   * NAME DISAMBIGUATION — this bare `colormap` is the IMAGE ADDITIVE colormap ONLY. It is a
   * DISTINCT concept from the other two "colormap" fields on a cell, which it must not be
   * confused with: `colorBy.colormap` (the SCATTER continuous point-color scale) and
   * `valueColormap` (the MATRIX heatmap/dotplot value fill scale). Kept unqualified for
   * back-compat with the ITEM-1 image path; a rename to `imageColormap` was rejected because
   * `GridWorkspace.tsx` reads `cell.colormap` on the render path (would ripple cross-file).
   */
  colormap?: string
  /**
   * ANNOTATION overlay opt-in (ITEM-3). When `true` on a DENSE (world2d) cell — typically
   * an `image` cell — the grid mounts a per-cell `AnnotateStore` and composes
   * `buildAnnotationLayers(...)` (cellId-prefixed) into the ONE shared deck, riding this
   * cell's pan/zoom. Non-annotated cells (absent/false) are completely unaffected — no
   * store minted, no overlay layers. Meaningless (ignored) on a chart cell.
   */
  annotate?: boolean
  /**
   * SEGMENTATION opt-in (segmentation-scale ITEM-3). When `true` on a DENSE (world2d)
   * cell — typically an `image` cell — the grid enables the in-grid label-mask surface:
   * it composes `buildLabelMaskLayers(...)` (cellId-prefixed) for this cell's `labelMask`
   * into the ONE shared deck and mounts the live `MaskReviewControls` review/correct
   * panel (docked via `maskControlsContainer`). Independent of `annotate` — a cell may
   * have either, both, or neither. Absent/false ⇒ no mask surface, no controls (byte-
   * identical). Meaningless (ignored) on a chart cell. Stamped by `parseOption` from
   * `series.segment` (the twin of the `annotate` stamp).
   */
  segment?: boolean
  /**
   * SEGMENTATION (segmentation-scale ITEM-1): the RESOLVED in-grid label mask this cell
   * renders — one integer id per pixel (row-major, 0 = background) plus the id→category
   * LUT and its placement into the cell's pixel/world space. Fed to `buildLabelMaskLayers`
   * and (in place) to the per-cell `createMaskCorrectController` so corrections mutate this
   * single raster. Meaningful only when `segment` is on. ABSENT ⇒ the cell has no mask
   * (the layer contributes nothing — byte-identical). Additive — non-segment cells never set it.
   */
  labelMask?: LabelMaskData
  /**
   * Per-cell node-link GRAPH overlay toggle (Phase C3c / ITEM-53). When `true` on a
   * DENSE (scatter) cell, the grid appends the LineLayer/ScatterplotLayer/TextLayer
   * built from `buildGraphOverlay` as `<cellId>::graph-*` layers — routed by the layer
   * prefix into THIS cell's viewport only, riding its pan/zoom on the shared deck.
   * Meaningless (ignored) on a chart cell. Absent ⇒ off.
   */
  graphOverlay?: boolean
  /**
   * Per-cell COLOR-BY intent (Phase C3b / ITEM-64). When present on a DENSE
   * (scatter) cell, the grid colors THIS cell by its own column via
   * `computeColoring` instead of the shared `colors` buffer. Absent ⇒ the cell
   * falls back to the shared `colors` prop (byte-identical to pre-C3b behavior).
   */
  colorBy?: ColorBy
  /**
   * Per-cell LINK-COLOR-SCALE toggle (Phase C3b / ITEM-64 made real in the grid).
   * When `true`, this cell joins the shared color DOMAIN across every linked cell
   * coloring by the SAME `colorBy.key` (continuous/value), so identical values map
   * to identical colors across those cells. Absent/false ⇒ the cell auto-scales to
   * its own domain independently.
   */
  linkColorScale?: boolean
  /**
   * ENFORCED coordination-capability flags (viz-followups Area B, ITEM-4), stamped by
   * `parseOption` from the resolved series' descriptor default + `series.emphasis`/`series.select`
   * override. `CellView.ChartBody` threads them (falling back to the descriptor's `capabilities`)
   * onto the uniform `ChartViewProps` so each View gates its consume/produce/dataZoom behavior.
   * Absent ⇒ the View's today-behavior (byte-identical); only an explicit opt-out changes it.
   * Travel WITH the cell's display fields on a content swap (they are chart-type-keyed, like
   * `bindings`/`switchTo`).
   */
  consumesSelection?: boolean
  producesSelection?: boolean
  dataZoomAxes?: readonly ('x' | 'y')[]
  linkableColorScale?: boolean
  /**
   * Plot-editing (ITEM-5, DEC-7): per-cell MARK style — `radius` (point size, px) and `opacity`
   * (0..1, mark-layer alpha). Threaded from the resolved series' `style` on setOption, mutated in-cell
   * by the marks control (`setCellStyle`), and re-emitted onto `series.style` by `getOption`. Absent
   * (or a field unset) ⇒ the workspace `radius` prop / full opacity (byte-identical).
   */
  style?: { radius?: number; opacity?: number }
  /**
   * Plot-editing (ITEM-4, DEC-8): an editable per-cell PLOT title + optional x/y AXIS titles. Threaded
   * from the resolved series on setOption, mutated in-cell by the title editor (`setCellTitles`), and
   * re-emitted onto `series.title`/`series.axisTitles` by `getOption`. Absent ⇒ the View's default
   * titles (byte-identical).
   */
  title?: string
  axisTitles?: { x?: string; y?: string }
  /** Show the chart-frame GRID LINES (box/violin/bar/histogram/volcano). Absent ⇒ default ON. Edited
   *  in the pane form; threaded to the View's `showGrid`. */
  showGrid?: boolean
  /** Show the on-plot LEGEND / visual-map overlay (any cell that has one). Absent ⇒ default ON. Edited
   *  in the pane form; gates the WYSIWYG legend overlay + the exported legend. */
  showLegend?: boolean
  /** HIDDEN group CODES for a grouped chart (box/violin/bar/dotplot/heatmap) — toggled from the legend
   *  swatch OR the edit form (they share this field). A hidden group's column collapses (reflow). Absent/
   *  empty ⇒ all groups shown. Persisted with the cell so a saved workspace keeps the hidden set. */
  hiddenGroups?: number[]
  /** LEGEND-hidden category/group codes — DISTINCT from `hiddenGroups`. These codes are removed from the
   *  LEGEND ITEM LIST (on-plot + export) but their points/shape STILL RENDER. Set only from the edit
   *  form (an eye toggle per row). To hide a group's points AND its legend entry, put its code in BOTH
   *  sets. Absent/empty ⇒ every entry listed. */
  legendHiddenCodes?: number[]
  /** LINK FILTERING (transient, NOT persisted): value-window filters this cell's link group imposes — a
   *  grouped chart re-computes its stats/shape from only the points whose value in `column` is within
   *  `range`; a dense scatter drops out-of-range points. Set by GridWorkspace's `cellsForView`. */
  linkValueFilters?: readonly { readonly column: string; readonly range: readonly [number, number] }[]
  /** CONTINUOUS legend: render the visual-map using the CUSTOM [lo,hi] range as the FULL gradient
   *  (domain = the range, no sub-band outline) instead of showing the range as a band inside the full
   *  domain — so a published plot with a custom range doesn't look "custom". Absent/false ⇒ full domain
   *  with the range shown as a band. Only meaningful when a per-cell visual-map range is set. */
  legendUseRange?: boolean
  /** Editable per-cell LEGEND title (the color/group legend header). Absent ⇒ the legend defaults to the
   *  colorBy / group column name. Edited in the pane form; folded into the WYSIWYG legend + export. */
  legendTitle?: string
  /** WHICH CORNER the legend/visual-map sits in (edit-form control). Drives both the on-screen wrapper
   *  position AND the legend's own internal mirror (label faces into the plot). Absent ⇒ 'tr' (top-right,
   *  the historical position). */
  legendCorner?: LegendCorner
  /** Legend layout mode: `true` = BESIDE the plot in a reserved vertical side gutter (the plot area
   *  shrinks horizontally to make room); `false`/absent = OVERLAY (floats over the plot, full plot area).
   *  Edited in the pane form; applied on-screen (deck view inset) + in export (WYSIWYG). */
  legendBeside?: boolean
  /** MATRIX charts (heatmap / dotplot): the continuous VALUE colormap for the cell/dot fill scale (the
   *  matrix analog of a scatter's `colorBy.colormap`). Absent ⇒ the view's built-in default (heatmap:
   *  z-score→magma else viridis; dotplot: viridis). Edited in the pane form's Color section; drives the
   *  on-plot value colorbar + export. */
  valueColormap?: ContinuousColormap
  /** Per-cell TYPOGRAPHY (publication figures): a figure-wide font family + base size plus optional
   *  per-element (title/axis/tick/legend) overrides. Absent ⇒ built-in defaults (byte-identical). Edited
   *  in the pane form; applied to the plot title / axis titles / legend / chart-frame text + export. */
  typography?: Typography
  /**
   * CONTROLLED close (Phase 3): when `true`, the cell's close X does NOT call `removeCell` — it emits a
   * `cell-close` event so the APP owns removal (a state-derived cell must not be closed imperatively, or
   * it reopens on the next render). Stamped by `parseOption` from `series.controlled`. Travels WITH the
   * cell's content on a swap (it follows the derived series, like the capability flags). Absent ⇒ the
   * built-in remove (byte-identical).
   */
  controlled?: boolean
  /**
   * WHY the user cannot remove this cell — present ⇒ its Close is UNAVAILABLE, and this string is
   * the reason shown to them. Absent ⇒ removable, byte-identical to today.
   *
   * ONE field, deliberately, rather than `removable: boolean` plus a separate reason. Two fields can
   * disagree, and `removable: false` with no reason is the exact defect this exists to remove: a
   * dead affordance that says nothing. Here "cannot be removed" and "here is why" are the SAME fact,
   * so a host cannot state one without the other, and every blocked close explains itself.
   *
   * It gates the USER GESTURE only. `VizController.removeCell` / `dispatch({type:'removePane'})` are
   * how the owner of the state behind a cell removes it, and they keep working — the whole point of
   * a blocked close is to send the user at the state instead of at the pane.
   *
   * Stamped by `parseOption` from `series.removeBlockedReason`; travels WITH the cell's content on a
   * swap (it is a property of the derived series, exactly like `controlled`) — otherwise dragging a
   * blocked cell onto another would launder it into a closable one.
   */
  removeBlockedReason?: string
  /**
   * A PROVENANCE MARKER the host stamped on this cell (`series.provenanceNote`) — rendered as a
   * persistent chrome badge and as a line under the categorical legend.
   *
   * It travels WITH the cell's CONTENT on a swap, exactly like `removeBlockedReason`: the mark is
   * a fact about the data the cell draws, so dragging a marked cell onto another must not launder
   * the mark off it (nor stamp it onto content it is not about).
   */
  provenanceNote?: string
  /**
   * Resolved per-series encode bindings threaded from the DECLARATIVE controller
   * (`VizController.setOption`), keyed by this cell's chart-type `bindingSchema` channel
   * ids. When present, `CellView` passes it to the descriptor's model as a per-channel
   * OVERRIDE over the catalog defaults, so a `series.encode` (heatmap `valueKeys`, violin
   * `valueKey`/`groupKey`, …) actually reaches render instead of being discarded. Absent
   * ⇒ the imperative / default path (catalog defaults) — full back-compat.
   */
  bindings?: ResolvedBindings
  /**
   * Every column pick this cell has held, keyed by the channel VOCABULARY it was picked for —
   * `` `${channelId}:${channelSource}` `` — so a kind switch can PARK a binding the target cannot
   * express and restore it on the way back.
   *
   * `bindings` alone could not do that. A switch to a chart whose channels are a different
   * vocabulary (violin's `value:'value'` → histogram's `value:'continuous'`) must CLEAR the active
   * binding, or a value column would ride onto a continuous channel. Clearing was implemented as
   * FORGETTING, so returning to the original kind re-resolved the catalog default and painted a
   * different column — reported live as "switch violin → box → back and the axis becomes 0–50K".
   * Remembering by vocabulary keeps both properties: no wrong-kind carry, no silent re-pick.
   *
   * Never read by render — `CellView` reads `bindings`. Absent ⇒ a cell that has never held an
   * explicit binding (byte-identical to before).
   */
  bindingMemo?: Readonly<Record<string, string | readonly string[]>>
  /**
   * The AUTHOR-DECLARED set of chart types this cell's kind switcher may offer (the explicit
   * allowed alternatives, from a declarative `series.switchTo`). When present it takes PRECEDENCE
   * over the auto-inferred `compatibleChartTypes(...)` set in the chrome (explicit wins); absent
   * ⇒ the chrome auto-infers the compatible set from binding-schema compatibility against the
   * dataset (full back-compat). Each entry is a registered, data-compatible chart type (validated
   * at parse time). Travels WITH the cell's display fields on a content swap.
   */
  switchTo?: readonly string[]
  /**
   * OPT-IN per-plot animated-transition config (default OFF when absent), threaded from a
   * declarative `series.transitions`. When present on an AGGREGATED chart cell (bar/box/violin/
   * dotplot/histogram), `CellView`'s adapter passes it to the View, which spreads a deck.gl
   * `transitions` prop so a recolor / data change GPU-interpolates instead of snapping. Absent ⇒
   * instant (byte-identical). Ignored by the dense (scatter) + heatmap kinds. Travels WITH the
   * cell's display fields on a content swap.
   */
  transitions?: TransitionConfig
  /**
   * RENDER-INJECTED (not persisted, not swapped): the per-GROUP color/label override bundle for a
   * GROUPED chart cell (box/violin/bar/dotplot/heatmap), resolved by `GridWorkspace` from the
   * `colorOverride` store keyed by the cell's group column. The grouped adapters' `cellOverrides`
   * reads this so the edit form's per-group recolor/rename reaches render (the grouped analog of the
   * dense `withColorOverrides` path). Absent ⇒ no group overrides (byte-identical to today).
   */
  groupOverrides?: CategoricalOverrides
}

/**
 * Swap the CONTENT of two cells (drag-to-swap, ITEM-70). Trades the display fields
 * (`kind`, `colorBy`, `linkColorScale`, `graphOverlay`, `bindings`, `bindingMemo`, `switchTo`, `transitions`) between `a` and `b` while
 * KEEPING each cell's identity + slot (`id`, `layoutId`) — so the two cells trade
 * what they display, not their position in the split-tree. PURE (no React / no
 * store), so it is unit-testable in node. Returns the two rebuilt cells in the same
 * order `[a', b']`. Swapping a cell with itself yields an identical clone (idempotent
 * no-op at the field level); the store guards `idA === idB` before calling this.
 */
export function swapCellContent(a: GridCell, b: GridCell): [GridCell, GridCell] {
  const aNext: GridCell = {
    ...a,
    kind: b.kind,
    colorBy: b.colorBy,
    linkColorScale: b.linkColorScale,
    graphOverlay: b.graphOverlay,
    // bindings + the declared switch set are keyed by the chart-type, so they travel WITH `kind`.
    // The parked picks are the same content (they exist to restore `bindings` on a kind switch), so
    // leaving them behind would let a swapped cell restore the OTHER cell's columns.
    bindings: b.bindings,
    bindingMemo: b.bindingMemo,
    switchTo: b.switchTo,
    transitions: b.transitions,
    // Capability flags are chart-type-keyed, so they travel WITH `kind` on a content swap.
    consumesSelection: b.consumesSelection,
    producesSelection: b.producesSelection,
    dataZoomAxes: b.dataZoomAxes,
    linkableColorScale: b.linkableColorScale,
    controlled: b.controlled,
    removeBlockedReason: b.removeBlockedReason,
    provenanceNote: b.provenanceNote,
  }
  const bNext: GridCell = {
    ...b,
    kind: a.kind,
    colorBy: a.colorBy,
    linkColorScale: a.linkColorScale,
    graphOverlay: a.graphOverlay,
    bindings: a.bindings,
    bindingMemo: a.bindingMemo,
    switchTo: a.switchTo,
    transitions: a.transitions,
    consumesSelection: a.consumesSelection,
    producesSelection: a.producesSelection,
    dataZoomAxes: a.dataZoomAxes,
    linkableColorScale: a.linkableColorScale,
    controlled: a.controlled,
    removeBlockedReason: a.removeBlockedReason,
    provenanceNote: a.provenanceNote,
  }
  return [aNext, bNext]
}

/**
 * The id a READER addresses this cell by — the authored id when a host composed the grid, the
 * cell's own id otherwise.
 *
 * There are two identities and they are not interchangeable. The grid's key (`id`) has to be unique
 * across everything on the surface, so a host folding several declarations onto one grid namespaces
 * it; that key is an internal artefact of the fold. What a reader — a spec, a screenshot diff, a
 * person — addresses is the pane the DECLARATION named. Deriving the DOM identity here, once, is
 * what keeps the fold's key out of every `data-testid` the grid emits.
 *
 * PURE. `cell.localId` is absent for every un-composed caller, so this is `cell.id` and their DOM
 * is byte-identical to before it existed.
 */
export function cellTestId(cell: Pick<GridCell, 'id' | 'localId'>): string {
  return cell.localId ?? cell.id
}

/**
 * The same identity, for the callers that hold a GRID KEY rather than the cell.
 *
 * Several chrome loops iterate something keyed by the grid's own id — a measured `PaneRect`, a
 * link group's member list, the split tree's leaf nodes — and never touch the cell itself. Each
 * of them stamped that key straight into a `data-testid`, which is the same leak `cellTestId`
 * closes one layer up, just reached by a different route. Resolving the key through the cell map
 * here keeps ONE rule for "what a reader addresses" instead of one per loop.
 *
 * A key the map does not hold falls back to the key: the cell is mid-teardown or the caller is
 * un-composed, and in both cases the key IS what the DOM said before.
 */
export function paneTestId(
  cells: Readonly<Record<string, Pick<GridCell, 'id' | 'localId'> | undefined>>,
  id: string,
): string {
  return cellTestId(cells[id] ?? { id })
}

/**
 * The reason this cell's Close is unavailable, NORMALIZED — `undefined` when the cell is removable.
 *
 * The normalization is the whole substance of the function, not tidiness: a blank or whitespace-only
 * `removeBlockedReason` would mean "blocked, with nothing to say", which is the mute dead-end the
 * single-field shape exists to make unrepresentable. Blank therefore reads as REMOVABLE, so the
 * invariant "a blocked close always carries a reason" holds for every value a host can write, not
 * only for the values a careful host writes.
 *
 * PURE (no React, no store), and it is read in exactly ONE place — `PaneToolbar`, which is where the
 * user meets the affordance and the only consumer of the remove callback. A second re-reading
 * elsewhere is how a disabled-looking button keeps a live handler, so there deliberately isn't one.
 */
export function paneRemoveBlockedReason(cell: Pick<GridCell, 'removeBlockedReason'>): string | undefined {
  const reason = cell.removeBlockedReason
  if (typeof reason !== 'string') return undefined
  const trimmed = reason.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The COORDINATE-SPACE key a dense cell lives in — the axis link-zoom is scoped by
 * (the embedding-blind-zoom fix). Two dense cells share zoom-linking IFF they return
 * the SAME key here; cells in different spaces NEVER zoom-sync (a shared `{target,
 * zoom}` is only meaningful within one 2-D coordinate space).
 *
 *  - A scatter (embedding) cell's space is its embedding / layout id, so two scatters
 *    over the SAME layout (e.g. small multiples colored differently) share a space and
 *    two scatters over DIFFERENT layouts do not.
 *  - An `image` / spatial cell lives in its OWN space (pixel / physical coords), keyed
 *    with a distinct prefix so it can NEVER collide with an embedding at the same
 *    layout id.
 *
 * PURE (no React / no deck), so it is unit-testable in node. Domain-agnostic (DEC-28):
 * `embedding` / `image` are coordinate-space categories, not biology.
 */
export function cellSpaceKey(cell: Pick<GridCell, 'kind' | 'layoutId' | 'datasetId'>): string {
  const base = cell.kind === 'image' ? `image:${cell.layoutId}` : `embedding:${cell.layoutId}`
  // MULTI-DATASOURCE (ITEM-20): fold the datasetId into the space key so two cells at the SAME
  // layout over DIFFERENT datasets never share a link-zoom camera / selection space. Absent ⇒ the
  // base key, unchanged (single-dataset byte-identical).
  return cell.datasetId ? `${cell.datasetId}:${base}` : base
}

/** Local layer name for a cell's scatter layer (kept as a constant so the store,
 *  component, and router agree on the exact string). */
export const SCATTER_LAYER_NAME = 'scatter'

/**
 * The prefixed scatter-layer id for a cell — `<cellId>::scatter` — so
 * `makeLayerFilter` routes it to that cell's viewport and nowhere else (DEC-20).
 */
export function cellScatterLayerId(cellId: string): string {
  return cellLayerId(cellId, SCATTER_LAYER_NAME)
}

// ── MOVED to `../spatial/channelState` (#288) ─────────────────────────────────────────────
//
// Four generic `RasterChannelState` helpers — a channel count, a seed, a reconciliation and a
// dtype bound — with nothing grid-specific in them. They now live in a LEAF module beside the
// type they describe, and `channelState.ts` records why it is a leaf rather than living in
// either this file or `rasterImageLayers.ts`: each of those two placements puts the other
// side's dependencies on this file's value graph, and the header at the top of THIS file is a
// measured statement that that must not happen (`layers/layerIds.ts` costs it at +29.1 kB gzip
// on the preloaded critical path). `channelState.ts` imports one TYPE and nothing else.
//
// RE-EXPORTED from here because importers read them off this module and a rename is not what
// this change is. As of now those are `useGridRaster` (`contrastMaxForDtype`,
// `reconcileChannelsToLoader`) and `grid.test.ts` (`contrastMaxForDtype`,
// `seedChannelsForLoader`) — an earlier version of this note also listed `useGridDeckInputs`,
// whose only such import this branch removed, and `GridWorkspace`, which stopped importing them
// at SPLIT N and says so in its own header. A justification that names files which do not
// participate is the failure this package's stale-claim guard exists for, one directory over.
// `channelCountOfLoader` is NOT in this list, and its absence is the rule above being applied
// rather than an omission: nothing in the repo imports it from here. It is defined in
// `spatial/channelState.ts`, RE-EXPORTED by `spatial/rasterImageLayers.ts` (which does not
// itself call it), and imported by `spatial/rasterImageLayers.test.ts` off that re-export.
// Neither package barrel has ever exported it.
export {
  contrastMaxForDtype,
  reconcileChannelsToLoader,
  seedChannelsForLoader,
} from '../spatial/channelState'

/**
 * The cell configs for the tree's leaves, in visual (left→right, top→bottom)
 * order. A leaf with no matching config is dropped (defensive — the store keeps
 * `cells` in lockstep with the tree, so in practice every leaf has a config).
 */
export function orderedCells(
  layout: LayoutNode,
  cells: Record<string, GridCell>,
): GridCell[] {
  const out: GridCell[] = []
  for (const id of leafIds(layout)) {
    const c = cells[id]
    if (c) out.push(c)
  }
  return out
}

/**
 * Build the layer→cell routing map deck.gl's `layerFilter` consumes: each cell's
 * scatter layer id maps to that cell's id, so the shared single-Deck renders every
 * cell's layer ONLY into its own view (DEC-20). Feed the result to
 * `makeLayerFilter`.
 */
export function buildLayerCellMap(cellIds: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const id of cellIds) map[cellScatterLayerId(id)] = id
  return map
}

/** One dense cell's continuous/value color domain + whether it opts into the
 *  shared (linked) color scale (Phase C3b / ITEM-64). Categorical cells carry no
 *  numeric domain and are never passed here. */
export interface CellColorDomain {
  id: string
  /** The value/continuous column the cell colors by (the coordination axis). */
  key: string
  /** The cell's own auto-detected numeric domain `[min, max]` (post-scale). */
  domain: [number, number]
  /** True when the cell opts into the shared linked color scale. */
  linked: boolean
}

/**
 * Resolve each cell's EFFECTIVE color domain (Phase C3b / ITEM-64 made real in the
 * grid). A cell that opts into the linked scale (`linked`) maps to the UNION of every
 * linked cell's domain that shares its `key`, so identical values render as identical
 * colors across those cells. An unlinked cell keeps its own domain — even when a
 * sibling links the same key. PURE (no React / no I/O), so the union math is
 * unit-testable in node; it reuses the coordination `resolveSharedDomain` helper.
 */
export function resolveLinkedCellDomains(
  cells: readonly CellColorDomain[],
): Record<string, [number, number]> {
  // Only linked cells contribute to (and read from) the shared union.
  const linkedScopes: ColorScaleScope[] = cells
    .filter(c => c.linked)
    .map(c => ({ key: c.key, domain: c.domain, colormap: 'viridis' }))
  const out: Record<string, [number, number]> = {}
  for (const c of cells) {
    out[c.id] = c.linked
      ? (resolveSharedDomain(linkedScopes, c.key) ?? c.domain)
      : c.domain
  }
  return out
}

/**
 * ITEM-5 (declarative capability enforcement) on the DENSE path. A dense scatter/image cell is the
 * PRIMARY selection participant (it renders on the shared deck, not through a chart View), so the
 * `consumesSelection`/`producesSelection` flags `parseOption` stamps onto it must be honored HERE too
 * (the chart Views honor them via `capabilityGates`). Both default to TRUE when the flag is unset, so a
 * cell that declares no capability is byte-identical to before. A cell that does NOT consume ignores the
 * shared selection (no dim/highlight); a cell that does NOT produce publishes nothing on a lasso/rect.
 */
export function cellConsumesSelection(cell: Pick<GridCell, 'consumesSelection'>): boolean {
  return cell.consumesSelection !== false
}
export function cellProducesSelection(cell: Pick<GridCell, 'producesSelection'>): boolean {
  return cell.producesSelection !== false
}

/**
 * MD-9: the shared-color-scale link key, SCOPED BY DATASET. Two cells coloring by the same column
 * NAME over DIFFERENT datasets are unrelated series, so their domains must NOT union — prefixing the
 * key with the (possibly empty) dataset id keeps same-dataset (incl. all-default, empty-prefix) cells
 * linking exactly as the bare key did before multi-datasource. Pure/deterministic.
 */
export function datasetLinkKey(datasetId: string | null | undefined, key: string): string {
  return `${datasetId ?? ''}::${key}`
}

/**
 * MD-9: the DataSource a per-cell colorBy fetches its column from — the cell's OWN dataset source
 * (looked up by `datasetId`) for a multi-dataset cell, else the workspace `defaultSource` for a
 * default cell. A datasetId whose entry isn't resolved yet returns `null` (the caller skips it and
 * recolors on the ready transition). Generic over the source type so `gridModel` needs no DataSource
 * import; pure.
 */
export function sourceForCell<S>(
  datasetId: string | null | undefined,
  defaultSource: S,
  lookup: (id: string) => S | null | undefined,
): S | null {
  if (!datasetId) return defaultSource
  return lookup(datasetId) ?? null
}

/**
 * #228: the CATALOG a cell's declared FRAME is read from — the cell's OWN dataset catalog for a
 * multi-dataset cell, else the workspace `defaultCatalog`. The exact twin of `sourceForCell`, and
 * it is a separate function rather than a second use of that one because the two answer different
 * questions about the same cell and a caller must not be able to pair one dataset's catalog with
 * another's source.
 *
 * Getting this wrong is the multi-dataset shape of the bug #228 exists to close: a cell reading
 * the DEFAULT dataset's coordinate_space while rendering ITS OWN dataset's raster would bind two
 * artifacts that were never in one frame, and the overlay would be plausible and wrong. A
 * datasetId whose entry has not resolved yet returns `null`, and an unresolved frame is a refusal
 * (nothing is drawn) rather than a guess.
 *
 * Generic over the catalog type so `gridModel` needs no `DatasetStore` import; pure.
 */
export function catalogForCell<C>(
  datasetId: string | null | undefined,
  defaultCatalog: C,
  lookup: (id: string) => C | null | undefined,
): C | null {
  if (!datasetId) return defaultCatalog
  return lookup(datasetId) ?? null
}

/**
 * #228: THE LAYOUT A CELL ACTUALLY DRAWS — which is not always the one it declares, and the
 * difference is the whole reason this function exists.
 *
 * ── THE TRAP, MEASURED ON THE PRODUCTION PATH ─────────────────────────────────────────────────
 * A cell minted by the grid STORE carries the sentinel `layoutId: 'primary'`
 * (`GridWorkspace.store.ts`'s `DEFAULT_LAYOUT_ID`, commented "the fixture's primary layout"), and
 * the production canvas mounts `<GridWorkspace source>` with NO option, so nothing ever
 * reconciles it. Meanwhile a host `DataSource` keys its layouts by ARTIFACT ID, and the owned
 * pull reads `catalog.layouts[0]` regardless of what the cell says. So:
 *
 *   * resolving a frame by `cell.layoutId` finds NOTHING on every real project — a permanent,
 *     silent refusal that looks exactly like two artifacts being in different spaces;
 *   * and where the cell's id DOES resolve (a declarative `<Viz option>` with `encode.layout`
 *     naming a second layout), a DEFAULT cell still paints `layouts[0]`'s positions — so the
 *     frame would be decided from one artifact while the points came from another. That is a
 *     UMAP drawn on tissue with no producer error anywhere.
 *
 * The rule that makes both impossible is to bind on what is DRAWN:
 *
 *   * a MULTI-DATASET cell reads `positionsByLayout[cell.layoutId]`, so its declared id IS the
 *     drawn one;
 *   * a DEFAULT cell whose buffers the workspace OWNS paints its declared layout when the catalog
 *     actually has it, and otherwise the same first-of-N the owned pull used;
 *   * a DEFAULT cell whose buffers the CALLER passed (`positions` — the `@internal` gallery/test
 *     path) paints numbers no catalog describes, so the cell's own declaration is all there is.
 *
 * Pure; `gridModel` needs no catalog import beyond the shape it already has.
 */
export function layoutDrawnBy(
  cell: Pick<GridCell, 'datasetId' | 'layoutId'>,
  catalog: { readonly layouts: readonly { readonly id: string }[] } | null | undefined,
  /**
   * the layout the workspace's OWNED pull actually read (`OwnedData.layoutId`), or `null` when
   * the caller supplied the buffers and no layout was read at all.
   *
   * Passed in rather than re-derived. The pull's own choice is a documented first-of-N guess
   * recorded where it is made; reproducing it here would be a SECOND copy of that guess, and two
   * copies of a guess are how they come to disagree — which for this function means binding a
   * frame from one artifact while the pane paints another's positions.
   */
  ownedLayoutId: string | null,
): string {
  if (cell.datasetId) return cell.layoutId
  if (ownedLayoutId === null) return cell.layoutId
  // NO "the declared id wins when the catalog has it" branch, and a blind audit is why. For a
  // DEFAULT cell `cellData` returns the WORKSPACE buffers, which `pullOwnedData` read from ONE
  // layout without ever consulting `cell.layoutId` — so a cell whose `encode.layout` names a
  // different, perfectly real catalog layout would have bound the frame to artifact B while the
  // pane painted artifact A's positions. That is the "UMAP drawn on tissue" this function's
  // header says it makes impossible, and the first cut of it left the hole open.
  //
  // Honouring a declared layout for a default cell is a REAL feature and this is not it: it
  // requires the owned pull to read that layout, which is `useGridData`'s job, not this one's.
  // Until it does, the honest answer is the id the positions actually came from.
  return ownedLayoutId
}

/**
 * #228: the pyramid an IMAGE cell actually renders from — a caller-supplied `cell.loader` first,
 * else the per-cell fetch, and `null` when neither has resolved a usable one.
 *
 * ONE rule in ONE place because two readers ask the question and they must not disagree: the emit
 * chooses its render path by it, and the camera-framing effect chooses WHICH AFFINE to frame by
 * (the full-resolution `to_space` for the tiled path, the served level's own for the single
 * texture). A cell with a caller-supplied `loader` and no fetched entry made the two disagree —
 * the raster drawn 5x-placed by `to_space` while the camera framed the level's box, or no camera
 * seeded at all.
 */
export function effectiveLoaderFor(
  cell: Pick<GridCell, 'loader'>,
  entry: PyramidEntry | 'loading' | null | undefined,
): PixelSource<ChannelLabels>[] | null {
  const resolved = entry && entry !== 'loading' ? entry : null
  const loader = cell.loader ?? resolved?.loader
  return loader && loader.length > 0 ? loader : null
}

/**
 * #228: does this IMAGE pane have a raster it can actually DRAW?
 *
 * The tiled path needs a loader; the single-texture path needs a resolved underlay AND a usable
 * served-level placement. Extracted because TWO modules must agree on it and they may not import
 * each other (INV-10 (d)): the emit uses it to decide whether to draw anything at all, and the
 * refusal reporter uses it to decide whether a mute pane needs explaining. Written twice, they
 * would drift, and the drift would be a pane that says nothing about why it is empty.
 *
 * `'loading'` is NOT "no raster" — it is "not yet", and a pane mid-fetch has nothing to explain.
 */
export function paneRasterPresent(
  cell: Pick<GridCell, 'loader'>,
  pyramid: PyramidEntry | 'loading' | null | undefined,
  underlay: ImageEntry | 'loading' | null | undefined,
  levelPlacementRefused: boolean,
): boolean {
  if (effectiveLoaderFor(cell, pyramid) !== null) return true
  return underlay != null && underlay !== 'loading' && !levelPlacementRefused
}

/**
 * MD-8: fallback tooltip axis labels for a multi-dataset cell — name its x/y rows after the dataset's
 * catalog LAYOUT (e.g. "UMAP x" / "UMAP y") when the caller supplied no per-dataset labels. Absent
 * catalog/layout ⇒ `undefined` (the tooltip builder then defaults to plain 'x' / 'y'). Pure.
 */
export function datasetAxisLabels(
  catalog: DatasetCatalog | null | undefined,
  layoutId: string,
): { x: string; y: string } | undefined {
  const layout = catalog?.layouts.find(l => l.id === layoutId)
  if (!layout) return undefined
  return { x: `${layout.label} x`, y: `${layout.label} y` }
}

// ── SPLIT C (ITEM-17): the hidden-code helpers BOTH the shell and the dock layer read ─────────────
// `hiddenGroupSet` / `filterLegendEntries` / `EMPTY_HIDDEN` were module-level helpers in
// `GridWorkspace.tsx`. Split C moved ONE of their two call sites — the edit-form + export builders —
// into `GridDockLayer.tsx`, while the other — the in-cell legend loop — stays in the shell until
// Split D. Neither file may import the other's private module (INV-10 (d)), so they live here, in the
// grid's shared model module both already import. Pure; no react, no DOM.

/** Stable empty hidden-set for the in-cell Legend + the pane edit form. */
export const EMPTY_HIDDEN: ReadonlySet<number> = new Set<number>()

/** A grouped cell's persisted `hiddenGroups` (number[]) → the Set the InCellLegend consumes (or undefined). */
export function hiddenGroupSet(codes: number[] | undefined): ReadonlySet<number> | undefined {
  return codes && codes.length > 0 ? new Set(codes) : undefined
}

/** Drop LEGEND-hidden codes from a legend's entry LIST (their marks still render). No codes ⇒ same ref. */
export function filterLegendEntries<T extends { code: number }>(
  entries: readonly T[],
  legendHiddenCodes: number[] | undefined,
): readonly T[] {
  if (!legendHiddenCodes || legendHiddenCodes.length === 0) return entries
  const hidden = new Set(legendHiddenCodes)
  return entries.filter(e => !hidden.has(e.code))
}

// ── SPLIT H (ITEM-24): the three render-data TYPES the shell and the deck-input plane both name ───
// `CellRenderData` was a module-level interface in `GridWorkspace.tsx`; `ImageEntry` / `PyramidEntry`
// were type aliases declared INSIDE its body. Split H moved the `layers` memo — their largest
// reader — into `useGridDeckInputs.ts`, while the resolvers and the two fetch effects that produce
// them stay in the shell. Neither file may import the other (INV-10 (d)), so all three live here, in
// the grid's shared model module both already import. Types only; no react, no deck.gl.

/** A dense cell's resolved render buffers (from its dataset, or the workspace default). */
export interface CellRenderData {
  positions: Float32Array
  colors: Uint8Array
  colorEpoch: number
  pointIds: Uint32Array | null
  nPoints: number
  status: 'ready' | 'loading' | 'error'
}

/** An IMAGE cell's single-tile bitmap underlay, cached per cell ('loading' | entry | null). */
export type ImageEntry = { texture: BitmapTexture; width: number; height: number }

/** An IMAGE cell's gigapixel-capable Viv resolution PYRAMID + its live per-channel display state. */
export type PyramidEntry = {
  loader: PixelSource<['c']>[]
  channels: RasterChannelState[]
  colormap?: string
  contrastMax: number
}

/** The selection-overlay's imperative handle (SPLIT I / INV-10 (d)): declared here rather than in
 *  `GridOverlayLayer.tsx` because `useGridSelection` owns the ref that carries it and a hook may not
 *  import a layer. `GridOverlayLayer` re-exports it, so its importers are unaffected. */
export interface GridOverlayApi {
  /** Drop any in-progress draft (rect + polygon) and its gesture bookkeeping. */
  clearDrafts(): void
  /** Close the in-progress polygon ring so the NEXT polygon starts a fresh region (the rail's
   *  Finish). The ring is already committed live per vertex — this only clears the outline. */
  finishPolygon(): void
}

/** The imperative handle `GridDockLayer` publishes UPWARD (Split A / Split B's idiom). The export
 *  dialog's OPENERS live in `useGridWindows.ts` — a pane toolbar's Export button and the tool rail's
 *  whole-grid Export — while `exportTarget` lives in the dock layer, so they reach it through this
 *  handle rather than through a reactive prop that would put the state back in the shell.
 *
 *  Declared HERE rather than beside the component that implements it because a data-plane hook may
 *  not import a layer (INV-10 (d), DRIFT-43): `useGridWindows` owns the ref this types. Same move,
 *  same reason, as `GridOverlayApi` at Split I. */
/** deck's `onHover` payload, in the loose shape the shell already forwarded. Lives here, not in
 *  `GridOverlayLayer.tsx`, because `useGridHover` types its sink with it and a hook may not import a
 *  layer (INV-10 (d)). Same move, same reason, as `GridOverlayApi` (Split I), `GridDockApi` (Split M)
 *  and `CellDataResolved` (Split O) — the FOURTH time, which is why DRIFT-58 states the rule. */
export interface DeckHoverInfo {
  index: number
  x: number
  y: number
  layer?: { id?: string } | null
  viewport?: { id?: string } | null
}

export interface GridDockApi {
  /** Open the export dialog scoped to ONE pane. */
  openExportCell(cellId: string): void
  /** Open it scoped to the whole grid (`cellId: null`). */
  openExportGrid(): void
  /** Close it. */
  closeExport(): void
}

/** What `cellData(cell)` resolves: the per-cell buffers + point count + load status. Structural, so
 *  neither the seam nor a data plane has to import the resolver's implementation.
 *
 *  Declared HERE rather than in `GridWorkspaceContext.tsx` because the SEAM FILE IS A LAYER, and a
 *  data-plane hook may not import a layer (INV-10 (d)). `useGridA11y` borrows `cellDataRef` and has
 *  to type it. Same move, same reason, as `GridOverlayApi` (Split I) and `GridDockApi` (Split M). */
export interface CellDataResolved {
  positions: Float32Array
  colors: Uint8Array
  colorEpoch: number
  pointIds: Uint32Array | null
  nPoints: number
  status: string
}

/** The camera a cell starts at, before any pan/zoom. Declared here rather than in `GridDeckLayer`
 *  for the same INV-10 (d) reason: `useGridA11y`'s keyboard pan reads its `zoom` to size a
 *  world-units step, and a hook may not import a layer. */
export const INITIAL_VIEW_STATE: GridViewState = {
  target: [0, 0, 0] as [number, number, number],
  zoom: 4,
}
