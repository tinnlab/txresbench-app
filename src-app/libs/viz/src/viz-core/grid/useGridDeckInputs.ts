// useGridDeckInputs.ts — SPLIT H (ITEM-24): the grid's DECK LAYER INPUTS.
//
// Everything the ONE <DeckGL> is handed, moved verbatim out of `GridWorkspace`: the per-cell
// `views` + the `layerFilter` that routes each cell's layers into its own view, the per-cell scatter
// `layers` memo (the biggest single declaration in the file), the graph-overlay geometry it splices
// in, the committed-selection outline / data-table hover-highlight / migrated-chart / label-mask
// layer builders, the `deckLayersBefore` assembly, and the `cellsForView` enrichment the pane layer
// consumes. It renders nothing and mounts nothing, so INV-10 (a) still names exactly five layer
// files and INV-10 (d)'s layer-pair matrix is untouched (this module imports no layer, no layer
// imports it, and it imports no other hook).
//
// SHAPE — it RETURNS a bundle, and unlike Split F that is not a compromise but the only correct
// choice (DRIFT-32's rule, applied with its premise checked rather than its conclusion copied). A
// store-backed shape would have to WRITE `layers` from an effect, i.e. one extra render pass per
// hover and per camera-driven rebuild; TEST-P1/P5 measure exactly that, and DEC-20 bans a
// per-frame-changing value in the ITEM-14 seam for the same reason. Deck props are derivations, not
// state: the shell threads five values into `<GridDeckLayer>` / `<GridPaneLayer>` and that is the
// cheapest possible boundary.
//
// Writer-set completeness (HAZARD 1): every declaration moved here is a `useMemo` — a pure
// derivation with NO writers at all, and no `window`/store/prop escape. `HOVER_HIGHLIGHT_RGBA` was a
// module const with exactly one reader, which moved with it. `tsc` is therefore a complete backstop
// for this split, and the claim is checkable: the split moves no `useState`, no `useRef` and no
// effect.
import { useMemo } from 'react'
import type { Layer } from '@deck.gl/core'
import { Matrix4 } from '@math.gl/core'
import { ScatterplotLayer, LineLayer, TextLayer, BitmapLayer } from '@deck.gl/layers'
import { SelectableScatterLayer } from '../gpu/ColormapScatterLayer'
import { buildViews, cellLayerId, makeLayerFilter, type PaneRect } from '../layers/multiView'
import { buildGraphOverlay } from '../overlays/graphOverlay'
import type { GraphData } from '../data/wire'
import { buildScatterProps } from '../layers/scatter'
import {
  buildLayerCellMap,
  cellConsumesSelection,
  cellScatterLayerId,
  effectiveLoaderFor,
  paneRasterPresent,
  type CellRenderData,
  type GridCell,
  type ImageEntry,
  type LabelMaskData,
  type PyramidEntry,
} from './gridModel'
import { buildRasterImageLayers } from '../spatial/rasterImageLayers'
import { overlayRefusal, type PaneFrame } from '../spatial/coordinateBinding'
import {
  DIM_OPACITY,
  hasAnySelection,
  highlightMaskForIds,
  highlightMaskForPoints,
  type IdToRow,
  selectionAttribute,
} from '../coordination/selectionSync'
import { buildSelectionOutlineLayer } from '../selection/useAreaSelection'
import { controllerAreasToShapes } from '../selection/areaGestures'
import type { Area } from '../selection/SelectionController'
import { buildLabelMaskLayers } from '../spatial/buildLabelMaskLayers'
import { overridesForColumn } from '../../adapter/colorOverride.store'
import type { CategoricalOverrides, ContinuousColormap } from '../data/color'
import type { CellColors, CellLegend } from '../../adapter/CellDisplay.store'
import type { ChartContribution } from './chartLayerSink'
import type { MaskCellReview } from '../annotate/maskDock'
import type { SharedLabelMask } from '../annotate/sharedMask'
import type { SharedMaskController } from '../annotate/sharedMaskController'
import { DEFAULT_SELECTION_SPACE, type SpaceSelection } from '../../adapter/Coordination.store'

/** The ring drawn at a data-table-hovered row's point (dense scatter). Moved with its only reader. */
const HOVER_HIGHLIGHT_RGBA: [number, number, number, number] = [255, 138, 0, 255]

/**
 * The WYSIWYG value-range filter (ITEM-11), extracted PURE (ITEM-41 legs (b)/(c), granted file 10,
 * DRIFT-1.50). Behaviour is byte-identical to the loop that used to sit inline in `layers` — this
 * is an extraction, not a change — and it is out here because it is the ONE place on the grid path
 * where a PARTIAL buffer and a COMPLETE buffer are indexed against each other, which is precisely
 * INV-10's restated hazard and something no assertion could reach while it lived inside a hook.
 *
 * ── THE MIXED-ARRIVAL CONTRACT, WHICH IS WHAT MAKES THIS CORRECT ────────────────────────────────
 *
 * `nPoints` comes from the PARTIAL positions buffer (`useGridData.ts`: `nPoints = pos.length / 2`),
 * while `legend.values` is the COMPLETE column and `colors` is the COMPLETE synthesized buffer
 * (ITEM-10 form (a), sized from `catalog.pointCount`). Indexing all three by the SAME `i` is only
 * sound because every published positions prefix is a STRICT PREFIX of the global row space with
 * row *i* meaning the same cell in every channel — the property `DatasetStore`'s progressive
 * publish guarantees and its own test pins. Row *i* must never mean two different cells: an
 * implementation that wrote batches at a local offset, or a values array shifted by any amount,
 * shades the right points with the WRONG colours and leaves a plausible picture with a clean
 * console. That is the failure this function is the seam for.
 *
 * The `values.length >= nPoints` guard is what keeps the PARTIAL case safe rather than merely
 * lucky: a complete column is always at least as long as an arrived prefix, so the filter applies
 * from the first batch; a values array SHORTER than the arrived rows (a stale legend from a
 * previous column) is refused wholesale rather than applied to the rows it happens to cover.
 *
 * Returns the UNTOUCHED buffer (identity, not a copy) whenever the range is not a strict sub-range
 * of the domain, so the no-filter path allocates nothing and the fill is not re-uploaded.
 */
export function applyValueRangeMask(input: {
  /** the cell's colour buffer — COMPLETE (RGBA per row of the whole row space). Never mutated. */
  readonly colors: Uint8Array
  /** how many rows have ARRIVED — taken from the partial positions buffer, not from the catalog. */
  readonly nPoints: number
  /** the colour epoch, which becomes the filter key when no range is active. */
  readonly epoch: number
  readonly legend: { values?: Float32Array; domain?: [number, number] } | undefined
  readonly range: readonly [number, number] | undefined
}): { colors: Uint8Array; filterKey: string | number } {
  const { colors, nPoints, epoch, legend, range } = input
  if (
    !legend?.values ||
    legend.values.length < nPoints ||
    !legend.domain ||
    !range ||
    (range[0] <= legend.domain[0] && range[1] >= legend.domain[1])
  ) {
    return { colors, filterKey: epoch }
  }
  const vals = legend.values
  const lo = range[0]
  const hi = range[1]
  const masked = colors.slice() // copy: never mutate the cached color buffer
  for (let i = 0; i < nPoints; i++) {
    const v = vals[i]
    if (v < lo || v > hi) masked[i * 4 + 3] = 0
  }
  // re-upload the fill on epoch OR range change
  return { colors: masked, filterKey: `${epoch}:${lo}:${hi}` }
}

/**
 * What an `image` cell draws (#228) — the PLACED raster, and whether this cell's points ride on
 * top of it.
 *
 * ── WHY THIS IS OUT HERE ────────────────────────────────────────────────────────────────────
 * The same reason `applyValueRangeMask` is: it is the one place on the grid path where a
 * PLACEMENT is decided, a wrong placement throws nothing and looks like a picture, and nothing
 * could assert it from inside a `useMemo`. #156's TEST-9 is the precedent that matters — a
 * deliberately wrong affine passed every check that system had, and its auditor's mutation
 * ("ignore the mapping, draw on an arbitrary lattice") left all 38 tests green because the
 * acceptance test watched the circle RADIUS instead of the spot POSITION. This function returns
 * the actual layer objects, so a test can read the `modelMatrix` that will reach the GPU.
 *
 * ── WHAT CHANGED, AND WHY #159's REFUSAL NO LONGER HOLDS ────────────────────────────────────
 * The image branch used to draw the raster at IDENTITY (world space == the image's own pixels)
 * and skip the point emit unconditionally, so an image cell drew a picture and nothing else.
 * That was deliberate, recorded as #159's DEC-2 with three reasons: there was no consumer for a
 * model matrix, applying one would have mis-framed every pane, and this repo twice refuses to
 * ship a capability with no consumer. All three are answered here — the camera moved to the
 * declared coordinate space (`useGridRaster`'s framing effect), so a placed raster is framed
 * correctly rather than mis-framed, and the consumer is the overlay.
 *
 * The grid view is `flipY: false` and #176's convention is CORNER, so the placed grid still puts
 * row 0 at the TOP and the picture reads right-side-up, exactly as the identity placement did.
 */
export interface ImagePaneEmit {
  /** the raster layers, in draw order. EMPTY when the cell has no usable raster or refuses one. */
  readonly layers: readonly unknown[]
  /** does this cell's layout ride on the raster — i.e. did the two declare the same frame? */
  readonly overlay: boolean
  /** why not, when `overlay` is false. Present for every refusal so a mute pane can be explained. */
  readonly refusal?: string
}

export function buildImagePaneLayers(input: {
  readonly cell: GridCell
  readonly frame: PaneFrame
  readonly pyramid: PyramidEntry | 'loading' | null | undefined
  readonly underlay: ImageEntry | 'loading' | null | undefined
}): ImagePaneEmit {
  const { cell, frame, pyramid, underlay } = input
  // A DECLARED-BUT-MALFORMED placement costs this cell its render and costs no other cell
  // anything. Every alternative is worse: identity draws the picture in the wrong place, and
  // drawing it unplaced under a space-framed camera is the same thing with extra steps. The
  // reason is reported by `useGridRaster`, so an empty pane is explained rather than mute.
  if (frame.placementError) return { layers: [], overlay: false, refusal: frame.placementError }
  const layers: unknown[] = []
  const pyrEntry = pyramid && pyramid !== 'loading' ? pyramid : null
  // ONE rule for "which raster path", shared with the camera-framing effect — see
  // `effectiveLoaderFor`. The two used to decide it separately and could disagree, so a
  // caller-supplied `cell.loader` with no fetched entry was drawn on the tiled path while the
  // camera framed the served level's box.
  const effLoader = effectiveLoaderFor(cell, pyramid)
  if (effLoader) {
    // ITEM-1: the gigapixel-capable Viv pyramid — a caller-supplied `cell.loader`, else the
    // per-cell `imagePyramids` fetch (from `DataSource.imagePixelSource()`). The layer id stays
    // `<cellId>::image` so `makeLayerFilter` routes it into THIS cell's OrthographicView.
    //
    // Placed by the FULL-RESOLUTION `to_space` — `frame.imageMatrix`, built by
    // `imagePlacementMatrix`, which is `omeTiffModelMatrix`'s consumer and the thing #228 exists
    // because nothing was. A raster that declares no placement keeps the identity it has always
    // had (array-index units), which is the honest render for an artifact that never said where
    // it sits; it simply cannot be overlaid.
    layers.push(
      ...buildRasterImageLayers({
        loader: effLoader,
        // NOT reconciled here, and that is deliberate rather than an omission (#288):
        // `buildRasterImageLayers` cuts the channel state to the loader's own `'c'` extent
        // itself, so a call site cannot forget — and a second call here made the test that
        // claimed to pin THIS site pass with this site reverted, which is worse than harmless.
        //
        // It IS duplication now, and it was not always: the removed call reconciled against
        // `effLoader`, while `pyrEntry.channels` was once reconciled against the FETCHED loader,
        // and `effectiveLoaderFor` prefers a caller-supplied `cell.loader` over it. `useGridRaster`
        // now builds its whole entry — loader, channels and contrast bound — from
        // `cell.loader ?? loader`, i.e. the same rule `effectiveLoaderFor` applies, so the two
        // cannot differ and there is nothing left here for a second call to fix.
        //
        // The reconciliation `useGridRaster` does is not redundant either way: that array is
        // what the per-channel EDITOR lists and what `setImageChannel` indexes by position.
        // …and no `?? seedChannelsForLoader(effLoader)` either, for the same reason and by the
        // same measurement: `buildRasterImageLayers` calls
        // `reconcileChannelsToLoader(undefined, loader)`, which seeds. Removing it broke only
        // the package's unused-import check, never a behavioural test — which is what "dead"
        // means here.
        channels: pyrEntry?.channels ?? cell.channels,
        cellId: cell.id,
        colormap: pyrEntry ? pyrEntry.colormap : cell.colormap,
        ...(frame.imageMatrix ? { modelMatrix: frame.imageMatrix } : {}),
      }),
    )
  } else if (underlay && underlay !== 'loading' && !frame.levelPlacementError) {
    // Fallback: the legacy single-tile bitmap underlay (no pyramid loader for this cell).
    //
    // It is placed TOO, and that is not symmetry for its own sake. `ImageMeta.affine` runs
    // space -> the SERVED (coarsest) level's pixels, so once the camera is in the coordinate
    // space a `BitmapLayer` left at `[0,0,w,h]` draws the committed Visium fixture 20x too small
    // in the corner of its own pane. Two render paths of ONE artifact disagreeing, with nothing
    // anywhere saying so, is the hazard `omeTiffUnderlay.ts` names by name.
    //
    // `Matrix4` rather than the bare 16-array: deck's `LayerProps.modelMatrix` is typed
    // `Matrix4Like | null`, which a plain `number[]` does not satisfy.
    const modelMatrix = frame.levelMatrix ? new Matrix4(frame.levelMatrix) : null
    layers.push(
      new BitmapLayer({
        id: cellLayerId(cell.id, 'image'),
        image: underlay.texture as never,
        bounds: [0, 0, underlay.width, underlay.height],
        pickable: false,
        ...(modelMatrix ? { modelMatrix } : {}),
      }),
    )
  }
  // ── THE BINDING ───────────────────────────────────────────────────────────────────────────
  // The points ride the raster IFF the two artifacts declare the SAME `coordinate_space`
  // (design §4 binding (2)). Not the same run, not the same dataset, not "they are both here" —
  // §4 refuses adjacency by name, and an undeclared frame binds to nothing. And a pane that could
  // not draw its PICTURE has nothing to overlay ONTO: reachable since the placement errors were
  // split per path, when a cell with no pyramid loader and an un-invertible served-level affine
  // drops its BitmapLayer while the binding — which is about the two declared SPACES — still says
  // bound. Points alone under a space-framed camera are a dot cloud floating over nothing.
  //
  // BOTH are decided by `overlayRefusal`, in ONE place, because `useGridRaster`'s reporter has to
  // explain what this refused for and the two may not import each other (INV-10 (d)). Written
  // twice they had already drifted on PRECEDENCE — raster-first here, binding-first there — so a
  // pane that was both un-drawable and unbound was refused for one reason and explained with
  // another.
  const refusal = overlayRefusal(
    frame,
    paneRasterPresent(cell, pyramid, underlay, Boolean(frame.levelPlacementError)),
  )
  return refusal ? { layers, overlay: false, refusal } : { layers, overlay: true }
}

export interface GridDeckInputsArgs {
  // ── geometry (the shell keeps all seven measurement bindings — DRIFT-25) ────────────────────────
  readonly denseRects: readonly PaneRect[]
  readonly chartDeckRects: readonly PaneRect[]
  readonly plotInset: (r: PaneRect) => PaneRect
  // ── cells ──────────────────────────────────────────────────────────────────────────────────────
  readonly cells: readonly GridCell[]
  readonly denseCells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly cellMap: Record<string, GridCell>
  readonly cellData: (cell: GridCell) => CellRenderData
  readonly cellSelectionSpace: (cell: GridCell, hasIds: boolean) => string
  readonly radius: number
  // ── graph overlay (workspace-level buffers; the overlay is inert without codes + graph) ─────────
  readonly positions: Float32Array
  readonly codes: Uint16Array | undefined
  readonly graph: GraphData | undefined
  readonly categories: readonly string[] | undefined
  readonly graphColorByOrder: boolean
  readonly graphColormap: ContinuousColormap
  // ── display state (the ITEM-21 per-cell store, read by the shell and threaded in) ───────────────
  readonly perCellColors: Record<string, CellColors>
  readonly perCellLegend: Record<string, CellLegend>
  readonly perCellGroupLegend: Record<string, CellLegend>
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly colorOverrides: Parameters<typeof overridesForColumn>[0]
  // ── link groups ────────────────────────────────────────────────────────────────────────────────
  readonly linkedHiddenFor: (cellId: string) => Set<number> | undefined
  readonly linkColumnFilterFor: (
    cellId: string,
  ) => { hiddenCols: Record<string, Set<number>>; valueCols: Record<string, [number, number]> } | null
  // ── selection ──────────────────────────────────────────────────────────────────────────────────
  readonly pointSelection: Uint32Array | null
  readonly selectionBySpace: Record<string, SpaceSelection>
  readonly idToRowFor: (ids: Uint32Array) => IdToRow
  readonly committedByCell: Record<string, Area[]>
  readonly effectiveHighlight: Record<string, number>
  // ── rasters + charts ───────────────────────────────────────────────────────────────────────────
  readonly imageUnderlays: Record<string, ImageEntry | 'loading' | null>
  readonly imagePyramids: Record<string, PyramidEntry | 'loading' | null>
  /**
   * #228 — the cell's declared frame (raster space + placement, layout space, and the verdict).
   * Supplied as a RESOLVER, exactly like `cellData`, so this plane stays a pure derivation and the
   * catalog lookup stays with the plane that owns the catalogs.
   */
  readonly cellFrame: (cell: GridCell) => PaneFrame
  readonly chartContribs: ReadonlyMap<string, ChartContribution>
  // ── masks (Split G's plane supplies these; this plane only READS them) ──────────────────────────
  readonly maskReview: Record<string, MaskCellReview>
  readonly maskEpoch: number
  readonly resolvedLabelMask: (cell: GridCell) => LabelMaskData | null
  readonly sharedSessionForCell: (
    cellId: string,
  ) => { mask: SharedLabelMask; controller: SharedMaskController } | null
  readonly applyMaskPick: (cellId: string, pick: { id: number | null; x: number; y: number }) => void
}

export interface GridDeckInputs {
  /** One `OrthographicView` per dense pane + one per PUBLISHED chart pane, in lockstep. */
  readonly views: unknown[]
  readonly layerFilter: unknown
  /** Each cell enriched with its resolved group overrides + link filters, for the pane layer. */
  readonly cellsForView: Record<string, GridCell>
  /** Scatter + outline + hover + chart layers, in draw order. The deck layer splices the (camera-
   *  derived) annotation layers between these and `labelMaskLayers` — see SPLIT A. */
  readonly deckLayersBefore: readonly unknown[]
  readonly labelMaskLayers: readonly unknown[]
}

/** The deck's layer INPUTS. Pure derivations: no state, no refs, no effects. */
export function useGridDeckInputs({
  denseRects,
  chartDeckRects,
  plotInset,
  cells,
  denseCells,
  denseIds,
  cellMap,
  cellData,
  cellSelectionSpace,
  radius,
  positions,
  codes,
  graph,
  categories,
  graphColorByOrder,
  graphColormap,
  perCellColors,
  perCellLegend,
  perCellGroupLegend,
  perCellRange,
  colorOverrides,
  linkedHiddenFor,
  linkColumnFilterFor,
  pointSelection,
  selectionBySpace,
  idToRowFor,
  committedByCell,
  effectiveHighlight,
  imageUnderlays,
  imagePyramids,
  cellFrame,
  chartContribs,
  maskReview,
  maskEpoch,
  resolvedLabelMask,
  sharedSessionForCell,
  applyMaskPick,
}: GridDeckInputsArgs): GridDeckInputs {
  const views = useMemo(() => {
    // Only build a chart view once its ChartCanvas has PUBLISHED a contribution — otherwise the view
    // would enter `views` (rect measured) a tick before `deckViewState` gets its entry (populated from
    // `chartContribs`), and deck would render one frame with a keyed view that has no viewState (an
    // origin/zoom-0 flash + a missing-viewState warning). Keeps `views` and `deckViewState` in lockstep.
    const chartPanes: PaneRect[] = []
    for (const r of chartDeckRects) {
      const c = chartContribs.get(r.id)
      if (c) chartPanes.push({ ...plotInset(r), flipY: c.view.flipY, controller: c.view.controller })
    }
    return [...buildViews(denseRects.map(plotInset)), ...buildViews(chartPanes)]
  }, [denseRects, chartDeckRects, chartContribs, plotInset])

  // Route each DENSE cell's scatter layer to its own view. Chart cells own no
  // scatter layer, so their ids never enter the map (no leakage into layerFilter).
  const layerFilter = useMemo(
    () => makeLayerFilter(buildLayerCellMap(denseCells.map(c => c.id))),
    [denseCells],
  )

  // Graph-overlay geometry (Phase C3c). Identical across cells (same positions /
  // codes / paths), so derive the prop objects ONCE; each toggled cell re-ids them
  // into its own `<cellId>::graph-*` layers below. `null` until codes + graph are
  // supplied (the overlay is inert without them).
  //
  // ITEM-16: pass the continuous ORDER (pseudotime) color option so a toggled cell's
  // overlay is colored root0→tip1 like the showcase — the order values derive from the
  // SAME `graph.paths` inside `buildGraphOverlay` (via `deriveOrderValues`), so nodes +
  // edge segments use the order-color accessors (not the flat default) when
  // `graphColorByOrder` is on. Off → byte-identical flat-color path.
  const graphOverlay = useMemo(
    () =>
      codes && graph
        ? buildGraphOverlay(positions, codes, graph.paths, categories, {}, {
            colorByOrder: graphColorByOrder,
            colormap: graphColormap,
          })
        : null,
    [positions, codes, graph, categories, graphColorByOrder, graphColormap],
  )

  // STABLE per-cell group-override bundles (memoized so the ref only changes when the store / group column
  // changes — a render-time `overridesForColumn(...)` returned a NEW object every render, which refired
  // the grouped Views' `overrides`-keyed effects forever → "Maximum update depth"). `cellsForView` folds
  // them onto each grouped cell ONCE, so CellView receives a stable enriched cell.
  const perCellGroupOverrides = useMemo(() => {
    const out: Record<string, CategoricalOverrides | undefined> = {}
    for (const [id, lg] of Object.entries(perCellGroupLegend)) {
      const base = lg.columnId ? overridesForColumn(colorOverrides, lg.columnId) : undefined
      // Fold the cell's persisted hidden-group codes onto the (color/label) overrides so the grouped
      // chart collapses those groups. Keyed off cellMap so a hide/show or form edit reflows live.
      const hg = cellMap[id]?.hiddenGroups
      // Merge the cell's own hidden groups with its LINK GROUP's shared hidden set (filter propagation).
      const shared = linkedHiddenFor(id)
      let hiddenCodes: Set<number> | undefined
      if ((hg && hg.length > 0) || shared) {
        hiddenCodes = new Set(hg ?? [])
        if (shared) for (const code of shared) hiddenCodes.add(code)
      }
      if (base || hiddenCodes) out[id] = { ...base, hiddenCodes }
    }
    return out
  }, [perCellGroupLegend, colorOverrides, cellMap, linkedHiddenFor])
  const cellsForView = useMemo(() => {
    const out: Record<string, (typeof cellMap)[string]> = {}
    for (const id of Object.keys(cellMap)) {
      let cell = cellMap[id]
      const gov = perCellGroupOverrides[id]
      if (gov) cell = { ...cell, groupOverrides: gov }
      // DENSE FILTER PROPAGATION: a linked scatter's effective colorBy.hidden = its own ∪ the group's
      // shared hidden set, so a category hidden on any linked plot also vanishes here.
      const shared = linkedHiddenFor(id)
      if (shared && cell.colorBy) {
        const hidden = new Set(cell.colorBy.hidden ?? [])
        for (const code of shared) hidden.add(code)
        cell = { ...cell, colorBy: { ...cell.colorBy, hidden } }
      }
      // LINK FILTERING (value windows): a grouped chart RE-COMPUTES its shape from only the points inside
      // the link group's value ranges (a continuous colorBy's visual-map range on a linked plot). Threaded
      // as `linkValueFilters` (a per-point predicate list) the chart applies before its stat/KDE compute.
      const vf = linkColumnFilterFor(id)?.valueCols
      if (vf && Object.keys(vf).length > 0) {
        cell = { ...cell, linkValueFilters: Object.entries(vf).map(([column, range]) => ({ column, range })) }
      }
      out[id] = cell
    }
    return out
  }, [cellMap, perCellGroupOverrides, linkedHiddenFor, linkColumnFilterFor, perCellRange])

  const layers = useMemo(() => {
    const out: Layer[] = []
    for (const cell of denseCells) {
      // IMAGE cell (#228): the raster, PLACED — and, when the frame binds, this cell's own points
      // over it. The decision and the layer construction live in `buildImagePaneLayers` (below,
      // exported, pure) for the same reason `applyValueRangeMask` was lifted out of this memo: it
      // is the one place a placement can be silently wrong, and nothing could assert it from
      // inside a hook.
      if (cell.kind === 'image') {
        const emit = buildImagePaneLayers({
          cell,
          frame: cellFrame(cell),
          pyramid: imagePyramids[cell.id],
          underlay: imageUnderlays[cell.id],
        })
        out.push(...(emit.layers as never[]))
        // Bound ⇒ fall THROUGH to the ordinary dense-scatter emit below. The overlay is not a
        // second implementation of a point layer: it is the same `buildScatterProps` /
        // `SelectableScatterLayer` path every scatter cell takes, so per-cell colouring, the
        // value-range mask, selection dimming and `style.radius` all work on tissue for free, and
        // a divergence between the two would be a bug rather than a variant.
        if (!emit.overlay) continue
      }
      // MULTI-DATASOURCE (ITEM-9/10): each cell renders ITS dataset's buffers (default cell = the
      // workspace props, byte-identical). A cell whose dataset hasn't resolved yet draws nothing (the
      // per-cell loading overlay covers it).
      const cd = cellData(cell)
      if (cd.positions.length === 0) continue
      // Per-cell color-by (Phase C3b) applies only to the DEFAULT dataset's cells (its buffers match
      // the prop positions); a multi-dataset cell uses its dataset's base colors.
      // MD-9: consume the per-cell colorBy buffer for ANY cell that declares one — a default cell
      // (computed from the workspace source) OR a multi-dataset cell (computed from ITS dataset source).
      // Absent (no colorBy, or dataset not ready yet) ⇒ the cell's base colors (`cd.colors`).
      const perCell = perCellColors[cell.id]
      const cellColors = perCell?.colors ?? cd.colors
      const cellEpoch = perCell?.epoch ?? cd.colorEpoch
      // WYSIWYG value-range filter (ITEM-11): a per-cell visualMap [lo,hi] hides out-of-range points.
      // Implemented as a CPU ALPHA MASK on a COPY of the color buffer (out-of-range → alpha 0) — the
      // same "transparent-out" mechanism categorical `hidden` uses — because the deck `DataFilterExtension`
      // does NOT integrate with the custom `SelectableScatterLayer` shader (its `getFilterValue` never
      // bound, so ANY active range discarded ALL points → the whole cell went blank). Active only when
      // the range is a strict sub-range of the domain (else the untouched buffer → byte-identical).
      const { colors: layerColors, filterKey } = applyValueRangeMask({
        colors: cellColors,
        nPoints: cd.nPoints,
        epoch: cellEpoch,
        legend: perCellLegend[cell.id],
        range: perCellRange[cell.id],
      })
      // Per-cell selection (ITEM-16 auto-link): consume the cell's identity-space selection, mapped
      // through the cell's own canonical `pointIds` (or raw indices when isolated/default). A cell
      // lights iff its dataset's namespace intersects the selected ids — so barcode-sharing datasets
      // auto-link and unrelated ones stay dark, with zero config.
      const spaceId = cellSelectionSpace(cell, cd.pointIds != null)
      // ITEM-5 (declarative capability): a dense cell that declares `emphasis:{consumesSelection:false}`
      // does NOT react to the shared selection — no dim, no highlight — mirroring the chart Views'
      // `gateGroupEmphasis`/`gatePointSelection`. Default (flag unset/true) ⇒ byte-identical.
      const sel = !cellConsumesSelection(cell)
        ? null
        : spaceId === DEFAULT_SELECTION_SPACE
          ? pointSelection
          : (selectionBySpace[spaceId]?.ids ?? null)
      const active = hasAnySelection(sel)
      const mask =
        active && sel
          ? cd.pointIds
            ? highlightMaskForIds(sel, idToRowFor(cd.pointIds), cd.nPoints)
            : highlightMaskForPoints(sel, cd.nPoints)
          : null
      // D (ITEM-7 single-layer selection emphasis): ONE `SelectableScatterLayer` per dense cell — a
      // per-point `getSelected` (0/1) + the `selectionActive`/`dimOpacity` uniforms dim UNSELECTED
      // points IN-SHADER, replacing the old base-dim + separate `DataFilterExtension` highlight overlay
      // (one layer instead of two, no per-point CPU recolor). Selected points stay full, unselected →
      // `DIM_OPACITY` — pixel-identical to the two-layer version (mirrors `DeckScatterCanvas`).
      // Plot-editing (ITEM-5): a per-cell mark `radius`/`opacity` (from the resolved series style, edited
      // in-cell) overrides the workspace defaults. Unset ⇒ the `radius` prop / full opacity (byte-identical).
      const cellRadius = cell.style?.radius ?? radius
      const cellOpacity = cell.style?.opacity ?? 1
      const props = buildScatterProps({
        id: cellScatterLayerId(cell.id),
        positions: cd.positions,
        colors: layerColors,
        radius: cellRadius,
        pickable: true,
      })
      const attributes: Record<string, unknown> = { ...props.data.attributes }
      const selAttr = selectionAttribute(mask)
      if (selAttr) attributes.getSelected = selAttr
      // (The value-range visualMap filter is applied above as a CPU alpha mask on `layerColors` — the
      // deck DataFilterExtension does not integrate with this custom layer's shader.)
      out.push(
        new SelectableScatterLayer({
          ...props,
          data: { length: cd.nPoints, attributes },
          selectionActive: active,
          dimOpacity: DIM_OPACITY,
          // Plot-editing (ITEM-5): per-cell mark opacity (deck layer alpha). 1 ⇒ byte-identical.
          opacity: cellOpacity,
          // #228: NO `modelMatrix` here, and that is a decision rather than an omission (DEC-17).
          // The points are drawn EXACTLY where the producer stated them and the RASTER is moved to
          // meet them; a layout that would need moving is refused by the binding instead. Placing
          // points on the GPU moves the marks and leaves every CPU consumer of the raw buffer
          // behind — the lasso mask, the hover ring, the provenance replay, the cross-pane
          // tooltip, the vector export — and three audit rounds each found one the last had
          // missed. So this layer is byte-identical to the pre-#228 one.
          updateTriggers: { getFillColor: filterKey, getSelected: mask },
        } as never),
      )
      // Graph overlay (Phase C3c / ITEM-53) — DEFAULT-dataset cells only (the overlay geometry is
      // built from the workspace positions/codes; a multi-dataset cell has no matching graph).
      if (cell.graphOverlay && graphOverlay && !cell.datasetId) {
        out.push(new LineLayer({ ...graphOverlay.edgeProps, id: cellLayerId(cell.id, 'graph-edges') } as never))
        out.push(new ScatterplotLayer({ ...graphOverlay.nodeProps, id: cellLayerId(cell.id, 'graph-nodes') } as never))
        out.push(new TextLayer({ ...graphOverlay.labelProps, id: cellLayerId(cell.id, 'graph-labels') } as never))
      }
    }
    return out
  }, [
    denseCells,
    cellData,
    radius,
    perCellColors,
    perCellLegend,
    perCellRange,
    cellSelectionSpace,
    idToRowFor,
    pointSelection,
    selectionBySpace,
    graphOverlay,
    imageUnderlays,
    imagePyramids,
    // #228 — WITHOUT THIS the memo holds a STALE frame. `cellFrame` closes over the catalog,
    // which arrives on its own schedule (the owned pull, or a re-passed `catalog` prop) and is
    // NOT a dependency of `cellData`. The memo would then recompute only when some unrelated dep
    // happened to change afterwards: the raster stays unplaced and the overlay never emits, on
    // exactly the ordering nothing here controls.
    cellFrame,
  ])

  // Per-cell committed-selection OUTLINE (selection-unification): one shared `sel-shapes` outline
  // layer per cell whose id is prefixed with the cell id, so `makeLayerFilter` renders it ONLY in
  // that cell's viewport. World-space ⇒ the committed boundary PERSISTS after finish + tracks the
  // cell's pan/zoom, and the Move tool drags it.
  const selectionOutlineLayers = useMemo(() => {
    const out: unknown[] = []
    for (const [cellId, areas] of Object.entries(committedByCell)) {
      // Skip committed areas whose cell was removed by a layout change (no live viewport to render
      // them in) — belt-and-suspenders against a stale-entry render (LEDGER: resource-lifecycle/low).
      if (!denseCells.some(c => c.id === cellId) || areas.length === 0) continue
      const layer = buildSelectionOutlineLayer(controllerAreasToShapes(areas), cellLayerId(cellId, 'sel-shapes'))
      if (layer) out.push(layer)
    }
    return out
  }, [committedByCell, denseCells])

  // Data-table HOVER→HIGHLIGHT (dense scatter): a hollow ring drawn at the hovered row's point, in the
  // owning cell's view (cellId-prefixed id ⇒ the layerFilter routes it there). Its own memo so a hover
  // never rebuilds the (expensive) per-cell scatter `layers` memo — mirrors `selectionOutlineLayers`.
  const hoverHighlightLayers = useMemo(() => {
    const out: unknown[] = []
    for (const [cellId, idx] of Object.entries(effectiveHighlight)) {
      if (idx == null) continue
      const cell = denseCells.find(c => c.id === cellId)
      if (!cell) continue
      const cd = cellData(cell)
      if (idx < 0 || idx >= cd.nPoints) continue
      const px = cd.positions[idx * 2]
      const py = cd.positions[idx * 2 + 1]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const r = cell.style?.radius ?? radius
      // #228: NO placement here either, for the same reason the scatter layer carries none
      // (DEC-17). The ring reads the RAW position buffer and the marks it rings are drawn from
      // that same buffer untouched, so the two agree by construction rather than by two matrices
      // being kept in step — which is what an earlier cut tried and what the audit rounds kept
      // finding holes in.
      out.push(
        new ScatterplotLayer({
          id: cellLayerId(cellId, 'hover-highlight'),
          data: [{ position: [px, py] as [number, number] }],
          getPosition: (d: { position: [number, number] }) => d.position,
          getRadius: Math.max(r * 2.4, r + 4),
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: HOVER_HIGHLIGHT_RGBA,
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          pickable: false,
          parameters: { depthTest: false },
        } as never),
      )
    }
    return out
  }, [effectiveHighlight, denseCells, cellData, radius])

  // Migrated chart cells' published (cellId-prefixed) layers, drawn in their own view via layerFilter.
  const chartLayers = useMemo(
    () => [...chartContribs.values()].flatMap(c => c.layers),
    [chartContribs],
  )
  // (SPLIT A: `annotLayerCache` + `annotationLayers` moved to `GridDeckLayer`. The memo culls each
  //  annotate cell's committed geometry against its LIVE camera window, so it is a camera consumer
  //  by construction and had to travel with the camera. Its inputs — cells, denseIds, annotateEpoch,
  //  annotateMode, boundAnnotateCellId, editDraft — cross as props; the per-cell layer cache and the
  //  M7 per-cell dep comparison moved verbatim.)
  // In-grid LABEL-MASK layers (segmentation-scale ITEM-1) — a `segment` cell's resolved `labelMask`
  // rendered by `buildLabelMaskLayers`, cellId-prefixed so `makeLayerFilter` routes each into its own
  // cell's viewport (rides its pan/zoom). Its own memo (like `annotationLayers`) so a mask correction
  // never rebuilds the scatter `layers` memo; `maskEpoch` (bumped by edits/undo) + `maskReview` (LUT/
  // dirty-rect state) are the rebuild triggers. A non-segment workspace yields `[]` (byte-identical).
  const labelMaskLayers = useMemo(() => {
    const out: Layer[] = []
    for (const cell of cells) {
      if (!cell.segment || !denseIds.has(cell.id)) continue
      // SHARED-MASK view (Track A): a cell in a shared link group renders the ONE shared raster placed
      // by the shared `modelMatrix`, so every member pane shows the same world-space mask (the raster
      // ref is identical across members → a dirty-rect sub-upload repaints all of them). Else the
      // Track-0 per-cell mask (byte-identical when no group is shared).
      const shared = sharedSessionForCell(cell.id)
      const data: LabelMaskData | null = shared
        ? {
            raster: shared.mask.raster,
            width: shared.mask.width,
            height: shared.mask.height,
            categoryForId: shared.mask.categoryForId,
            modelMatrix: shared.mask.modelMatrix(),
          }
        : resolvedLabelMask(cell)
      if (!data) continue
      const rv = maskReview[cell.id]
      // A fresh id→category snapshot (after a relabel/merge) forces the layer's LUT rebuild; the raster
      // ref stays stable so the dirty-rect sub-upload path is preserved.
      const effData = rv?.catsRef ? { ...data, categoryForId: rv.catsRef } : data
      out.push(
        ...buildLabelMaskLayers({
          labelMask: effData,
          cellId: cell.id,
          hiddenCategories: rv?.hidden ?? null,
          soloCategory: rv?.solo ?? null,
          selectedId: rv?.selectedId ?? null,
          dirtyRect: rv?.dirty ?? null,
          onPick: pick => applyMaskPick(cell.id, pick),
        }),
      )
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, denseIds, maskReview, maskEpoch, applyMaskPick, resolvedLabelMask, sharedSessionForCell])
  // SPLIT A: `allLayers` is assembled inside `GridDeckLayer`, because the annotation layers it
  // splices in are camera-derived. The deck's DRAW ORDER is load-bearing (annotations paint over the
  // scatter/selection/hover/chart layers and UNDER the label masks), so the shell hands the two
  // non-camera halves across separately rather than one flat list — the child inserts the
  // annotations between them, reproducing the old single memo's order exactly.
  const deckLayersBefore = useMemo(
    () => [...layers, ...selectionOutlineLayers, ...hoverHighlightLayers, ...chartLayers],
    [layers, selectionOutlineLayers, hoverHighlightLayers, chartLayers],
  )

  return { views, layerFilter, cellsForView, deckLayersBefore, labelMaskLayers }
}
