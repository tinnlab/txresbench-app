// TiledPointsView.tsx — the GPU UNBOUNDED-SCALE categorical point cloud (PERFORMANCE_PLAN.md
// Phase 3 / PERF_SCALING_PLAN.md B1). The complement to CategoricalPointsView's single/chunked
// GPU path: instead of uploading/drawing all N points, it builds a CLIENT quadtree (scale/
// tilePyramid.ts) over the resident xy ONCE, then per frame draws ONLY the points whose tiles are
// in the viewport at a zoom-matched budget — so per-frame GPU cost decouples from total N.
//
// It reuses the EXISTING optimized machinery (no hand-rolled renderer):
//   • `ColormapScatterLayer` (categorical LUT path) colors each point in-shader from a per-point
//     category CODE + the palette LUT texture — the SAME GPU colormap CategoricalPointsView uses.
//   • `DataFilterExtension` drives per-category show/hide (uniform bitmask for ≤128 categories).
//   • zero-copy `.subarray` tile VIEWS of ONE reordered buffer (scale/tilePyramid `reorderByPyramid`
//     + `tileView`) — the same zero-copy discipline ChunkedScatter uses for chunks.
//
// ── Per-frame cost + the cheap GPU wins folded in (B5/B6) ────────────────────────────────────────
//
// • Re-selection is DEBOUNCED on viewState change (LOD_IDLE_MS) and is O(visible tiles), never O(N):
//   `selectTiles` walks the tile table (bounded by gridSide², independent of N), not the points.
// • B5 — PICKING DISCIPLINE: every tile layer is `pickable:false`. Picking is a whole extra GPU
//   pass; at tiling scale it is the top hidden cost, and the tiled overview is a navigation surface.
// • B6 — updateTriggers / dataComparator HYGIENE: the reordered position/code buffers are built
//   ONCE (memo on positions+pyramid); a per-tile `data` object is CACHED by (tile, drawCount) so a
//   viewState change that leaves a tile's draw prefix unchanged hands deck the SAME binary
//   attribute reference → deck skips the attribute rebuild/re-upload. Only the SET of drawn tiles
//   changes; position buffers never re-upload on pan/zoom/recolor/resize.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { DataFilterExtension } from '@deck.gl/extensions'
import { ColormapScatterLayer } from '../gpu/ColormapScatterLayer'
import { buildScatterProps } from '../layers/scatter'
import { buildPaletteLUT } from '../gpu/colormapLut'
import { resolveEffectivePalette } from '../data/color'
import {
  buildTilePyramid,
  selectTiles,
  reorderByPyramid,
  tileView,
  type TileSelection,
  type SelectedTile,
} from '../scale/tilePyramid'
import { LOD_IDLE_MS, viewportWorldBounds, type ViewportCamera } from '../scale/lod'
import {
  categoryVisibilityMask,
  filterModeForCategoryCount,
  visibleCategoryList,
} from './categoryFilter'

const EMPTY_COLORS = new Uint8Array(0)

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 0,
} as OrthographicViewState

export interface TiledPointsViewProps {
  /** interleaved xy Float32Array, length `count * 2`. */
  positions: Float32Array
  /** per-point category code, length `count`. */
  categoryCodes: Uint16Array
  /** distinct category count (palette + filter sizing). */
  categoryCount: number
  categoryNames?: readonly string[]
  /** which category codes are shown (a GPU-uniform toggle for ≤128 categories). */
  visibleCategories: ReadonlySet<number>
  radius?: number
  initialViewState?: Partial<OrthographicViewState>
  onViewStateChange?: (viewState: OrthographicViewState) => void
  /** quadtree depth → `2^maxDepth` leaf tiles/axis (default from tilePyramid). */
  maxDepth?: number
  /** per-tile draw-budget cap (default from tilePyramid). */
  tilePointCap?: number
  /** target TOTAL drawn count across visible tiles (the constant per-frame cost). */
  targetPoints?: number
  /** fired whenever a (debounced) re-selection lands — for a parent readout / the story hook. */
  onSelection?: (info: {
    visibleTiles: number
    drawnPoints: number
    totalPoints: number
    level: number
    perTileBudget: number
  }) => void
}

/**
 * A viewport-LOD tiled categorical point cloud. The heavy lift (the pyramid + the one-time reorder)
 * runs once per dataset; each pan/zoom re-selects the visible tiles (debounced) and rebuilds only
 * the (cheap) layer list — the GPU buffers are stable zero-copy views of the reordered arrays.
 */
export function TiledPointsView({
  positions,
  categoryCodes,
  categoryCount,
  categoryNames,
  visibleCategories,
  radius = 2,
  initialViewState,
  onViewStateChange,
  maxDepth,
  tilePointCap,
  targetPoints,
  onSelection,
}: TiledPointsViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pointCount = positions.length / 2

  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const viewRef = useRef<OrthographicViewState>({ ...DEFAULT_VIEW_STATE, ...initialViewState })

  // ── The spatial index + the ONE-TIME reorder (B6: built once; never per frame) ─────────────
  const pyramid = useMemo(
    () => buildTilePyramid(positions, { maxDepth, tilePointCap }),
    [positions, maxDepth, tilePointCap],
  )
  // Category→bit filter design (same as CategoricalPointsView): uniform bitmask ≤128, else mask.
  const filterMode = useMemo(() => filterModeForCategoryCount(categoryCount), [categoryCount])
  const filterExt = useMemo(
    () =>
      new DataFilterExtension({
        categorySize: filterMode === 'category' ? 1 : 0,
        filterSize: filterMode === 'mask' ? 1 : 0,
      }),
    [filterMode],
  )

  // Per-point color VALUE = category code as float (the LUT samples it in-shader). Reordered ONCE
  // through the pyramid so a tile's slice is contiguous → zero-copy tile views.
  const reorderedPositions = useMemo(() => reorderByPyramid(positions, pyramid, 2)!, [positions, pyramid])
  const reorderedColorValue = useMemo(() => {
    const cv = new Float32Array(pyramid.total)
    for (let k = 0; k < pyramid.order.length; k++) cv[k] = categoryCodes[pyramid.order[k]]
    return cv
  }, [categoryCodes, pyramid])
  const reorderedCodes = useMemo(() => reorderByPyramid(categoryCodes, pyramid, 1)!, [categoryCodes, pyramid])

  const effectivePalette = useMemo(
    () =>
      resolveEffectivePalette(
        Array.from({ length: categoryCount }, (_, i) => categoryNames?.[i] ?? String(i)),
      ),
    [categoryCount, categoryNames],
  )
  const paletteLut = useMemo(() => buildPaletteLUT(effectivePalette), [effectivePalette])

  const visibleSig = useMemo(() => visibleCategoryList(visibleCategories).join(','), [visibleCategories])
  const filterCategories = useMemo(
    () => (filterMode === 'category' ? visibleCategoryList(visibleCategories) : undefined),
    [filterMode, visibleSig], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // MASK path (>128 categories): a per-point 0/1 mask, reordered through the pyramid so tile slices
  // stay contiguous. Rebuilt only when the visible set changes (the honest >128-category cost).
  const reorderedMask = useMemo(
    () =>
      filterMode === 'mask'
        ? reorderByPyramid(categoryVisibilityMask(categoryCodes, visibleCategories), pyramid, 1)!
        : null,
    [filterMode, categoryCodes, visibleSig, pyramid], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── Debounced viewport re-selection (O(visible tiles); zero per-frame O(N)) ─────────────────
  const [viewportPx, setViewportPx] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const viewportRef = useRef({ w: 0, h: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      viewportRef.current = { w, h }
      setViewportPx({ w, h })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const computeSelection = useCallback(
    (camera: ViewportCamera): TileSelection => {
      const { w, h } = viewportRef.current
      const worldView = viewportWorldBounds(camera, Math.max(1, w), Math.max(1, h))
      const zoom = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number) ?? 0
      return selectTiles(pyramid, worldView, zoom, { targetPoints })
    },
    [pyramid, targetPoints],
  )

  const [selection, setSelection] = useState<TileSelection>(() => computeSelection(viewRef.current))
  const selRef = useRef(selection)
  selRef.current = selection
  const reselectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReselect = useCallback(
    (camera: ViewportCamera) => {
      if (reselectTimer.current != null) clearTimeout(reselectTimer.current)
      reselectTimer.current = setTimeout(() => {
        setSelection(computeSelection(camera))
      }, LOD_IDLE_MS)
    },
    [computeSelection],
  )
  // Recompute immediately on a pyramid/viewport/target change (not a debounced camera move).
  useEffect(() => {
    setSelection(computeSelection(viewRef.current))
  }, [computeSelection, viewportPx])

  // Read `onSelection` through a ref so the effect fires on a SELECTION change, NOT on the callback's
  // identity — a caller passing an inline `onSelection` that setStates its parent (as the story does)
  // would otherwise loop: fire → parent re-renders → new callback identity → effect re-fires → …
  // ("Maximum update depth exceeded"). Same discipline as Viz.tsx's onController/onStateChange.
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  useEffect(() => {
    onSelectionRef.current?.({
      visibleTiles: selection.visibleTileCount,
      drawnPoints: selection.drawnPoints,
      totalPoints: pyramid.total,
      level: selection.level,
      perTileBudget: selection.perTileBudget,
    })
  }, [selection, pyramid.total])

  useEffect(
    () => () => {
      if (reselectTimer.current != null) clearTimeout(reselectTimer.current)
    },
    [],
  )

  // ── B6: per-tile `data` object CACHE keyed by (tile, drawCount, filter epoch) ────────────────
  // A viewState change that leaves a tile's draw prefix identical returns the SAME cached binary
  // `data` object (same subarray refs) → deck skips the attribute rebuild. The cache is reset when
  // the underlying reordered buffers or the mask epoch change (a genuine buffer change).
  const dataCacheRef = useRef(new Map<string, { length: number; attributes: Record<string, unknown> }>())
  const bufferEpoch = useMemo(
    () => `${reorderedPositions.length}:${filterMode}:${filterMode === 'mask' ? visibleSig : 'cat'}`,
    [reorderedPositions, filterMode, visibleSig],
  )
  const lastEpoch = useRef(bufferEpoch)
  if (lastEpoch.current !== bufferEpoch) {
    dataCacheRef.current = new Map()
    lastEpoch.current = bufferEpoch
  }

  const tileData = useCallback(
    (tile: SelectedTile) => {
      const key = `${tile.tileX},${tile.tileY}:${tile.start}:${tile.drawCount}`
      const cache = dataCacheRef.current
      const hit = cache.get(key)
      if (hit) return hit
      const attributes: Record<string, unknown> = {
        getPosition: { value: tileView(reorderedPositions, tile, 2), size: 2 as const },
        getColorValue: { value: tileView(reorderedColorValue, tile, 1), size: 1 as const },
      }
      if (filterMode === 'category') {
        attributes.getFilterCategory = { value: tileView(reorderedCodes, tile, 1), size: 1 as const }
      } else if (reorderedMask) {
        attributes.getFilterValue = { value: tileView(reorderedMask, tile, 1), size: 1 as const }
      }
      const data = { length: tile.drawCount, attributes }
      cache.set(key, data)
      return data
    },
    [reorderedPositions, reorderedColorValue, reorderedCodes, reorderedMask, filterMode],
  )

  const layers = useMemo(() => {
    const filterProps =
      filterMode === 'category'
        ? { extensions: [filterExt], filterCategories }
        : { extensions: [filterExt], filterRange: [1, 1] as [number, number] }
    return selection.tiles.map(tile =>
      new ColormapScatterLayer({
        // buildScatterProps only reads positions.length for a fallback length + shape; the real
        // per-tile binary `data` (below) overrides it. B5: pickable:false on every tile layer.
        ...buildScatterProps({ positions: reorderedPositions, colors: EMPTY_COLORS, radius, pickable: false }),
        id: `tile-${tile.tileX}-${tile.tileY}`,
        data: tileData(tile),
        categorical: true,
        colormapLut: paletteLut,
        ...filterProps,
        updateTriggers: filterMode === 'mask' ? { getFilterValue: visibleSig } : {},
      } as never),
    )
  }, [
    selection, filterMode, filterExt, filterCategories, visibleSig,
    reorderedPositions, radius, paletteLut, tileData,
  ])

  const handleViewStateChange = useCallback(
    (params: { viewState: OrthographicViewState }) => {
      viewRef.current = params.viewState
      scheduleReselect(params.viewState as ViewportCamera)
      onViewStateChange?.(params.viewState)
    },
    [scheduleReselect, onViewStateChange],
  )

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-tiled-points-view"
      data-visible-tiles={selection.visibleTileCount}
      data-drawn-points={selection.drawnPoints}
      data-total-points={pointCount}
    >
      <DeckGL
        views={view}
        controller
        initialViewState={viewRef.current}
        onViewStateChange={handleViewStateChange as never}
        layers={layers}
      />
    </div>
  )
}
