// multiView.ts — ONE `Deck` + N `OrthographicView`s (DEC-20 / ITEM-22): a single
// WebGL context hosts many viewports, one per grid pane. These are PURE config
// builders (no GL context needed): constructing a `View` instance and shaping
// viewState / layerFilter is plain data, so the whole module is unit-testable in
// node. The canvas component feeds `buildViews()` into `<Deck views>`,
// `buildViewStates()` into `viewState`, and `makeLayerFilter()` into `layerFilter`.
//
// Generic, domain-agnostic naming (DEC-28): a "pane" is a rectangular grid slot,
// a "cell" is the logical view bound to it; nothing here knows about biology.

import { OrthographicView } from '@deck.gl/core'

/** A rectangular grid slot, positioned in device-independent PIXELS. Charts (chart2d/matrix2d)
 *  sharing the one deck carry per-pane render params that dense (world2d) panes leave at the
 *  defaults, so a single Deck can host heterogeneous coordinate regimes side by side. */
export interface PaneRect {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** Flip the view's Y axis. Default `false` (embedding/world convention); matrix charts
   *  (heatmap/dotplot) set `true` so row 0 is at the top. */
  flipY?: boolean
  /** Override the per-view controller for this pane. Default = `BuildViewsOptions.controller`.
   *  Matrix charts (window-framed) + value charts while their dataZoom drives the camera set
   *  `false` so the rail — not free pan/zoom — owns framing. */
  controller?: boolean
}

/** A view's zoom: a scalar (dense/embedding — equal aspect) OR a per-axis `[zoomX, zoomY]` (chart
 *  cells, whose x/y are unrelated units — category index vs value — so each axis fills independently).
 *  deck.gl `OrthographicView` accepts either per view. */
export type ViewZoom = number | [number, number]

/** The deck viewState for one cell's orthographic viewport. */
export interface CellViewState {
  target: [number, number]
  zoom: ViewZoom
}

/** The default viewState used for a pane that has no explicit state. */
export const DEFAULT_CELL_VIEW_STATE: CellViewState = {
  target: [0, 0],
  zoom: 0,
}

// The layer-id vocabulary lives in the deck-FREE `layerIds.ts` (see its header for the
// measured reason) and is re-exported here so every existing importer is unchanged.
// `cellOfLayer` + `layerBelongsToCell` are also used locally by the two routers below, hence
// the value import.
import { cellOfLayer, layerBelongsToCell, LAYER_ID_SEP } from './layerIds'
export { LAYER_ID_SEP, cellLayerId, cellOfLayer, layerBelongsToCell, localLayerName } from './layerIds'

/** Options controlling how the per-pane views are built. */
export interface BuildViewsOptions {
  /**
   * Give EACH view its own controller (default `true`). With multiple views a
   * single top-level `<Deck controller>` only drives ONE viewport, so wheel/drag
   * reaches just one pane; a per-`View` controller routes the gesture to the pane
   * under the cursor, making every side-by-side plot independently pan/zoomable.
   * FacetGrid opts OUT (`false`) because its facets deliberately share one
   * viewState with the controller disabled at the Deck level.
   */
  controller?: boolean
}

/**
 * Build one `OrthographicView` per pane (DEC-20): a single Deck holds all of
 * these, so there is ONE WebGL context regardless of pane count. Each view's
 * `id` is the pane id and it is positioned with the pane's pixel rect.
 *
 * By default each view carries its OWN `controller: true` so deck.gl routes a
 * wheel/drag gesture to the viewport under the cursor — without this, N views
 * behind a single top-level `<Deck controller>` leave only one pane interactive.
 */
export function buildViews(
  panes: PaneRect[],
  opts: BuildViewsOptions = {},
): OrthographicView[] {
  const defaultController = opts.controller ?? true
  return panes.map(
    pane =>
      new OrthographicView({
        id: pane.id,
        x: pane.x,
        y: pane.y,
        width: pane.width,
        height: pane.height,
        // Per-pane Y convention: dense/world panes keep math-plane up (false); matrix charts flip.
        flipY: pane.flipY ?? false,
        // Per-pane controller (falls back to the deck-wide default) so each pane zooms under the
        // cursor — matrix/value charts opt out so their dataZoom rail owns framing.
        controller: pane.controller ?? defaultController,
      }),
  )
}

/**
 * Build the per-view viewState map deck.gl consumes (`{ [viewId]: viewState }`).
 * Every pane gets an entry: its provided `CellViewState` if present, else the
 * default. Extra keys in `states` with no matching pane are ignored.
 */
export function buildViewStates(
  panes: PaneRect[],
  states: Record<string, CellViewState>,
): Record<string, { target: [number, number, number]; zoom: ViewZoom }> {
  const out: Record<string, { target: [number, number, number]; zoom: ViewZoom }> = {}
  for (const pane of panes) {
    const s = states[pane.id] ?? DEFAULT_CELL_VIEW_STATE
    out[pane.id] = { target: [s.target[0], s.target[1], 0], zoom: s.zoom }
  }
  return out
}

/**
 * Build a deck.gl `layerFilter`: a layer is drawn in a viewport only when its
 * owning cell matches that viewport's (view's) id — so a layer belonging to
 * cell A is NEVER rendered into cell B's viewport (DEC-20). The owner is looked
 * up in `layerCellMap` first; failing that, the layer is claimed by the viewport
 * whose id IS its `<cellId>::` prefix. A layer carrying no prefix at all has no
 * owner and is drawn in every view (a shared/global overlay), which is the safe
 * non-hiding default.
 *
 * ── WHY THE PREFIX IS TESTED AGAINST THE VIEWPORT, NOT PARSED OUT OF THE ID ─────────────────
 * `<cellId>::<layerName>` is a flat join of two ids, and BOTH halves may legitimately contain
 * the separator: a layer name can (`A::group::edges`, asserted in this module's test since it
 * was written) and — the case this fixes — so can a CELL id, because a host that composes
 * several declarations onto one grid namespaces every pane `<viewId>::<paneId>` so two
 * declarations cannot collide on the shared surface. Recovering the owner by parsing to the
 * FIRST separator therefore answered `<viewId>` for such a pane: a string that is no viewport
 * at all, so `owner === viewport.id` was false for EVERY view and the layer was drawn in NONE.
 * The pane rendered its chrome and its plot painted nothing — the empty violin the TxResBench
 * cell-filter surface shipped, with the dataset resolved and every row present behind it.
 *
 * Asking the viewport instead removes the ambiguity rather than moving it: there is no boundary
 * to guess, because the candidate owner is handed to us. For every un-composed id this is
 * exactly the old answer (a viewport id with no separator matches the prefix iff it equals the
 * parsed owner), which is why the existing routing tests are untouched.
 */
export function makeLayerFilter(
  layerCellMap: Record<string, string>,
): (params: { layer: { id: string }; viewport: { id: string } }) => boolean {
  return ({ layer, viewport }) => {
    // An entry that names no cell is not an entry: `undefined` and `''` are ONE concept here
    // ("the map claims nothing for this layer"), so both fall through to the id's own prefix.
    // Spelling them as two cases would split a distinction no caller can produce.
    const mapped = layerCellMap[layer.id]
    if (mapped) return mapped === viewport.id
    if (layerBelongsToCell(layer.id, viewport.id)) return true
    // No prefix at all ⇒ un-owned ⇒ a shared overlay drawn everywhere. A layer that IS prefixed
    // but not by this viewport belongs to another pane and stays out of it.
    return cellOfLayer(layer.id) === ''
  }
}

/** Which grid cell a shared-deck hover belongs to. Both halves may be absent at once. */
export interface GridHoverRoute {
  /** The MIGRATED-CHART cell under the pointer, whose `ChartContribution.onHover` gets the
   *  event (crosshair / texel tooltip). `null` ⇒ the pointer is not over a chart pane. */
  readonly chartCellId: string | null
  /** The DENSE cell whose own scatter layer was picked, whose dataset columns the point
   *  tooltip reads. `''` ⇒ no scatter point under the pointer. */
  readonly scatterCellId: string
}

/** The shape of deck's hover info this router reads. Structural, so a test needs no deck. */
export interface GridHoverInfo {
  readonly layer?: { readonly id?: string } | null
  readonly index?: number
  readonly viewport?: { readonly id?: string } | null
}

/**
 * Route one shared-deck hover to the cell that owns it.
 *
 * ── THE SIBLING OF `makeLayerFilter`, AND WHY THEY LIVE TOGETHER ─────────────────────────────
 * These two are halves of ONE invariant. `makeLayerFilter` decides where a layer DRAWS;
 * this decides where a hover over it GOES. If they disagree, a pane paints a plot the
 * pointer cannot touch — so they are kept adjacent and both resolve ownership the same way.
 *
 * ── THE OWNER IS ASKED FOR, NEVER PARSED ─────────────────────────────────────────────────────
 * Deck hands us the candidate: `info.viewport` is the view the pointer is inside, and the
 * grid builds exactly one view per pane keyed by the pane's id (`buildViews`). So the cell
 * under the pointer IS `info.viewport.id` — there is no boundary to guess.
 *
 * `GridOverlayLayer`'s two `onDeckHover` sites used to recover it from the picked layer id
 * instead, as the text before the FIRST `::`. On a COMPOSED canvas — a host folding several
 * declarations onto one grid namespaces every pane `<viewId>::<paneId>` — the layer
 * `cell.filter::before-violin-0::violin-kde` parsed to `cell.filter`, which is no cell, and:
 *   · the CHART site had a `|| info.viewport?.id` fallback that the parse's truthy-but-wrong
 *     answer short-circuited past, so the chart pane silently received no hover at all: no
 *     crosshair, no texel tooltip, and the previously-hovered chart got a spurious clear;
 *   · the SCATTER site had no fallback, so the picked point resolved to a cell id the grid
 *     does not hold and the tooltip + cross-plot highlight were dropped.
 * Two symptoms, one cause — which is why only one of them would ever get reported.
 *
 * The layer is still consulted, but only to ask the viewport a yes/no question
 * (`layerBelongsToCell`), never to name an owner. For an un-composed id the answer is
 * identical to the old parse, because `makeLayerFilter` already guarantees a prefixed layer
 * is only drawn — and therefore only picked — in the viewport that owns it.
 */
export function routeGridHover(
  info: GridHoverInfo | null | undefined,
  chartDeckIds: ReadonlySet<string>,
  scatterLayerName: string,
): GridHoverRoute {
  const cellId = typeof info?.viewport?.id === 'string' ? info.viewport.id : ''
  // A CHART pane owns the whole hover, picked layer or not: its crosshair has to follow the
  // pointer across the plot's empty background too, which is the case that has no layer.
  if (chartDeckIds.has(cellId)) return { chartCellId: cellId, scatterCellId: '' }

  const layerId = typeof info?.layer?.id === 'string' ? info.layer.id : ''
  // A DENSE point tooltip needs a real pick, and the picked index is an offset into THIS
  // cell's own layer buffer — so the layer must actually be this cell's, not merely present.
  const isScatterPick =
    (info?.index ?? -1) >= 0 &&
    layerId.endsWith(`${LAYER_ID_SEP}${scatterLayerName}`) &&
    layerBelongsToCell(layerId, cellId)
  return { chartCellId: null, scatterCellId: isScatterPick ? cellId : '' }
}
