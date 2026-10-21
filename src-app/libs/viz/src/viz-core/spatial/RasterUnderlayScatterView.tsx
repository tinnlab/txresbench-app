// RasterUnderlayScatterView.tsx — the REGION-SELECT→ANALYSIS bridge: a GPU scatter of points
// at PHYSICAL coordinates over an optional raster-image underlay, with a "Select region" tool
// that lassoes a region, resolves the points inside via the KD-tree, WRITES them into the
// Coordination store (so every linked view — scatter, heatmap — reacts, exactly like Vitessce's
// coordination model) and shows the region's categorical COMPOSITION ("what point types are in
// this region").
//
// It reuses the whole existing stack: the KD-tree (`spatial/pointIndex`) + polygon selection
// (`regionSelect` → `data/selection`, O(log N + k), never an O(N) scan), the affine image model
// (`data/image` / `data/affineMatrix`), the scatter/bitmap prop builders (`layers/scatter`), and
// the Coordination store (`adapter/Coordination.store`) that HeatmapView already reads. GENERIC
// naming (DEC-28): region / point / group — nothing here is domain-specific.

import { useCallback, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { BitmapLayer, ScatterplotLayer, PolygonLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import type { Matrix4Like } from '@math.gl/core'
import { buildPointIndex } from './pointIndex'
import { selectRegion, regionComposition, type RegionComposition, type Vec2 } from './regionSelect'
import { transformPositions, imageBounds, IDENTITY_AFFINE, type Affine } from '../data/image'
import { affineToModelMatrix } from '../data/affineMatrix'
import { areaContainsPoint, outlineStyle, translateArea } from '../selection/areaGestures'
import { useSelectionCamera } from '../selection/useSelectionCamera'
import type { Area } from '../selection/SelectionController'
import { toBitmapTexture } from '../layers/bitmapTexture'
import { boundsForPositions } from '../density/densityBin'
import {
  DIM_OPACITY,
  buildIdToRow,
  hasAnySelection,
  highlightMaskForIds,
  identityPointIds,
  mapRowsToIds,
  type IdToRow,
} from '../coordination/selectionSync'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'
import type { CoordinationHandle } from '../registry/types'

/** The coordination source id a region selection ORIGINATES from when the caller passes none. */
export const REGION_SELECT_SOURCE = 'region-select-source'

/**
 * PURE produce-mapping for the region lasso (the testable core of the multi-source seam):
 * turn the lasso's LOCAL point rows into the CANONICAL point ids to PUBLISH into the
 * Coordination store. Reuses `mapRowsToIds` (the shared produce seam) — no reimplementation.
 *
 * ABSENT / null `pointIds` ⇒ identity: returns the SAME `indices` array unchanged (the
 * single-source case is byte-identical to the old index-based publish — no copy, no remap).
 * PRESENT ⇒ each local row is mapped to `pointIds[row]`, so a region selection is published
 * in cross-dataset-safe canonical ids. Length is preserved, so the caller's empty-⇒-clear
 * decision (`length > 0 ? ids : null`) is unaffected.
 */
export function regionSelectionIds(
  indices: Uint32Array,
  pointIds?: Uint32Array | null,
): Uint32Array {
  return pointIds ? mapRowsToIds(indices, pointIds) : indices
}

export interface RasterUnderlayScatterViewProps {
  /** interleaved xy Float32Array of point PHYSICAL positions (the layout's own space), length N*2. */
  positions: Float32Array
  /** RGBA Uint8Array (length N*4) — categorical or continuous coloring. */
  colors: Uint8Array
  totalPoints: number
  /** optional raster-image underlay (BitmapLayer) rendered UNDER the points. */
  underlay?: { data: Uint8Array; width: number; height: number }
  /** affine mapping the point positions into the underlay's shared coordinate space (default identity). */
  affine?: Affine
  /** per-point group codes → drives the region categorical COMPOSITION readout (optional). */
  groupCodes?: Uint16Array | Uint32Array
  /** category labels for the composition readout (indexed by group code). */
  categories?: readonly string[]
  /** physical point radius in COMMON (world) units, so points scale with the image. */
  radius?: number
  /** bump when `colors` CONTENTS change so the layers re-upload. */
  colorEpoch?: number
  /** initial underlay opacity (0..1); a range control overrides it live. */
  initialOpacity?: number
  /** the coordination source id this view's region selection originates from (default `REGION_SELECT_SOURCE`). */
  sourceId?: string
  /**
   * The IDENTITY SPACE this view links on (ITEM-13 image↔data linking). The view CONSUMES the shared
   * selection from this space (`coordination.usePointSelectionInSpace(selectionSpace)`) and lights the
   * incoming cells via `buildIdToRow`+`highlightMaskForIds` — the same identity-space isolation the
   * scatter/heatmap fan-out uses, so a selection in another dataset's space never highlights here.
   * Default `DEFAULT_SELECTION_SPACE` (single-dataset: byte-identical to reading `pointSelection`).
   */
  selectionSpace?: string
  /**
   * OPTIONAL row→canonical-point-id map (multi-source selection seam): `pointIds[row]` is
   * the STABLE canonical id of this view's local `row`. When present, a region selection
   * PRODUCED here is published in canonical ids (so cross-plot emphasis stays correct
   * against views over a different point set/order). ABSENT ⇒ identity (`pointIds[i]=i`):
   * byte-identical to the index-based path (the single-source case, where index == id).
   */
  pointIds?: Uint32Array
  /** fired on each committed region with the selected indices + their composition (null when no groups). */
  onRegionSelected?: (indices: Uint32Array, composition: RegionComposition | null) => void
  /** The Selection coordination handle (STEP 3): PUBLISH the region selection through it. */
  coordination?: CoordinationHandle
}

type Mode = 'pan' | 'region' | 'move'

/** Wrap a world-space ROI polygon as a shared-core `Area` (so hit-test/translate are the shared ops). */
function regionAsArea(polygon: Vec2[]): Area {
  return { kind: 'polygon', polygon, mode: 'add' }
}
function areaPolygon(area: Area): Vec2[] {
  return area.kind === 'polygon' ? area.polygon.map(v => [v[0], v[1]] as Vec2) : []
}

interface OverlayShape {
  polygon: Vec2[]
  role: 'region' | 'draft'
}

/** A scatter (points at physical coords over a raster underlay) with a region→coordination tool. */
export function RasterUnderlayScatterView({
  positions,
  colors,
  totalPoints,
  underlay,
  affine = IDENTITY_AFFINE,
  groupCodes,
  categories,
  radius = 4,
  colorEpoch = 0,
  initialOpacity = 1,
  sourceId = REGION_SELECT_SOURCE,
  pointIds,
  selectionSpace = DEFAULT_SELECTION_SPACE,
  onRegionSelected,
  coordination = defaultCoordinationHandle,
}: RasterUnderlayScatterViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // OrthographicView with flipY (matches ImageCanvas so the underlay reads right-side-up).
  const view = useMemo(() => new OrthographicView({ id: 'raster-scatter', flipY: true }), [])

  // The affine is applied to the point positions on the GPU (modelMatrix), so the raw
  // `positions` go straight to the buffer with NO per-point CPU pass on the hot path. But the
  // ROI polygon is drawn in WORLD space, so the hit-test needs the world positions: transform
  // ONCE at load (memoised) and build the KD-tree over THOSE. Index i is identical in both.
  const modelMatrix = useMemo(() => affineToModelMatrix(affine), [affine])
  const worldPositions = useMemo(() => transformPositions(positions, affine), [positions, affine])
  const pointIndex = useMemo(() => buildPointIndex(worldPositions), [worldPositions])

  const bounds = useMemo(
    () => (underlay ? imageBounds(underlay.width, underlay.height) : null),
    [underlay],
  )
  // deck.gl v9 renders a raw `{data,width,height}` BitmapLayer image as a BLACK quad (zeroed RGB);
  // wrap in an ImageData. Memoized on `underlay` alone so the texture uploads once and stays stable
  // across live opacity ticks (opacity is a shader uniform below).
  const texture = useMemo(() => (underlay ? toBitmapTexture(underlay) : null), [underlay])
  const initialViewState = useMemo<OrthographicViewState>(() => {
    if (underlay) {
      return { target: [underlay.width / 2, underlay.height / 2, 0], zoom: 0 } as OrthographicViewState
    }
    const b = boundsForPositions(worldPositions)
    return { target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0], zoom: 0 } as OrthographicViewState
  }, [underlay, worldPositions])

  const [mode, setMode] = useState<Mode>('pan')
  const [opacity, setOpacity] = useState(initialOpacity)
  // Controlled view state so `unproject` can map screen→world with the LIVE camera.
  const [viewState, setViewState] = useState<OrthographicViewState>(initialViewState)

  // ROI + selection state.
  const [polyDraft, setPolyDraft] = useState<Vec2[]>([])
  // true while the cursor hovers the grabbable committed region → move cursor + press-to-drag in any mode.
  const [hoverMove, setHoverMove] = useState(false)
  const [regionPolygon, setRegionPolygon] = useState<Vec2[] | null>(null)
  const [selected, setSelected] = useState<Uint8Array>(() => new Uint8Array(totalPoints))
  const [selCount, setSelCount] = useState(0)
  const [selEpoch, setSelEpoch] = useState(0)
  const [composition, setComposition] = useState<RegionComposition | null>(null)

  const hasSelection = selCount > 0

  // ── CONSUME leg (ITEM-13 image↔data linking): read the SHARED selection from this view's identity
  //    space and light the incoming cells. This is the mirror of the publish path above — a selection
  //    made in ANY linked view (a scatter, a heatmap, another tissue view) on the SAME space now
  //    emphasises those cells HERE, using the existing pure `selectionSync` mechanism (no new bus).
  //    Identity-space isolation: `usePointSelectionInSpace(selectionSpace)` returns `null` for a
  //    selection made against a DIFFERENT dataset's space, so a cross-dataset selection never lights.
  const incomingSelection = coordination.usePointSelectionInSpace(selectionSpace)
  const incomingOrigin = coordination.useSelectionOriginInSpace(selectionSpace)
  // row↔canonical-id map for THIS view (memoized per id array / point count; identity when no
  // explicit `pointIds`, so the single-source case is index==id — byte-identical to the publish seam).
  const consumeIdToRow = useMemo<IdToRow>(
    () => buildIdToRow(pointIds ?? identityPointIds(totalPoints)),
    [pointIds, totalPoints],
  )
  // The incoming highlight mask, built ONCE per selection change (O(selection) + the O(n) zero-fill;
  // the per-frame render never rescans). Self-echo suppression: skip when the shared selection was
  // ORIGINATED by this view (its own committed region already renders via the local overlay below).
  const incomingMask = useMemo<Uint8Array | null>(() => {
    if (incomingOrigin === sourceId) return null
    if (!hasAnySelection(incomingSelection)) return null
    return highlightMaskForIds(incomingSelection!, consumeIdToRow, totalPoints)
  }, [incomingSelection, incomingOrigin, sourceId, consumeIdToRow, totalPoints])
  const hasIncoming = incomingMask != null
  // Base scatter dims when EITHER a local region OR an incoming shared selection is active, so the
  // highlighted cells (local or incoming) read on top.
  const dim = hasSelection || hasIncoming

  // Commit a drawn ROI: KD-tree-narrowed point-in-polygon → indices → composition → store.
  const commitRegion = useCallback(
    (polygon: Vec2[]) => {
      const indices = selectRegion(polygon, worldPositions, totalPoints, pointIndex)
      const u8 = new Uint8Array(totalPoints)
      for (let k = 0; k < indices.length; k++) u8[indices[k]] = 1
      setSelected(u8)
      setSelCount(indices.length)
      setSelEpoch(e => e + 1)
      setRegionPolygon(polygon)
      const comp =
        groupCodes && categories ? regionComposition(indices, groupCodes, categories) : null
      setComposition(comp)
      // WRITE the selection into the shared Coordination store so every linked view reacts.
      // An empty region clears it (setSelection(id, null) → pointSelection = null).
      // Multi-source seam (identity default): with `pointIds` the lasso's LOCAL rows are
      // mapped → canonical ids so the selection is cross-dataset-safe; absent ⇒ the identity
      // array is published unchanged — the same produce seam GridWorkspace uses. Length is
      // preserved, so the empty-⇒-clear decision below is unchanged.
      const publishIds = regionSelectionIds(indices, pointIds)
      coordination.setSelection(sourceId, publishIds.length > 0 ? publishIds : null)
      onRegionSelected?.(indices, comp)
    },
    [worldPositions, totalPoints, pointIndex, groupCodes, categories, sourceId, pointIds, onRegionSelected, coordination],
  )

  const clearRegion = useCallback(() => {
    setPolyDraft([])
    setRegionPolygon(null)
    setSelected(new Uint8Array(totalPoints))
    setSelCount(0)
    setSelEpoch(e => e + 1)
    setComposition(null)
    coordination.setSelection(sourceId, null)
  }, [totalPoints, sourceId, coordination])

  // ── screen → world unprojection (against an EXPLICIT viewState for the pan/zoom math) ──────
  const unprojectAt = useCallback(
    (vs: OrthographicViewState, clientX: number, clientY: number): Vec2 | null => {
      const el = containerRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState: vs })
      if (!vp) return null
      const world = vp.unproject([clientX - rect.left, clientY - rect.top])
      return [world[0], world[1]]
    },
    [view],
  )
  const unproject = useCallback(
    (clientX: number, clientY: number): Vec2 | null => unprojectAt(viewState, clientX, clientY),
    [unprojectAt, viewState],
  )
  // Pan/zoom stay live during the region/move tool (shared helper); the ROI outline is world-space so
  // it anchors to the underlay as the camera moves.
  const cam = useSelectionCamera({ viewState, setViewState, unprojectAt })

  // in-progress drag-to-move of the committed region (Move tool): the region geometry at grab time.
  const dragRef = useRef<{ startWorld: Vec2; origArea: Area } | null>(null)
  const regionRef = useRef<Vec2[] | null>(null)
  regionRef.current = regionPolygon

  // Region tool: click to drop polygon vertices ("Finish region" commits). Move tool: grab + drag
  // the committed region (world-space hit-test via the SHARED core), re-committing on each move.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const p = unproject(e.clientX, e.clientY)
      if (!p) return
      // HOVER-TO-MOVE: a press inside the committed region grabs it to drag — in ANY mode (no need
      // for the Move tool), except mid-region-draft (there a click adds a vertex).
      const midDraft = mode === 'region' && polyDraft.length > 0
      if (!midDraft && regionRef.current && areaContainsPoint(regionAsArea(regionRef.current), [p[0], p[1]])) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        dragRef.current = { startWorld: p, origArea: regionAsArea(regionRef.current) }
        return
      }
      if (mode === 'region') {
        setPolyDraft(prev => [...prev, p])
      }
    },
    [mode, polyDraft.length, unproject],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // An active drag translates the grabbed region — in ANY mode (hover-to-move OR the Move tool).
      if (dragRef.current) {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        const d = dragRef.current
        const moved = areaPolygon(translateArea(d.origArea, p[0] - d.startWorld[0], p[1] - d.startWorld[1]))
        commitRegion(moved) // re-hit-test + re-publish + re-outline the moved region
        return
      }
      // Not dragging: reflect whether the cursor is over the grabbable committed region (move cursor).
      const p = unproject(e.clientX, e.clientY)
      const midDraft = mode === 'region' && polyDraft.length > 0
      const over =
        !!p && !midDraft && !!regionRef.current && areaContainsPoint(regionAsArea(regionRef.current), [p[0], p[1]])
      setHoverMove(prev => (prev === over ? prev : over))
    },
    [mode, polyDraft.length, unproject, commitRegion],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (dragRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        dragRef.current = null
      }
    },
    [],
  )

  // Overlay handlers with pan/zoom folded in (middle/space-drag pans; wheel zooms via cam.onWheel).
  const overlayHandlers = useMemo(
    () => cam.wrapPointerHandlers({ onPointerDown, onPointerMove, onPointerUp }),
    [cam, onPointerDown, onPointerMove, onPointerUp],
  )

  const finishRegion = useCallback(() => {
    if (polyDraft.length >= 3) commitRegion(polyDraft.map(v => [v[0], v[1]] as Vec2))
    setPolyDraft([])
  }, [polyDraft, commitRegion])

  // ── layers ────────────────────────────────────────────────────────────────
  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])

  const layers = useMemo(() => {
    const out: unknown[] = []

    // 0) image underlay (points are physical coords OVER this image).
    if (underlay && bounds && texture) {
      out.push(
        new BitmapLayer({
          id: 'underlay',
          image: texture as never,
          bounds: [...bounds] as [number, number, number, number],
          opacity,
        }),
      )
    }

    // 1) base scatter — raw positions carried into world space by the GPU affine; dimmed
    //    when a region is selected so the highlight overlay reads on top.
    out.push(
      new ScatterplotLayer({
        id: 'base',
        data: {
          length: totalPoints,
          attributes: {
            getPosition: { value: positions, size: 2 },
            getFillColor: { value: colors, size: 4, normalized: true },
          },
        },
        modelMatrix: modelMatrix as Matrix4Like,
        radiusUnits: 'common',
        getRadius: radius,
        radiusMinPixels: 1,
        radiusMaxPixels: 8,
        stroked: false,
        filled: true,
        opacity: dim ? DIM_OPACITY : 1,
        pickable: true,
        updateTriggers: { getFillColor: colorEpoch },
      }),
    )

    // 2) highlight overlay — only the selected ROI points (filterRange [1,1]), full opacity.
    if (hasSelection) {
      out.push(
        new ScatterplotLayer({
          id: 'highlight',
          data: {
            length: totalPoints,
            attributes: {
              getPosition: { value: positions, size: 2 },
              getFillColor: { value: colors, size: 4, normalized: true },
              getFilterValue: { value: selected, size: 1 },
            },
          },
          modelMatrix: modelMatrix as Matrix4Like,
          radiusUnits: 'common',
          getRadius: radius + 1,
          radiusMinPixels: 2,
          radiusMaxPixels: 10,
          stroked: false,
          filled: true,
          opacity: 1,
          pickable: false,
          extensions: [filterExt],
          filterRange: [1, 1],
          updateTriggers: { getFillColor: colorEpoch, getFilterValue: selEpoch },
        }),
      )
    }

    // 2b) INCOMING highlight overlay (ITEM-13 consume leg) — the cells the SHARED selection
    //     (published by another linked view on this identity space) covers, drawn full-opacity over
    //     the dimmed base with a stroke so they read distinctly from a locally-drawn region. Same GPU
    //     attribute-swap mechanism as the local highlight (a `DataFilterExtension` on a 0/1 mask), so
    //     there is no per-frame O(N) recolor.
    if (incomingMask) {
      out.push(
        new ScatterplotLayer({
          id: 'incoming-highlight',
          data: {
            length: totalPoints,
            attributes: {
              getPosition: { value: positions, size: 2 },
              getFillColor: { value: colors, size: 4, normalized: true },
              getFilterValue: { value: incomingMask, size: 1 },
            },
          },
          modelMatrix: modelMatrix as Matrix4Like,
          radiusUnits: 'common',
          getRadius: radius + 1,
          radiusMinPixels: 2,
          radiusMaxPixels: 10,
          stroked: true,
          getLineColor: outlineStyle('area').lineColor as [number, number, number, number],
          getLineWidth: 1,
          lineWidthUnits: 'pixels',
          filled: true,
          opacity: 1,
          pickable: false,
          extensions: [filterExt],
          filterRange: [1, 1],
          updateTriggers: { getFillColor: colorEpoch, getFilterValue: incomingMask },
        }),
      )
    }

    // 3) ROI outline + in-progress draft (WORLD coords — no modelMatrix; already world space).
    const shapes: OverlayShape[] = []
    if (regionPolygon) shapes.push({ polygon: regionPolygon, role: 'region' })
    if (polyDraft.length >= 2) shapes.push({ polygon: polyDraft.map(v => [v[0], v[1]] as Vec2), role: 'draft' })
    if (shapes.length > 0) {
      out.push(
        new PolygonLayer<OverlayShape>({
          id: 'region-shapes',
          data: shapes,
          getPolygon: (d: OverlayShape) => d.polygon,
          stroked: true,
          filled: true,
          // Shared outline styling (selection-unification ITEM-7): the committed region uses the SAME
          // subtle border as every other surface; the draft stays bright/thick.
          getFillColor: (d: OverlayShape) => outlineStyle(d.role === 'draft' ? 'draft' : 'area').fillColor as [number, number, number, number],
          getLineColor: (d: OverlayShape) => outlineStyle(d.role === 'draft' ? 'draft' : 'area').lineColor as [number, number, number, number],
          getLineWidth: (d: OverlayShape) => outlineStyle(d.role === 'draft' ? 'draft' : 'area').lineWidth,
          lineWidthUnits: 'pixels',
          pickable: false,
          updateTriggers: { getPolygon: [regionPolygon, polyDraft] },
        }),
      )
    }

    return out
  }, [
    underlay,
    texture,
    bounds,
    opacity,
    positions,
    colors,
    totalPoints,
    modelMatrix,
    radius,
    hasSelection,
    dim,
    incomingMask,
    selected,
    selEpoch,
    colorEpoch,
    filterExt,
    regionPolygon,
    polyDraft,
  ])

  const drawing = mode !== 'pan'

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="viz-raster-scatter"
    >
      {/* toolbar */}
      <div
        style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        data-testid="raster-scatter-toolbar"
      >
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {(['pan', 'region', 'move'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              data-testid={`region-tool-${m}`}
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m)
                setPolyDraft([])
                dragRef.current = null
              }}
              style={{ fontWeight: mode === m ? 700 : 400 }}
            >
              {m === 'pan' ? 'Pan' : m === 'region' ? 'Select region' : 'Move'}
            </button>
          ))}
        </span>
        {mode === 'region' && (
          <button
            type="button"
            data-testid="region-finish"
            onClick={finishRegion}
            disabled={polyDraft.length < 3}
          >
            Finish region ({polyDraft.length})
          </button>
        )}
        <button type="button" data-testid="region-clear" onClick={clearRegion}>
          Clear
        </button>
        <span data-testid="region-selection-count" style={{ opacity: 0.75 }}>
          {selCount.toLocaleString()} points in region
        </span>
        {underlay && (
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: 0.75 }}>
            Underlay{' '}
            <input
              data-testid="underlay-opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={e => setOpacity(Number(e.target.value))}
            />
          </label>
        )}
      </div>

      {/* composition readout — "what point types are in this ROI" */}
      {composition && composition.total > 0 && (
        <div
          data-testid="region-composition"
          style={{ padding: '2px 8px 6px', display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, opacity: 0.85 }}
        >
          <span style={{ fontWeight: 600 }}>Region composition:</span>
          {composition.entries.map(e => (
            <span key={e.code} data-testid={`region-composition-${e.code}`}>
              {e.category}: {e.count.toLocaleString()} ({Math.round(e.fraction * 100)}%)
            </span>
          ))}
        </div>
      )}

      {/* canvas + drawing overlay */}
      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <DeckGL
          views={view}
          controller={!drawing}
          viewState={viewState as never}
          onViewStateChange={((p: { viewState: OrthographicViewState }) => setViewState(p.viewState)) as never}
          layers={layers as never}
        />
        {drawing && (
          <div
            data-testid="region-draw-overlay"
            ref={cam.overlayWheelRef}
            onPointerDown={overlayHandlers.onPointerDown}
            onPointerMove={overlayHandlers.onPointerMove}
            onPointerUp={overlayHandlers.onPointerUp}
            style={{ position: 'absolute', inset: 0, cursor: cam.cursorFor(hoverMove || mode === 'move' ? 'move' : 'crosshair'), touchAction: 'none' }}
          />
        )}
      </div>
    </div>
  )
}
