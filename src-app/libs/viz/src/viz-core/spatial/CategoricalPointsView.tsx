// CategoricalPointsView.tsx — a categorical POINT-CLOUD view: N individual point dots
// (10–100M target) colored by CATEGORY with in-shader per-category show/hide.
//
// It is deliberately a THIN composition of the existing optimized scatter machinery — a
// categorical-points view IS a categorical scatter with a per-point category code + a GPU filter:
//   • `ColormapScatterLayer` (categorical palette path) colors each point in-shader from a
//     per-point code attribute + the palette LUT texture — NO CPU color loop (gpu/…).
//   • `DataFilterExtension` (@deck.gl/extensions) drives per-category show/hide, the SAME
//     mechanism GridWorkspace uses for selection. The category CODE rides a filter
//     attribute uploaded ONCE; visibility is a UNIFORM (see below).
//   • `scale/lod.ts` + `scale/adaptiveSample.ts` give the SAME zoom-gated LOD (a resident
//     budgeted subset drawn while the camera moves) and the far-zoom density-image fallback.
//   • `data/color.ts` supplies the stable categorical palette (legend swatches + LUT).
//
// ── WHY per-category show/hide is a UNIFORM update, not a re-upload ────────────────────
//
// PREFERRED path (≤128 categories → `DataFilterExtension({categorySize:1})`): each point's
// category code is in the `getFilterCategory` attribute, uploaded to the GPU exactly ONCE.
// Which categories are visible is the `filterCategories` prop, which deck folds into a
// 128-bit `categoryBitMask` (`uvec4`) UNIFORM. Toggling a category rewrites ONLY that
// uniform — positions, colors, AND the category attribute all stay on the GPU untouched,
// and there is NO per-point CPU loop on toggle. (deck applies its category→bit `transform`
// even to binary attributes — a binary buffer with a `transform` falls through to the
// auto-updater — so the per-point codes and the bitmask share one consistent map, which is
// what makes the compact-code binary path correct.)
//
// FALLBACK path (>128 categories → `DataFilterExtension({filterSize:1})`): a per-point 0/1
// `getFilterValue` mask (`categoryFilter.categoryVisibilityMask`) + `filterRange:[1,1]`. Here a
// toggle DOES rebuild + re-upload the N-length mask attribute — the honest cost past the
// 128-bit limit — but it still never touches positions/colors.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScreenGridLayer } from '@deck.gl/aggregation-layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import { ColormapScatterLayer } from '../gpu/ColormapScatterLayer'
import { buildScatterProps } from '../layers/scatter'
import { buildPaletteLUT } from '../gpu/colormapLut'
import { resolveEffectivePalette, rgbToHex, type ContinuousColormap } from '../data/color'
import { CpuRasterView } from '../density/CpuRasterView'
import { TiledPointsView } from './TiledPointsView'
import { useOverlapTooltip } from '../tooltip/useOverlapTooltip'
import { buildScatterTooltipFields, type TooltipField } from '../tooltip/tooltipModel'
import type { ReactNode } from 'react'
import type { RasterNormalize } from '../density/cpuRaster'
import { packPositions } from '../density/quantize'
import { shouldBuildPointLayers, pointColorValue } from './rasterFirst'
import { isSoftwareRenderer, resolveCpuRasterMode, readRendererString } from '../gpu/renderCapability'
import { PROBE_POINT_FLOOR, sessionMachineThreshold } from '../gpu/renderCapacity'
import { getComputeDevice } from '../gpu/computeDevice'
import { adaptiveSample, gatherByIndices, planAdaptiveCap } from '../scale/adaptiveSample'
import { boundsForPositions } from '../density/densityBin'
import {
  DENSITY_MIN_N,
  LOD_IDLE_MS,
  LOD_TARGET,
  LOD_THRESHOLD,
  estimateVisiblePoints,
  shouldUseDensity,
  viewportWorldBounds,
  type ViewportCamera,
} from '../scale/lod'
import {
  categoryVisibilityMask,
  filterModeForCategoryCount,
  visibleCategoryList,
} from './categoryFilter'
import { useCanvasKeyboard } from '../a11y/keyboardControls'
import { A11yLiveRegion, type A11yLiveRegionHandle } from '../a11y/A11yLiveRegion'
import { announceViewChange, announceEmpty } from '../a11y/liveRegion'

const EMPTY_COLORS = new Uint8Array(0)
const LOD_GRID_SIDE = 128
const DENSITY_CELL_PX = 24

/** Above this N, opt-in tiling engages under `auto` (below it, the single/chunked GPU path already
 *  pans at 60fps). An explicit `override` boolean bypasses the threshold (story + e2e determinism). */
const TILING_MIN_N = 2_000_000

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 0,
} as OrthographicViewState

export interface CategoricalPointsViewProps {
  /** interleaved xy Float32Array, length `count * 2`. */
  positions: Float32Array
  /** per-point category code, length `count`. */
  categoryCodes: Uint16Array
  /** distinct category count (palette + filter sizing). */
  categoryCount: number
  /** display names for the legend; `categoryNames[code]` names a category. */
  categoryNames?: readonly string[]
  /** which category codes are currently shown (a GPU-uniform toggle for ≤128 categories). */
  visibleCategories: ReadonlySet<number>
  /** legend checkbox handler; omit + `showLegend={false}` when the host owns the legend. */
  onToggleCategory?: (code: number, visible: boolean) => void
  radius?: number
  initialViewState?: Partial<OrthographicViewState>
  onViewStateChange?: (viewState: OrthographicViewState) => void
  /** render the built-in category legend (default true). */
  showLegend?: boolean
  /**
   * CPU-raster fast path (PERFORMANCE_PLAN.md Phase 1). ABSENT ⇒ the existing GPU point path,
   * BYTE-IDENTICAL — nothing below changes. Provide to OPT IN: when the resolved mode is active
   * the dense cloud renders as ONE CPU-binned+shaded `BitmapLayer` quad (software-renderer fast
   * path) via {@link CpuRasterView} INSTEAD of the point layers. `override` (a boolean) forces
   * ON/OFF for the story + the SwiftShader e2e; otherwise `auto` — when omitted it is detected
   * from the shared offscreen device (`isSoftwareRenderer`). The raster is count-density
   * (category-agnostic), matching the existing far-zoom density tier.
   */
  cpuRaster?: {
    /** force ON/OFF — wins over auto (tests / story toggle). */
    override?: boolean | null
    /** precomputed "software detected"; omit to auto-detect from the offscreen device. */
    auto?: boolean
    /** raster colormap (default viridis). */
    colormap?: ContinuousColormap
    /** count→shade normalization (default `log`). */
    normalize?: RasterNormalize
    /**
     * OPT IN to 16-bit position packing (PERFORMANCE_PLAN.md Phase 2): quantize xy to `Uint16`
     * (`quantize.ts`) before binning, halving the bytes transferred to the raster worker. Only
     * takes effect when the raster mode is active. Default `false` = the Float32 bin path.
     */
    packed?: boolean
    /**
     * Point count at/above which raster auto-engages on a HARDWARE GPU (default
     * {@link DEFAULT_RASTER_POINT_THRESHOLD} = 2M). Below it the GPU point path (pickable, crisp,
     * instant-zoom) is kept; at/above it the density raster protects a normal machine from the
     * large-N `GL_POINTS` degradation. Software renderers always raster regardless. Pass `Infinity`
     * to opt out of the size gate.
     */
    pointThreshold?: number
  }
  /**
   * OPT IN to OVERLAP tooltips in the CPU-RASTER path (default off). When on and the raster mode is
   * active, hovering shows the nearest-3 overlapping points + a "N more" dialog, resolved from the
   * resident `positions` + `categoryCodes` via a lazy per-instance bin index (no worker, no
   * re-stream). Inert unless `rasterActive`.
   */
  overlapTooltip?: boolean
  /**
   * GPU UNBOUNDED-SCALE tiling fast path (PERFORMANCE_PLAN.md Phase 3 / B1). ABSENT ⇒ the existing
   * single/chunked GPU point path, BYTE-IDENTICAL — nothing below changes. Provide to OPT IN: when
   * resolved active the cloud renders through {@link TiledPointsView} — a CLIENT quadtree draws only
   * the viewport's tiles at a zoom-matched budget (per-frame cost decoupled from total N) via the
   * same LUT/category/DataFilter path. `override` (boolean) forces ON/OFF for the story + e2e
   * (bypasses the N threshold); otherwise `enabled` engages `auto` above {@link TILING_MIN_N}. This
   * path is category-fidelity (individual dots), unlike the count-density `cpuRaster` fallback.
   */
  tiling?: {
    /** force ON/OFF — wins over auto + the N threshold (tests / story toggle). */
    override?: boolean | null
    /** auto-engage above the large-N threshold (default false). */
    enabled?: boolean
    /** quadtree depth → `2^maxDepth` leaf tiles/axis. */
    maxDepth?: number
    /** per-tile draw-budget cap. */
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
  /** A11Y (opt-in): when set, the view container becomes a labeled, focusable `role="application"`
   *  region (this string as its `aria-label`) AND gains keyboard camera control — arrow keys pan
   *  (Shift = larger step), `+`/`-` zoom, Enter/Space announce the category summary, Esc clear —
   *  each spoken through an off-screen ARIA live region (a GPU canvas is opaque to screen readers).
   *  Absent ⇒ no a11y chrome (byte-identical). Drives the UNCONTROLLED internal camera; keyboard nav
   *  is deliberate (not per-frame), so it re-reads the camera via a cheap `<DeckGL>` remount. */
  accessibleLabel?: string
  /** Enter/Space on the focused view (a11y). Absent ⇒ Enter/Space just re-announce the category summary. */
  onA11yActivate?: () => void
  /** Esc on the focused view (a11y). Absent ⇒ Esc announces "selection cleared". */
  onA11yClear?: () => void
  /** Observe each a11y live-region announcement (mirrors the message; for a host status line / test). */
  onA11yAnnounce?: (message: string) => void
}

/**
 * A single GPU categorical-points view. The heavy path (tens of millions of points) stays on
 * the GPU: positions + category codes upload once; a category toggle is a uniform rewrite.
 */
export function CategoricalPointsView({
  positions,
  categoryCodes,
  categoryCount,
  categoryNames,
  visibleCategories,
  onToggleCategory,
  radius = 2,
  initialViewState,
  onViewStateChange,
  showLegend = true,
  cpuRaster,
  overlapTooltip = false,
  tiling,
  accessibleLabel,
  onA11yActivate,
  onA11yClear,
  onA11yAnnounce,
}: CategoricalPointsViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pointCount = positions.length / 2

  // ── CPU-raster fast path (opt-in; ABSENT ⇒ byte-identical point path) ──────────────────────
  // When `cpuRaster` is provided we resolve whether the raster mode is active: a boolean
  // `override` wins; else `auto` — passed in, or detected from the shared offscreen device. The
  // probe runs only when opted in and no explicit auto/override is given, so existing call sites
  // (which never pass `cpuRaster`) never probe and never change behavior.
  const [softwareAuto, setSoftwareAuto] = useState(false)
  // The MEASURED, machine-adaptive size threshold (renderCapacity: probe once → clamp → localStorage
  // cache). Starts at the fixed default and is refined after the device resolves. Only pursued when
  // the caller opted into `cpuRaster` without an explicit `pointThreshold`, and the cloud clears the
  // probe floor — a small cloud never probes and never rasters on a GPU.
  const [machineThreshold, setMachineThreshold] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!cpuRaster) return
    if (typeof cpuRaster.override === 'boolean') return // override wins → skip probe
    const needsSizeGate =
      cpuRaster.pointThreshold === undefined && pointCount > PROBE_POINT_FLOOR
    if (typeof cpuRaster.auto === 'boolean' && !needsSizeGate) return // nothing to resolve
    let alive = true
    void getComputeDevice().then(dev => {
      if (!alive || !dev) return
      if (typeof cpuRaster.auto !== 'boolean') setSoftwareAuto(isSoftwareRenderer(dev))
      // Derive the machine's raster threshold from the ACTUAL GPU (session + localStorage cached).
      if (needsSizeGate) {
        setMachineThreshold(sessionMachineThreshold({ renderer: readRendererString(dev) }))
      }
    })
    return () => { alive = false }
  }, [cpuRaster, pointCount])
  const rasterActive = !!cpuRaster && resolveCpuRasterMode({
    auto: typeof cpuRaster.auto === 'boolean' ? cpuRaster.auto : softwareAuto,
    override: cpuRaster.override,
    // Size-based upgrade on a hardware GPU: engage raster once the cloud is large enough that the
    // GL_POINTS path degrades on THIS machine. Explicit prop wins; else the measured/cached machine
    // threshold; until that resolves, the fixed 2M default. `override`/software still win.
    pointCount,
    pointThreshold: cpuRaster.pointThreshold ?? machineThreshold,
  })

  // ── Overlap tooltips for the raster path (opt-in) ────────────────────────────────────────────
  // Fields from the resident category columns; a lazy per-instance bin index over `positions`
  // (built on first hover). The aggregate header names the dominant category over the hovered set.
  const overlapFields = useMemo<TooltipField[] | null>(() => {
    if (!overlapTooltip) return null
    const categories = Array.from(
      { length: categoryCount },
      (_, i) => categoryNames?.[i] ?? String(i),
    )
    return buildScatterTooltipFields({ positions, codes: categoryCodes, categories })
  }, [overlapTooltip, positions, categoryCodes, categoryCount, categoryNames])
  const overlapAggregate = useCallback(
    (ordered: Uint32Array): ReactNode => {
      const tally = new Map<number, number>()
      for (let k = 0; k < ordered.length; k++) {
        const c = categoryCodes[ordered[k]]
        tally.set(c, (tally.get(c) ?? 0) + 1)
      }
      let bestCode = -1
      let bestN = -1
      for (const [c, n] of tally) if (n > bestN) ((bestN = n), (bestCode = c))
      const name = categoryNames?.[bestCode] ?? `Category ${bestCode}`
      const pct = ordered.length ? Math.round((bestN / ordered.length) * 100) : 0
      return `${ordered.length.toLocaleString()} points · ${pct}% ${name}`
    },
    [categoryCodes, categoryNames],
  )
  const overlap = useOverlapTooltip({
    positions,
    fields: overlapFields,
    enabled: overlapTooltip && rasterActive,
    aggregate: overlapAggregate,
  })

  // GPU tiling opt-in (Phase 3): `override` boolean forces ON/OFF (bypasses the N threshold, for the
  // story + e2e); else `enabled` engages above TILING_MIN_N. Absent `tiling` ⇒ never active (the
  // byte-identical default). Raster mode wins if BOTH are set (a software box can't run GPU tiling).
  const tilingActive =
    !rasterActive &&
    !!tiling &&
    (typeof tiling.override === 'boolean'
      ? tiling.override
      : (tiling.enabled ?? false) && pointCount > TILING_MIN_N)
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const viewRef = useRef<OrthographicViewState>({ ...DEFAULT_VIEW_STATE, ...initialViewState })

  // The category→bit filter design: the uniform-update category path while it fits the
  // 128-bit mask, else the per-point mask fallback.
  const filterMode = useMemo(() => filterModeForCategoryCount(categoryCount), [categoryCount])
  const filterExt = useMemo(
    () =>
      new DataFilterExtension({
        categorySize: filterMode === 'category' ? 1 : 0,
        filterSize: filterMode === 'mask' ? 1 : 0,
      }),
    [filterMode],
  )

  // Per-point color VALUE = the category code as float (the palette LUT samples it in-shader).
  // Built ONCE — codes never change; a toggle changes only visibility, never color.
  // RASTER-FIRST (Phase 2): when the CPU-raster mode is active NONE of the GL point path is
  // rendered, so this O(N) 4·N-byte allocation (and every point-layer memo below) is SKIPPED — a
  // 10M dataset never pays it. The hooks still run in a stable order; only their BODIES early-out.
  const colorValue = useMemo(
    () => pointColorValue(categoryCodes, rasterActive),
    [categoryCodes, rasterActive],
  )
  // The EFFECTIVE per-category palette, AUTO-EXTENDED to the category count so >20 categories get
  // DISTINCT colors instead of the built-in 20-cycle. The CPU/legend path already auto-extends
  // (`resolveEffectivePalette`); threading the SAME resolved palette into the GPU LUT keeps the
  // scatter point colors === the legend swatches for ANY N. ≤20 categories resolve to the built-in
  // 20-prefix, so the SAMPLED LUT texels (codes [0, categoryCount)) stay byte-identical to the
  // pre-fix cycle. This view exposes no custom-palette/by-name overrides, so only the category
  // COUNT drives resolution — a synthetic name array of length `categoryCount` supplies it (real
  // names, when present, only matter for by-name overrides, which are absent here).
  const effectivePalette = useMemo(
    () =>
      resolveEffectivePalette(
        Array.from({ length: categoryCount }, (_, i) => categoryNames?.[i] ?? String(i)),
      ),
    [categoryCount, categoryNames],
  )
  const paletteLut = useMemo(() => buildPaletteLUT(effectivePalette), [effectivePalette])

  // A stable signature of the visible set for memo deps (the set identity changes each toggle).
  const visibleSig = useMemo(() => visibleCategoryList(visibleCategories).join(','), [visibleCategories])

  // CATEGORY path: the `filterCategories` prop (a sorted list) → deck's `categoryBitMask`
  // uniform. Changing it is the entire cost of a toggle. MASK path: the per-point 0/1 buffer,
  // rebuilt on toggle (the >128-category fallback). Only ONE is active per `filterMode`.
  const filterCategories = useMemo(
    () => (filterMode === 'category' ? visibleCategoryList(visibleCategories) : undefined),
    [filterMode, visibleSig], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const filterMask = useMemo(
    () =>
      !rasterActive && filterMode === 'mask'
        ? categoryVisibilityMask(categoryCodes, visibleCategories)
        : null,
    [rasterActive, filterMode, categoryCodes, visibleSig], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── LOD-while-interacting (reuse scale/lod.ts + adaptiveSample) ────────────────────────
  // Above LOD_THRESHOLD, keep a resident, density-adaptive, budget-capped subset RESIDENT and
  // toggle which layer draws via `visible` while the camera moves — a flag flip, never a data
  // swap, so a motion↔settle transition re-uploads nothing.
  const hasLod = pointCount > LOD_THRESHOLD
  const [interacting, setInteracting] = useState(false)
  const interactingRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLodRef = useRef(hasLod)
  hasLodRef.current = hasLod
  const markInteracting = useCallback(() => {
    if (!hasLodRef.current) return
    if (!interactingRef.current) {
      interactingRef.current = true
      setInteracting(true)
    }
    if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      interactingRef.current = false
      setInteracting(false)
    }, LOD_IDLE_MS)
  }, [])
  useEffect(() => () => { if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current) }, [])

  // RASTER-FIRST: skip the O(N) bounds scan + the O(N) adaptive-sample LOD build in raster mode
  // (CpuRasterView derives its own bounds and needs no point subset).
  const dataBounds = useMemo(
    () => (rasterActive ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : boundsForPositions(positions)),
    [positions, rasterActive],
  )
  const lodIndices = useMemo(() => {
    if (rasterActive || !hasLod) return null
    const capPerCell = planAdaptiveCap(LOD_TARGET, LOD_GRID_SIDE * LOD_GRID_SIDE)
    return adaptiveSample({
      positions,
      bounds: dataBounds,
      gridW: LOD_GRID_SIDE,
      gridH: LOD_GRID_SIDE,
      capPerCell,
      budget: LOD_TARGET,
    }).indices
  }, [rasterActive, hasLod, positions, dataBounds])

  // Gather the resident subset's buffers ONCE per (dataset / index set). The mask is gathered
  // per-toggle (mask path only); positions/codes/value are content-stable so they gather once.
  const lodPositions = useMemo(
    () => (lodIndices ? gatherByIndices(positions, lodIndices, 2) : null),
    [positions, lodIndices],
  )
  const lodColorValue = useMemo(
    () => (lodIndices ? gatherByIndices(colorValue, lodIndices, 1) : null),
    [colorValue, lodIndices],
  )
  const lodCodes = useMemo(
    () => (lodIndices ? gatherByIndices(categoryCodes, lodIndices, 1) : null),
    [categoryCodes, lodIndices],
  )
  const lodMask = useMemo(
    () => (lodIndices && filterMask ? gatherByIndices(filterMask, lodIndices, 1) : null),
    [filterMask, lodIndices],
  )
  const useLod = interacting && hasLod && !!lodPositions

  // ── Far-zoom density-image fallback (reuse scale/lod.ts) ────────────────────────────────
  // For a genuinely large cloud zoomed out so far that even the budgeted point sample draws
  // ≫1 point/pixel, swap the point layers for the GPU screen-grid COUNT image (cost ∝ cells,
  // not N), and swap back the moment zooming in drops the visible count under the budget. The
  // per-category filter is NOT applied on this "too-far-to-see-dots" overview tier (it's a
  // density heatmap of ALL points); it re-applies the instant points return.
  const densityEligible = pointCount > DENSITY_MIN_N
  const [densityOn, setDensityOn] = useState(false)
  const densityOnRef = useRef(false)
  const [viewportPx, setViewportPx] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const viewportRef = useRef({ w: 0, h: 0 })
  const densityEligibleRef = useRef(densityEligible)
  densityEligibleRef.current = densityEligible
  const pointCountRef = useRef(pointCount)
  pointCountRef.current = pointCount
  const dataBoundsRef = useRef(dataBounds)
  dataBoundsRef.current = dataBounds

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

  const commitDensity = useCallback((want: boolean) => {
    if (want === densityOnRef.current) return
    densityOnRef.current = want
    setDensityOn(want)
  }, [])
  const evalDensity = useCallback((camera: ViewportCamera) => {
    if (!densityEligibleRef.current) {
      commitDensity(false)
      return
    }
    const { w, h } = viewportRef.current
    if (w <= 0 || h <= 0) return
    const worldView = viewportWorldBounds(camera, w, h)
    const estimatedVisiblePoints = estimateVisiblePoints(pointCountRef.current, worldView, dataBoundsRef.current)
    commitDensity(
      shouldUseDensity({
        n: pointCountRef.current,
        estimatedVisiblePoints,
        pixels: w * h,
        currentlyDensity: densityOnRef.current,
      }),
    )
  }, [commitDensity])
  useEffect(() => { evalDensity(viewRef.current) }, [evalDensity, densityEligible, viewportPx, dataBounds])
  const densityActive = densityOn && densityEligible

  // STABLE binary `data` objects (deck skips all attribute work when `data` is the SAME
  // reference). Memoised on the underlying buffers ONLY, so a `visible`-toggle re-render hands
  // deck the identical reference and the toggle is ~free. Positions/codes never re-upload.
  const fullData = useMemo(() => {
    if (rasterActive) return { length: 0, attributes: {} as Record<string, unknown> }
    const attributes: Record<string, unknown> = {
      getPosition: { value: positions, size: 2 as const },
      getColorValue: { value: colorValue, size: 1 as const },
    }
    if (filterMode === 'category') attributes.getFilterCategory = { value: categoryCodes, size: 1 as const }
    else if (filterMask) attributes.getFilterValue = { value: filterMask, size: 1 as const }
    return { length: pointCount, attributes }
  }, [rasterActive, positions, colorValue, categoryCodes, filterMode, filterMask, pointCount])

  const lodData = useMemo(() => {
    if (!lodPositions) return null
    const attributes: Record<string, unknown> = {
      getPosition: { value: lodPositions, size: 2 as const },
      getColorValue: { value: lodColorValue ?? undefined, size: 1 as const },
    }
    if (filterMode === 'category' && lodCodes) attributes.getFilterCategory = { value: lodCodes, size: 1 as const }
    else if (lodMask) attributes.getFilterValue = { value: lodMask, size: 1 as const }
    return { length: lodPositions.length / 2, attributes }
  }, [lodPositions, lodColorValue, lodCodes, lodMask, filterMode])

  const densityData = useMemo(
    () => ({ length: pointCount, attributes: { getPosition: { value: positions, size: 2 as const } } }),
    [pointCount, positions],
  )

  const layers = useMemo(() => {
    // RASTER-FIRST: in CPU-raster mode the render returns <CpuRasterView/> below, so NO deck
    // ScatterplotLayer is ever constructed — the O(N) GL_POINTS allocation that stalled 10M load
    // under software never happens. Guarding here (not just at the early return) keeps the layer
    // objects from being built at all.
    if (!shouldBuildPointLayers(rasterActive)) return []
    // Far-zoom density image: a GPU COUNT screen-grid (cost ∝ cells). Replaces the points.
    if (densityActive) {
      return [
        new ScreenGridLayer({
          id: 'points-density',
          data: densityData,
          cellSizePixels: DENSITY_CELL_PX,
          cellMarginPixels: 0,
          aggregation: 'COUNT',
          colorRange: [
            [13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137],
            [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33],
          ],
          gpuAggregation: true,
          pickable: false,
        } as never),
      ]
    }
    // The shared filter props applied to BOTH the full + LOD layers.
    const filterProps =
      filterMode === 'category'
        ? { extensions: [filterExt], filterCategories }
        : { extensions: [filterExt], filterRange: [1, 1] as [number, number] }

    const buildLayer = (
      id: string,
      data: { length: number; attributes: Record<string, unknown> },
      visible: boolean,
      pickable: boolean,
    ) =>
      new ColormapScatterLayer({
        ...buildScatterProps({ positions, colors: EMPTY_COLORS, radius, pickable }),
        id,
        visible,
        data,
        categorical: true,
        colormapLut: paletteLut,
        ...filterProps,
        // MASK path only: re-upload the per-point mask when the visible set changes.
        updateTriggers: filterMode === 'mask' ? { getFilterValue: visibleSig } : {},
      } as never)

    const full = buildLayer('points-scatter', fullData, !useLod, !useLod)
    if (!hasLod || !lodData) return [full]
    const lod = buildLayer('points-scatter-lod', lodData, useLod, false)
    return [full, lod]
  }, [
    rasterActive, positions, radius, paletteLut, filterMode, filterExt, filterCategories, visibleSig,
    fullData, lodData, useLod, hasLod, densityActive, densityData,
  ])

  const handleViewStateChange = useCallback(
    (params: { viewState: OrthographicViewState }) => {
      viewRef.current = params.viewState
      markInteracting()
      evalDensity(params.viewState as ViewportCamera)
      onViewStateChange?.(params.viewState)
    },
    [markInteracting, evalDensity, onViewStateChange],
  )

  // Legend entries (stable palette swatch per code) — the SAME effective (auto-extended) palette
  // the GPU LUT samples, so a legend swatch === its scatter points for ANY category count.
  const legendEntries = useMemo(
    () =>
      Array.from({ length: categoryCount }, (_, code) => ({
        code,
        label: categoryNames?.[code] ?? `Category ${code}`,
        hex: rgbToHex(effectivePalette[code]),
      })),
    [categoryCount, categoryNames, effectivePalette],
  )

  // 16-bit packing (Phase 2, opt-in): quantize xy ONCE when the raster mode is active and packing
  // is requested, so the worker transfers half the bytes. The O(N) pack runs only in raster mode.
  const packedPositions = useMemo(
    () => (rasterActive && cpuRaster?.packed ? packPositions(positions) : undefined),
    [rasterActive, cpuRaster?.packed, positions],
  )

  // ── Accessibility (opt-in via `accessibleLabel`) ─────────────────────────────────────────
  // Keyboard camera control on the focusable container: arrows pan (Shift = larger), +/- zoom,
  // Enter/Space announce the category summary, Esc clear — each spoken through an off-screen ARIA
  // live region. Drives the UNCONTROLLED internal camera (`viewRef`); each keyboard step bumps
  // `a11yNav`, folded into the <DeckGL> `key` so deck re-reads `initialViewState` (deliberate nav,
  // NOT per-frame — cheap). `guardTarget` keeps the legend checkboxes' own Space/arrow behavior (they
  // are children of the focusable container). Only the main GPU-point path (this component's own
  // <DeckGL> below) is wired; the raster/tiling early-returns delegate to their own components.
  const a11yEnabled = accessibleLabel != null
  const liveRef = useRef<A11yLiveRegionHandle | null>(null)
  const [a11yNav, setA11yNav] = useState(0)
  const onAnnounceRef = useRef(onA11yAnnounce)
  onAnnounceRef.current = onA11yAnnounce
  const say = useCallback((m: string) => {
    liveRef.current?.announce(m)
    onAnnounceRef.current?.(m)
  }, [])
  useCanvasKeyboard({
    ref: containerRef,
    enabled: a11yEnabled,
    guardTarget: true,
    onPan: ({ dx, dy }) => {
      const v = viewRef.current
      const t = (v.target as number[] | undefined) ?? [0, 0, 0]
      // world units per key so a keypress moves a roughly-constant SCREEN distance across zooms.
      const step = 24 / 2 ** ((v.zoom as number | undefined) ?? 0)
      viewRef.current = { ...v, target: [t[0] + dx * step, t[1] + dy * step, 0] }
      setA11yNav(k => k + 1)
      evalDensity(viewRef.current as ViewportCamera) // a keyboard pan can cross the density threshold
    },
    onZoom: ({ dir }) => {
      const v = viewRef.current
      viewRef.current = { ...v, zoom: (((v.zoom as number | undefined) ?? 0) + (dir === 'in' ? 1 : -1)) }
      setA11yNav(k => k + 1)
      evalDensity(viewRef.current as ViewportCamera)
      say(announceViewChange(dir === 'in' ? 1 : -1))
    },
    onActivate: () => {
      if (onA11yActivate) onA11yActivate()
      else
        say(
          `${pointCount.toLocaleString()} points, ${visibleCategories.size} of ${categoryCount} categories shown`,
        )
    },
    onClearSelection: () => {
      onA11yClear?.()
      say(announceEmpty())
    },
  })

  // GPU tiling fast path (Phase 3): replace the whole point render with the viewport-LOD tiled
  // cloud (client quadtree; per-frame cost decoupled from N). All hooks above still ran in a stable
  // order; this branch engages only when the caller opted into `tiling` AND it resolved active.
  if (tilingActive) {
    return (
      <TiledPointsView
        positions={positions}
        categoryCodes={categoryCodes}
        categoryCount={categoryCount}
        categoryNames={categoryNames}
        visibleCategories={visibleCategories}
        radius={radius}
        initialViewState={initialViewState}
        onViewStateChange={onViewStateChange}
        maxDepth={tiling?.maxDepth}
        tilePointCap={tiling?.tilePointCap}
        targetPoints={tiling?.targetPoints}
        onSelection={tiling?.onSelection}
      />
    )
  }

  // CPU-raster fast path: replace the whole point/density render with ONE binned+shaded
  // BitmapLayer quad (software-renderer unlock). All hooks above still ran (stable order); this
  // branch only engages when the caller opted into `cpuRaster` AND the mode resolved active.
  if (rasterActive) {
    return (
      <CpuRasterView
        positions={positions}
        packed={packedPositions}
        colormap={cpuRaster?.colormap}
        normalize={cpuRaster?.normalize}
        initialViewState={initialViewState}
        onViewStateChange={onViewStateChange}
        overlap={overlapTooltip ? overlap : undefined}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      // A11Y (opt-in): a labeled, focusable region with keyboard camera control (arrows pan, +/- zoom,
      // Enter/Space announce the category summary, Esc clear) so a screen-reader / keyboard user
      // reaches AND drives the plot instead of an opaque canvas. The category-toggle legend below is
      // already button-based + keyboard-operable, and `guardTarget` keeps its Space/arrow keys.
      {...(accessibleLabel != null ? { tabIndex: 0, role: 'application', 'aria-label': accessibleLabel } : {})}
      style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}
      data-testid="viz-categorical-points-view"
      data-density-mode={densityActive ? '1' : '0'}
      data-filter-mode={filterMode}
    >
      <DeckGL
        // Keyboard nav bumps `a11yNav` → deck remounts + re-reads `initialViewState` (deliberate,
        // not per-frame). No key when a11y is off ⇒ byte-identical to before.
        key={a11yEnabled ? String(a11yNav) : undefined}
        views={view}
        controller
        initialViewState={viewRef.current}
        onViewStateChange={handleViewStateChange as never}
        layers={layers}
      />
      {/* Off-screen ARIA live region for the keyboard-a11y announcements (opt-in). */}
      {accessibleLabel != null && <A11yLiveRegion ref={liveRef} />}
      {showLegend && (
        <div
          data-testid="viz-categorical-points-legend"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            maxHeight: 'calc(100% - 16px)',
            overflowY: 'auto',
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: '20px',
          }}
        >
          {legendEntries.map(({ code, label, hex }) => {
            const shown = visibleCategories.has(code)
            return (
              <label
                key={code}
                data-testid={`viz-categorical-points-legend-item-${code}`}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={e => onToggleCategory?.(code, e.target.checked)}
                />
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: hex,
                    opacity: shown ? 1 : 0.3,
                    flex: '0 0 auto',
                  }}
                />
                <span style={{ opacity: shown ? 1 : 0.5 }}>{label}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
