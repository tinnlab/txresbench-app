// DeckScatterCanvas.tsx — the core GPU scatter canvas (ITEM-4/5). Framework-agnostic
// (viz-core): depends ONLY on @deck.gl/* + react (no @txresbench/*), so it extracts with the
// package. OrthographicView (flipY) + a ScatterplotLayer fed BINARY typed-array
// attributes (buildScatterProps). GPU picking for hover.

import { useMemo, useState, useCallback, useEffect, useRef, useContext } from 'react'
import { DeckGL } from '@deck.gl/react'
import { VizEventBusContext } from './events/EventBusContext'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScreenGridLayer } from '@deck.gl/aggregation-layers'
import { buildScatterProps, sizeAlphaForDensity, shouldAdditiveBlend } from './layers/scatter'
import { DIM_OPACITY } from './coordination/selectionSync'
import { useCanvasRecovery } from './core/contextLoss'
import { ContextLostOverlay } from './core/ContextLostOverlay'
import { useCanvasKeyboard } from './a11y/keyboardControls'
import { A11yLiveRegion, type A11yLiveRegionHandle } from './a11y/A11yLiveRegion'
import { announceViewChange, announceSelection, announceEmpty } from './a11y/liveRegion'
import { ColormapScatterLayer, SelectableScatterLayer } from './gpu/ColormapScatterLayer'
import { buildColormapLUT, buildPaletteLUT } from './gpu/colormapLut'
import { densifyGpu } from './gpu/densifyGpu'
import { getComputeDevice } from './gpu/computeDevice'
import { ensureFloat32, writeColumn, writeMaskAsFloat } from './gpu/persistentAttr'
import { adaptiveSample, gatherByIndices, planAdaptiveCap } from './scale/adaptiveSample'
import {
  DENSITY_MIN_N,
  LOD_IDLE_MS,
  LOD_TARGET,
  LOD_THRESHOLD,
  estimateVisiblePoints,
  shouldUseDensity,
  viewportWorldBounds,
  type ViewportCamera,
} from './scale/lod'
import { boundsForPositions } from './density/densityBin'
import type { SparseColumn } from './data/wire'
import type { ContinuousColormap } from './data/color'
import { VizTooltip } from './tooltip/VizTooltip'
import { useOverlapTooltip, type OverlapTooltipHandle } from './tooltip/useOverlapTooltip'
import {
  buildScatterTooltipFields,
  resolveTooltip,
  type TooltipContext,
  type TooltipField,
} from './tooltip/tooltipModel'
import { LIGHT_THEME, type VizTheme } from './theme'

export interface HoverInfo {
  index: number
  x: number
  y: number
}

/**
 * The GPU-colormap render intent (DEC-4 / ITEM-26): color each point IN THE SHADER from
 * a raw per-point value attribute + a colormap LUT texture — NO CPU color loop over N.
 * Recolor = swap `colorValue` + bump `colorEpoch` (+ optionally change `colorDomain`).
 */
export interface GpuColormapSpec {
  /**
   * per-point value, length N (continuous value OR — categorical — the code as float).
   * When `sparseValue` is provided, this is the FALLBACK value used for the first
   * frame(s) until the GPU densify resolves (then the densified result replaces it).
   */
  colorValue: Float32Array
  /**
   * OPTIONAL sparse CSC value column (`{row, value, length: N}`). When provided, the
   * canvas densifies it to a dense `Float32Array[N]` via `densifyGpu` (GPU when a compute
   * device is available, else the CPU `densify` oracle) — moving the sparse→dense scatter
   * onto the GPU end-to-end, so callers need not densify on the CPU upstream. The result
   * overrides `colorValue`. Mutually exclusive in intent with a caller-densified
   * `colorValue`, but `colorValue` is still the pre-resolve fallback.
   */
  sparseValue?: SparseColumn
  /** continuous colormap (ignored in categorical mode). */
  colormap?: ContinuousColormap
  /** [min, max] the continuous value normalizes over. */
  colorDomain?: [number, number]
  /** color-by-category: `colorValue` holds codes, sampled from the palette LUT. */
  categorical?: boolean
  /**
   * OPTIONAL effective categorical palette (code → RGB), already resolved by
   * `resolveEffectivePalette` (custom / by-name / auto-extended to ≥ category count). When
   * present, the palette LUT is built from it so the GPU-sampled hue honors the override maps;
   * absent ⇒ the built-in 20-palette LUT (byte-identical).
   */
  palette?: readonly (readonly [number, number, number])[]
  /**
   * BLEND MODE (BLEND_MODE_PLAN Phase 1). When present, `colorValue` holds CATEGORY CODES
   * (base hue from the palette LUT) and this second per-point attribute modulates the hue on
   * LIGHTNESS (default) or ALPHA. Implies categorical palette sampling. Absent ⇒ the single-
   * channel draw is byte-identical (no `getModValue` attribute, blend uniforms off).
   */
  blend?: {
    /** per-point modulation, length N → `instanceModValue`. */
    modValue: Float32Array
    /** which channel the value modulates (default 'lightness'). */
    channel: 'lightness' | 'alpha'
    /** [min,max] the modulation normalizes over (per-group ⇒ [0,1]; global ⇒ real). */
    modDomain: [number, number]
    /** the value at modulation 0 (default 0.1). */
    alphaFloor?: number
  }
}

export interface DeckScatterCanvasProps {
  /** interleaved xy Float32Array, length N*2 */
  positions: Float32Array
  /** RGBA Uint8Array, length N*4 — the CPU-precompute color path (back-compat). */
  colors?: Uint8Array
  /** the GPU in-shader colormap path (mutually exclusive with `colors`). */
  colormapMode?: GpuColormapSpec
  radius?: number
  /** additive blending for density glow */
  additive?: boolean
  initialViewState?: Partial<OrthographicViewState>
  onHover?: (info: HoverInfo | null) => void
  /** update key: bump when `colors`/`colorValue` content changes so the layer re-uploads */
  colorEpoch?: number
  /**
   * Cross-plot selection emphasis (DEC-25 / ITEM-25). A per-point 0/1 buffer
   * (`highlightMaskForPoints`, length N) marking the selected points. When present +
   * non-empty (`selectionActive`), a SINGLE layer emphasises in-shader: the per-point
   * `getSelected` attribute drives the vertex shader to dim UNselected points' alpha while
   * selected points stay full. A selection change swaps ONLY the tiny 1-float/point
   * `getSelected` attribute (+ a uniform) — no second overlay layer, no positions
   * re-upload, no per-point CPU recolor. Framework-agnostic: the adapter/caller wires the
   * Coordination store's `pointSelection` → these props (no @txresbench dependency).
   */
  highlightMask?: Uint8Array | null
  /** whether a live selection exists (dim the base + draw the overlay). */
  selectionActive?: boolean
  /** bump when `highlightMask` CONTENTS change so the overlay re-uploads its filter attr. */
  selectionEpoch?: number
  /**
   * Called on every live pan/zoom with the new view state (M2 cross-window mouse sync).
   * Fired ALONGSIDE the internal `viewRef` write (the canvas stays uncontrolled), so a
   * parent can mirror the live mouse-driven view to another window — not just toolbar
   * controls. `undefined` ⇒ no-op (the standalone/back-compat path).
   */
  onViewStateChange?: (viewState: OrthographicViewState) => void
  /**
   * CONTROLLED view state (opt-in). When provided the canvas is fully CONTROLLED: DeckGL renders
   * with this `viewState` and every user pan/zoom still flows out through `onViewStateChange` (so
   * the FREE camera is untouched — a parent that echoes the reported state straight back gets the
   * exact uncontrolled behavior). It exists so an external control (the scatter dataZoom sliders)
   * can PROGRAMMATICALLY frame a world window by setting the camera. Absent ⇒ the canvas stays
   * UNCONTROLLED (`initialViewState` + an internal `viewRef`) — byte-identical to before, with no
   * per-frame React re-render on pan. Pairs with `onViewStateChange` (required for the loop).
   */
  viewState?: OrthographicViewState
  /**
   * RICH TOOLTIP (O(1) hover). The resident columns bundle a tooltip reads by ARRAY
   * INDEXING at the picked point index — positions / codes+categories / value columns.
   * When present, the bare `point #{index}` badge is replaced by a `<VizTooltip>` built
   * from `buildScatterTooltipFields(tooltipContext)`. NO fetch on hover — every column
   * here is already resident; the hover→setState is rAF-throttled. Absent ⇒ the minimal
   * index badge (existing callers unbroken).
   */
  tooltipContext?: TooltipContext
  /**
   * Explicit CUSTOMIZED field spec (overrides the defaults built from `tooltipContext`).
   * Pass this to add/reorder fields — e.g. arbitrary resident columns. Each field's
   * accessor MUST be O(1) (read one index of a resident array).
   */
  tooltipFields?: TooltipField[]
  /**
   * OPT IN to OVERLAP tooltips (default off = the existing single-point badge, unchanged). When on,
   * a hover over stacked/overlapping points shows the nearest-3 + a "N more" affordance that opens a
   * virtual-scrolled dialog of all points at the cursor. Uses a lazy per-instance bin index over the
   * resident `positions`; needs `tooltipContext`/`tooltipFields` for the row content.
   */
  overlapTooltip?: boolean
  /** Theme-aware chrome colors for the tooltip badge; default light. */
  theme?: VizTheme
  /**
   * ACCESSIBILITY (opt-in). When provided, the canvas container becomes keyboard-focusable
   * (`tabIndex=0`, `role="application"`, this string as its `aria-label`) and gains keyboard camera
   * control — arrow keys pan (Shift = larger step), `+`/`-` zoom, Enter/Space activate, Esc clear —
   * with each change spoken through an off-screen ARIA live region (a canvas is opaque to screen
   * readers). Absent ⇒ NO a11y chrome (byte-identical to before; e.g. the perf-benchmark mounts).
   * Only drives the UNCONTROLLED internal camera (a `viewState`-controlled canvas ignores keyboard pan/
   * zoom so it can't fight the external control).
   */
  accessibleLabel?: string
  /** Enter/Space on the focused canvas (a11y). Absent ⇒ Enter/Space just re-announce the point count. */
  onA11yActivate?: () => void
  /** Esc on the focused canvas (a11y). Absent ⇒ Esc announces "selection cleared". */
  onA11yClear?: () => void
  /** Observe each a11y live-region announcement (mirrors the message; for a host status line / test). */
  onA11yAnnounce?: (message: string) => void
}

// NOTE (follow-up): GridWorkspace's per-cell selection overlay still builds a SECOND
// ScatterplotLayer for the selected subset (re-uploading a full positions copy per
// selection). It should get the SAME single-layer in-shader `getSelected` treatment
// applied here (SelectableScatterLayer / ColormapScatterLayer) — tracked as a follow-up;
// GridWorkspace is intentionally NOT edited in this change.

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

// Placeholder RGBA for the GPU path (getFillColor is discarded there) / an absent
// CPU buffer. The GPU path colors entirely from getColorValue + the LUT texture.
const EMPTY_COLORS = new Uint8Array(0)

// Adaptive LOD sampler grid (research item #4a): a fixed 128×128 grid over the DATA extent, so
// the per-cell cap flattens on-screen density (dense clusters capped, sparse structure kept)
// while the total stays within the LOD_TARGET budget. 128² cells ⇒ cap ≈ ceil(1M/16384) ≈ 62.
const LOD_GRID_SIDE = 128

// Density-aggregate image tuning (research item #1). One cell ≈ this many screen px (mirrors
// DensityView's default). `DENSITY_DEBOUNCE_MS` delays a points↔density flip so a fast gesture
// that momentarily crosses the boundary doesn't thrash the render (paired with the hysteresis
// band in `shouldUseDensity`).
const DENSITY_CELL_PX = 24
const DENSITY_DEBOUNCE_MS = 120

// Overdraw-bounding "dense points" regime (research item #5). Only engage the size/alpha/blend-by-
// density treatment for a genuinely large cloud — below this a full-detail opaque draw is already
// cheap AND wanted (crisp), so small-N / back-compat stays byte-identical (DEFAULT-SAFE). It sits
// BELOW `DENSITY_MIN_N` (3M): the dense-points regime engages long before the far-zoom density
// image replaces points entirely, covering the "points but dense" middle band.
const DENSE_STYLE_MIN_N = 250_000
// Commit a new dense-style only when it moves past these deltas, so a continuous zoom sweep
// triggers a handful of React re-renders (each a cheap uniform/param update on stably-referenced
// `data`), never one per frame. The `data` reference stays identical ⇒ deck re-uploads nothing.
const DENSE_STYLE_RADIUS_EPS = 0.05
const DENSE_STYLE_ALPHA_EPS = 0.02

/**
 * Sample a continuous colormap into a discrete stop list for ScreenGridLayer's `colorRange`
 * (low weight → high weight). Reuses the SAME 256-entry LUT (`buildColormapLUT`) as the point
 * path + the DOM colorbar, so a density cell's mean-per-bin color is consistent with a scatter
 * point of the same value. (A local copy of DensityView's helper — DensityView is intentionally
 * not edited; the density image is rendered IN THIS canvas so the single controller keeps
 * tracking the view state and the points↔density hysteresis works in BOTH directions.)
 */
function densityColorRange(colormap: ContinuousColormap): [number, number, number][] {
  const lut = buildColormapLUT(colormap)
  const steps = 12
  const range: [number, number, number][] = []
  for (let i = 0; i < steps; i++) {
    const k = Math.round((i / (steps - 1)) * 255)
    const o = k * 4
    range.push([lut[o], lut[o + 1], lut[o + 2]])
  }
  return range
}

/**
 * A memoised GATHER of a per-point buffer down to the LOD sample's kept indices (research items
 * #3/#4). `gatherByIndices` copies the selected points into a compact buffer — built AT MOST
 * ONCE per (source contents / index set), never per frame. `versionKey` invalidates it when a
 * PERSISTENT source buffer's CONTENTS change under a stable reference (recolor bumps colorEpoch,
 * reselect bumps selectionEpoch), so the view refreshes even though the source array identity
 * did not. An absent source / index set returns the source unchanged (no allocation).
 */
function useGatheredView<T extends Float32Array | null | undefined>(
  source: T,
  indices: Uint32Array | null,
  elemsPerPoint: number,
  versionKey: number,
): T {
  return useMemo(() => {
    if (!source || !indices) return source
    return gatherByIndices(source as Float32Array, indices, elemsPerPoint) as T
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, indices, elemsPerPoint, versionKey])
}

/** A single GPU scatter view. The heavy path (millions of points) stays on the GPU. */
export function DeckScatterCanvas({
  positions,
  colors,
  colormapMode,
  radius = 2,
  additive = false,
  initialViewState,
  onHover,
  colorEpoch = 0,
  highlightMask,
  selectionActive = false,
  selectionEpoch = 0,
  onViewStateChange,
  viewState: controlledViewState,
  tooltipContext,
  tooltipFields,
  overlapTooltip = false,
  theme = LIGHT_THEME,
  accessibleLabel,
  onA11yActivate,
  onA11yClear,
  onA11yAnnounce,
}: DeckScatterCanvasProps) {
  const [hovered, setHovered] = useState<HoverInfo | null>(null)
  const emphasise = selectionActive && !!highlightMask

  // WebGL context-loss recovery (ITEM-57): watch the deck canvas for lost/restored.
  // On restore, `restoreKey` bumps → we remount <DeckGL> so it re-creates its layers
  // and RE-UPLOADS buffers from props (positions/colors are still in JS memory — a
  // GPU re-upload, not a data reload). While lost, a non-blocking badge replaces the
  // blank canvas.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { lost, restoreKey } = useCanvasRecovery(containerRef)

  // Live view-state preservation across the recovery remount (M1). This canvas is
  // UNCONTROLLED (initialViewState + controller, no viewState/onViewStateChange), so
  // `initialViewState` is read only at mount. When `restoreKey` bumps on
  // `webglcontextrestored`, <DeckGL> remounts and re-reads it — feeding the STATIC
  // default here would throw away the user's current pan/zoom. Instead we keep the
  // last-known view in a ref (updated every interaction via onViewStateChange below)
  // and feed THAT as initialViewState, so the post-remount mount restores the last
  // view rather than jumping back to default. Staying uncontrolled (ref, not a
  // `viewState` prop) means normal panning/zooming still runs Deck-internally with no
  // per-frame React re-render.
  const viewRef = useRef<OrthographicViewState>({
    ...DEFAULT_VIEW_STATE,
    ...initialViewState,
  })

  // LOD-while-panning (OPT-1). `interacting` flips true on the first camera change of a gesture
  // and back to false `LOD_IDLE_MS` after the LAST change (a debounce that bridges the gaps
  // between the discrete wheel/drag events of one continuous pan). While interacting AND N is
  // above the LOD threshold we render a uniform strided subset (~1M) so the pipeline pushes ~10×
  // fewer instances per frame; the moment the camera settles we swap back to the full N for full
  // detail. The `interactingRef` guard means we set React state only on the true idle↔active
  // EDGES — never once per pan frame — so continuous panning stays a Deck-internal redraw with
  // no per-frame React re-render.
  const [interacting, setInteracting] = useState(false)
  const interactingRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the large-N (above-threshold) path has an LOD layer to toggle; below it, tracking
  // interaction would only cost wasted re-renders. `lodEligibleRef` (updated each render once
  // `hasLod` is known) short-circuits `markInteracting` so small-N pans stay a pure Deck-internal
  // redraw with ZERO React re-render — a guaranteed no-op for 1M / 100k / 10k.
  const lodEligibleRef = useRef(false)
  const markInteracting = useCallback(() => {
    if (!lodEligibleRef.current) return
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
  useEffect(
    () => () => {
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current)
    },
    [],
  )

  // GPU densify (ITEM-27): when the caller passes a SPARSE value column, densify it to a
  // dense Float32Array[N] via `densifyGpu` (GPU when a compute device exists, else the CPU
  // `densify` oracle) instead of requiring the caller to densify on the CPU upstream. The
  // async result lands in state + bumps a local epoch so the ColormapScatterLayer re-uploads.
  const sparseValue = colormapMode?.sparseValue
  const [densified, setDensified] = useState<Float32Array | null>(null)
  const [densifyEpoch, setDensifyEpoch] = useState(0)

  useEffect(() => {
    if (!sparseValue) {
      setDensified(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const device = await getComputeDevice()
        const dense = await densifyGpu(sparseValue, device)
        if (!cancelled) {
          setDensified(dense)
          setDensifyEpoch(e => e + 1)
        }
      } catch (err) {
        // Densify failed (no compute device / GPU error): keep `densified` null so the layer
        // falls back to the caller-supplied dense `colorValue` (effectiveColorValue) instead of
        // leaving an unhandled rejection. Defensive — mirrors the View robustness work.
        if (!cancelled) {
          console.error('[DeckScatterCanvas] densify failed; using colorValue fallback', err)
          setDensified(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sparseValue])

  // The value attribute the layer colors from: the densified sparse column once ready,
  // else the caller-supplied dense `colorValue` (a caller-densified column, or the
  // pre-resolve fallback while the async densify is in flight).
  const effectiveColorValue =
    sparseValue && densified ? densified : colormapMode?.colorValue

  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])

  // Selection emphasis (single-layer): a per-point 0/1 selected attribute. The caller's
  // `highlightMask` is a Uint8Array; deck's instanced attribute is float32, so it must be
  // widened — but into a PERSISTENT reused Float32Array (OPT-2), not a fresh
  // `new Float32Array(mask)` (~40MB at 10M) per selection. We reuse one buffer sized to the
  // point count and write the mask into it in place; deck then re-uploads it (bufferSubData
  // into its existing GPU buffer) on the bumped `selectionEpoch`, so a selection change
  // re-uploads only the tiny getSelected attribute with NO large allocation feeding the GC.
  const selectedBufRef = useRef<Float32Array | null>(null)
  const selectedValue = useMemo(() => {
    if (!emphasise || !highlightMask) return null
    const buf = ensureFloat32(selectedBufRef.current, highlightMask.length)
    selectedBufRef.current = buf
    writeMaskAsFloat(buf, highlightMask)
    return buf
    // selectionEpoch bumps when the mask CONTENTS change under a stable reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emphasise, highlightMask, selectionEpoch])

  // Persistent color-value buffer (OPT-2). The GPU colormap path colors from a per-point value
  // attribute; a recolor swaps the value column. Rather than hold whichever fresh array the
  // caller passes (an app that generates a new column per recolor churns ~40MB/interaction), we
  // copy the active column into ONE reused Float32Array and hand deck that stable reference. On
  // recolor we bump `colorEpoch`, deck re-uploads (bufferSubData) the persistent buffer, and no
  // per-recolor large allocation lands on the heap. Positions are never touched.
  const colorBufRef = useRef<Float32Array | null>(null)
  const persistentColorValue = useMemo(() => {
    if (!effectiveColorValue) return undefined
    const buf = ensureFloat32(colorBufRef.current, effectiveColorValue.length)
    colorBufRef.current = buf
    writeColumn(buf, effectiveColorValue)
    return buf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveColorValue, colorEpoch, densifyEpoch])

  // Blend mode (BLEND_MODE_PLAN Phase 1): a SECOND per-point attribute (`instanceModValue`)
  // modulates the palette base hue. Held in ONE persistent buffer like `persistentColorValue`
  // (no per-recolor allocation), bound ONLY when a blend spec is present; absent ⇒ the layer's
  // `getModValue` default (0) + `blendEnabled:false` make the draw byte-identical to single-channel.
  const blendSpec = colormapMode?.blend
  const blendActive = !!blendSpec
  const modBufRef = useRef<Float32Array | null>(null)
  const persistentModValue = useMemo(() => {
    if (!blendSpec) return undefined
    const buf = ensureFloat32(modBufRef.current, blendSpec.modValue.length)
    modBufRef.current = buf
    writeColumn(buf, blendSpec.modValue)
    return buf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendSpec, colorEpoch])

  // LOD-while-panning (OPT-1) sampled views. When N is above the threshold we keep a SECOND,
  // downsampled (~1M) layer resident ALONGSIDE the full layer and toggle which one draws via
  // the `visible` flag (see the layer memo) — a flag flip, NOT a data swap, so a
  // motion↔settle transition NEVER re-uploads the big positions/color buffers (the whole point:
  // "only the changed attribute re-uploads, never positions"). That means the sampled buffers
  // must stay resident + current, so they're built EAGERLY (not gated on interacting): once for
  // positions (never change post-load) and refreshed on recolor/reselect for color/selected via
  // the version key. The gather is memoised, so this is at most one pass per content change,
  // never per frame.
  const pointCount = positions.length / 2
  const hasLod = pointCount > LOD_THRESHOLD && !!colormapMode
  lodEligibleRef.current = hasLod
  const useLod = interacting && hasLod

  // The world-space extent of the whole cloud (memoised on positions) — the domain the adaptive
  // LOD grid tiles over, and (with the live viewport) the input to the density-switch decision.
  const dataBounds = useMemo(() => boundsForPositions(positions), [positions])

  // The resident LOD sample (research items #3+#4): a STABLE, DENSITY-ADAPTIVE, budget-capped
  // subset of point indices — built ONCE per dataset (viewport-independent, over the data
  // extent), not a per-frame re-pick. Walking buffer order (a fixed order) makes it superset-
  // stable (the subset is ⊂ the full set, so settling to full detail only ADDS points — never
  // repositions one ⇒ no LOD "pop"); the per-cell cap flattens on-screen density so dense
  // clusters don't eat the whole budget; the budget bounds the drawn count at LOD_TARGET.
  const lodIndices = useMemo(() => {
    if (!hasLod) return null
    const gridW = LOD_GRID_SIDE
    const gridH = LOD_GRID_SIDE
    const capPerCell = planAdaptiveCap(LOD_TARGET, gridW * gridH)
    return adaptiveSample({ positions, bounds: dataBounds, gridW, gridH, capPerCell, budget: LOD_TARGET }).indices
  }, [hasLod, positions, dataBounds])

  const lodPositions = useGatheredView(hasLod ? positions : null, lodIndices, 2, 0)
  const lodColorValue = useGatheredView(
    hasLod ? persistentColorValue : null,
    lodIndices,
    1,
    colorEpoch + densifyEpoch,
  )
  const lodModValue = useGatheredView(
    hasLod ? persistentModValue ?? null : null,
    lodIndices,
    1,
    colorEpoch,
  )
  const lodSelected = useGatheredView(hasLod ? selectedValue : null, lodIndices, 1, selectionEpoch)

  // ── Density-aggregate auto-switch (research item #1) ──────────────────────────────────────
  // For a genuinely large dataset (> DENSITY_MIN_N) that is zoomed out far enough that even the
  // budgeted point sample would draw ≫ 1 point/pixel, we swap the point layers for the GPU
  // density-aggregate image (a ScreenGridLayer, cost ∝ on-screen cells not N) — and swap BACK to
  // points the moment zooming in drops the visible count under the budget. The decision is pure
  // (`shouldUseDensity`, hysteretic) + debounced. It is rendered in THIS canvas (not the separate
  // DensityView component) so the single OrthographicView controller keeps reporting view-state
  // changes — that live view is exactly what the switch-BACK-to-points test needs, and DensityView
  // exposes no onViewStateChange to surface it. Only engaged when a value column is available to
  // color the mean-per-bin; ≤ DENSITY_MIN_N is byte-for-byte the existing point path.
  const densityEligible = pointCount > DENSITY_MIN_N && !!colormapMode && !!effectiveColorValue
  const [densityOn, setDensityOn] = useState(false)
  const densityOnRef = useRef(false)
  const densityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [viewportPx, setViewportPx] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const viewportRef = useRef({ w: 0, h: 0 })
  // Latch the inputs the (stable) evaluator reads through refs so it needn't be re-created.
  const densityEligibleRef = useRef(densityEligible)
  densityEligibleRef.current = densityEligible
  const pointCountRef = useRef(pointCount)
  pointCountRef.current = pointCount
  const dataBoundsRef = useRef(dataBounds)
  dataBoundsRef.current = dataBounds

  // Measure the canvas so the density-switch density (points/pixel) tracks the real viewport.
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

  // Evaluate the mode for a camera pose (hysteretic + debounced). Called on every view change and
  // on mount/eligibility changes. A flip is delayed by DENSITY_DEBOUNCE_MS and cancelled if the
  // desired mode reverts before it fires, so a quick boundary-crossing gesture doesn't thrash.
  const evalDensity = useCallback(
    (camera: ViewportCamera) => {
      const clearPending = () => {
        if (densityTimerRef.current != null) {
          clearTimeout(densityTimerRef.current)
          densityTimerRef.current = null
        }
      }
      if (!densityEligibleRef.current) {
        clearPending()
        commitDensity(false)
        return
      }
      const { w, h } = viewportRef.current
      if (w <= 0 || h <= 0) return
      const view = viewportWorldBounds(camera, w, h)
      const estimatedVisiblePoints = estimateVisiblePoints(pointCountRef.current, view, dataBoundsRef.current)
      const want = shouldUseDensity({
        n: pointCountRef.current,
        estimatedVisiblePoints,
        pixels: w * h,
        currentlyDensity: densityOnRef.current,
      })
      if (want === densityOnRef.current) {
        clearPending()
        return
      }
      clearPending()
      densityTimerRef.current = setTimeout(() => {
        densityTimerRef.current = null
        commitDensity(want)
      }, DENSITY_DEBOUNCE_MS)
    },
    [commitDensity],
  )

  // Re-evaluate on mount + whenever eligibility / viewport / data extent changes (the initial
  // zoomed-out large-N view engages density with NO user interaction — important for a cold load).
  useEffect(() => {
    evalDensity(viewRef.current)
  }, [evalDensity, densityEligible, viewportPx, dataBounds])
  useEffect(
    () => () => {
      if (densityTimerRef.current != null) clearTimeout(densityTimerRef.current)
    },
    [],
  )
  const densityActive = densityOn && densityEligible

  // ── Overdraw-bounding dense-points style (research item #5) ────────────────────────────────
  // In the "points but dense" regime (denser than crisp zoomed-in, not yet the far-zoom density
  // image) we shrink the point radius + lower per-point alpha with on-screen density, and — past a
  // hysteretic threshold — SUM overlapping points additively into a density field. This BOUNDS the
  // fragment (overdraw) cost AND stops a zoomed-out cloud from painting an opaque saturated blob.
  // The (radius, alpha, additive) triple is derived from the SAME viewport-density estimate the
  // density-switch uses, evaluated on view change but committed only when it crosses a step (so a
  // zoom sweep is a handful of cheap re-renders, never one per frame). DEFAULT-SAFE: for small N or
  // a sparse/zoomed-in view it resolves to identity {radius: props.radius, alpha: 1, additive} and
  // never changes — byte-identical to the pre-existing crisp path.
  const [denseStyle, setDenseStyle] = useState<{ radius: number; alpha: number; additive: boolean }>(
    { radius, alpha: 1, additive },
  )
  const denseStyleRef = useRef(denseStyle)
  denseStyleRef.current = denseStyle
  const radiusRef = useRef(radius)
  radiusRef.current = radius
  const additivePropRef = useRef(additive)
  additivePropRef.current = additive

  const commitDenseStyle = useCallback(
    (next: { radius: number; alpha: number; additive: boolean }) => {
      const cur = denseStyleRef.current
      if (
        cur.additive === next.additive &&
        Math.abs(cur.radius - next.radius) < DENSE_STYLE_RADIUS_EPS &&
        Math.abs(cur.alpha - next.alpha) < DENSE_STYLE_ALPHA_EPS
      ) {
        return
      }
      denseStyleRef.current = next
      setDenseStyle(next)
    },
    [],
  )

  // Evaluate the dense-points style for a camera pose. Reads live inputs through refs so the
  // callback stays stable (no re-create per render). Runs alongside `evalDensity` on view change
  // + mount/eligibility changes. Independent of the density-switch eligibility (that needs N>3M;
  // this engages at N>250k), so it correctly drives the 1M "dense points" case the density image
  // never reaches.
  const evalDenseStyle = useCallback(
    (camera: ViewportCamera) => {
      const { w, h } = viewportRef.current
      const eligible = pointCountRef.current > DENSE_STYLE_MIN_N
      // While the density-aggregate IMAGE is showing, the point layers aren't drawn, so the
      // dense-points style is moot — hold it at identity so a pan (which shifts the visible-point
      // estimate) doesn't churn the `layers` memo and force a costly ScreenGrid re-aggregation.
      if (!eligible || densityOnRef.current || w <= 0 || h <= 0) {
        commitDenseStyle({ radius: radiusRef.current, alpha: 1, additive: additivePropRef.current })
        return
      }
      const view = viewportWorldBounds(camera, w, h)
      const estimatedVisiblePoints = estimateVisiblePoints(pointCountRef.current, view, dataBoundsRef.current)
      const density = estimatedVisiblePoints / Math.max(1, w * h)
      const { radius: r, alpha } = sizeAlphaForDensity(density, radiusRef.current)
      const additiveNow =
        additivePropRef.current || shouldAdditiveBlend(density, denseStyleRef.current.additive)
      commitDenseStyle({ radius: r, alpha, additive: additiveNow })
    },
    [commitDenseStyle],
  )

  // Re-evaluate on mount + whenever eligibility / viewport / data extent changes (a cold load that
  // opens zoomed-out on a large cloud engages the dense style with NO user interaction) — AND whenever
  // the `radius`/`additive` PROPS change, so a "point size" / "additive glow" control takes effect
  // immediately instead of sticking at the mount value until the next pan/zoom (evalDenseStyle reads
  // both via refs, so they must be listed here to drive the re-eval).
  useEffect(() => {
    evalDenseStyle(viewRef.current)
  }, [evalDenseStyle, pointCount, viewportPx, dataBounds, radius, additive])

  // The GPU-colormap LUT: rebuilt only when the colormap / categorical MODE changes (256×4
  // bytes), NEVER per point and NEVER on recolor/select/domain change. Depending on the
  // stable primitive keys (not the `colormapMode` object identity, which callers commonly
  // recreate each render) keeps the LUT reference stable across recolors, so the on-device
  // LUT texture is built ONCE instead of destroyed+recreated every render. `null` when the
  // CPU `colors` path is in use.
  const cmColormap = colormapMode?.colormap
  const cmCategorical = colormapMode?.categorical ?? false
  const cmPalette = colormapMode?.palette
  const hasColormap = !!colormapMode
  const colormapLut = useMemo(() => {
    if (!hasColormap) return null
    // Blend mode samples the base hue from the categorical palette (colorValue holds codes),
    // so it uses the palette LUT regardless of the `categorical` flag. The optional effective
    // palette (custom / by-name / auto-extended) drives the LUT when supplied.
    return cmCategorical || blendActive
      ? buildPaletteLUT(cmPalette)
      : buildColormapLUT(cmColormap ?? 'viridis')
  }, [hasColormap, cmCategorical, cmColormap, blendActive, cmPalette])

  // Discrete color-range for the density-aggregate image (mean-per-bin), from the SAME colormap
  // as the points so a density cell reads consistently with a point of that value. Categorical
  // color-by has no meaningful per-bin mean, so density falls back to the continuous viridis ramp.
  const densityColorStops = useMemo(() => densityColorRange(cmColormap ?? 'viridis'), [cmColormap])

  // STABLE binary `data` objects (CRITICAL for the LOD re-render cost). deck skips ALL
  // attribute work when a layer's `data` prop is the SAME REFERENCE as last render
  // (`changeFlags.dataChanged === false`). The LOD motion↔settle transition rebuilds the layer
  // objects to flip `visible`, so if the `data` object were rebuilt too, deck would re-validate
  // 10M attributes on every toggle (~400ms each — that regression is exactly what an earlier
  // draft hit). By memoising `data` on the underlying buffers ONLY (not on `interacting`), a
  // visible-toggle re-render hands deck the identical `data` reference ⇒ deck touches nothing
  // but the `visible`/domain uniforms ⇒ the toggle is ~free even under a churny drag. The
  // persistent color buffer keeps `data` stable across recolors too (its reference never
  // changes). getPosition never changes ⇒ positions never re-upload.
  const fullData = useMemo(() => {
    const attributes: Record<string, unknown> = {
      getPosition: { value: positions, size: 2 as const },
      getColorValue: { value: persistentColorValue, size: 1 as const },
    }
    if (persistentModValue) attributes.getModValue = { value: persistentModValue, size: 1 as const }
    if (selectedValue) attributes.getSelected = { value: selectedValue, size: 1 as const }
    return { length: positions.length / 2, attributes }
  }, [positions, persistentColorValue, persistentModValue, selectedValue])
  const lodData = useMemo(() => {
    if (!hasLod || !lodPositions) return null
    const attributes: Record<string, unknown> = {
      getPosition: { value: lodPositions, size: 2 as const },
      getColorValue: { value: lodColorValue ?? undefined, size: 1 as const },
    }
    if (lodModValue) attributes.getModValue = { value: lodModValue, size: 1 as const }
    if (lodSelected) attributes.getSelected = { value: lodSelected, size: 1 as const }
    return { length: lodPositions.length / 2, attributes }
  }, [hasLod, lodPositions, lodColorValue, lodModValue, lodSelected])

  // STABLE density-grid `data` (same rationale as `fullData`): the ScreenGridLayer must get an
  // IDENTICAL `data` reference across `layers`-memo re-runs, or deck sees `dataChanged` and re-runs
  // the (expensive at 10M) GPU aggregation. Memoised on the underlying buffers ONLY, so a re-run
  // from any OTHER dep (e.g. a dense-style commit) hands deck the same object ⇒ no re-aggregation.
  const densityData = useMemo(
    () => ({
      length: pointCount,
      attributes: {
        getPosition: { value: positions, size: 2 as const },
        getWeight: { value: effectiveColorValue ?? undefined, size: 1 as const },
      },
    }),
    [pointCount, positions, effectiveColorValue],
  )

  const layers = useMemo(() => {
    // Density-aggregate tier (research item #1): the whole point cloud is too dense to read as
    // dots at this zoom, so draw the GPU screen-grid density image (cost ∝ cells, not N) colored
    // by the MEAN of the value column per bin. Replaces (not overlays) the point layers; the
    // controller/onViewStateChange keep running so zooming in flips back to points.
    if (densityActive && colormapMode && effectiveColorValue) {
      // Categorical color-by has no meaningful per-bin mean (the value column holds category
      // CODES as floats, so MEAN-of-codes is garbage). Color by POINT DENSITY instead
      // (aggregation COUNT — meaningful + honest), with an auto-scaled count domain. Only the
      // continuous/value mode keeps MEAN-per-bin with its caller-supplied value domain.
      const categorical = cmCategorical
      return [
        new ScreenGridLayer({
          id: 'viz-density-grid',
          data: densityData,
          cellSizePixels: DENSITY_CELL_PX,
          cellMarginPixels: 0,
          aggregation: categorical ? 'COUNT' : 'MEAN',
          colorRange: densityColorStops,
          colorScaleType: 'linear',
          // COUNT: auto-scale to the per-cell count range (null); MEAN: the value domain.
          colorDomain: categorical ? null : (colormapMode.colorDomain ?? null),
          gpuAggregation: true,
          pickable: false,
          updateTriggers: {
            // `getPosition`'s value (`positions`) is reference-stable and never changes on
            // recolor, so tie its trigger to the buffer identity ONLY. Tying it to `colorEpoch`
            // forced deck to re-upload the whole 10M×2×f32 (~80MB) position buffer on every
            // recolor while density mode was active (M1). `getWeight` (the value column) DOES
            // change on recolor/densify, so it keeps the epoch triggers.
            getPosition: [positions],
            getWeight: [colorEpoch, densifyEpoch],
          },
        } as never),
      ]
    }
    // GPU path: color in-shader from a raw value attribute + a colormap LUT texture.
    if (colormapMode && colormapLut && effectiveColorValue) {
      const buildGpuLayer = (
        id: string,
        data: { length: number; attributes: Record<string, unknown> },
        visible: boolean,
        pickable: boolean,
      ) =>
        new ColormapScatterLayer({
          ...buildScatterProps({
            positions,
            colors: EMPTY_COLORS,
            radius: denseStyle.radius,
            additive: denseStyle.additive,
            pickable,
          }),
          id,
          visible,
          data,
          // per-point opacity from the density ramp (shader multiplies vFillColor.a * layer.opacity,
          // for both continuous + categorical): translucent in the dense regime, 1 when crisp.
          opacity: denseStyle.alpha,
          // Blend mode samples the palette (colorValue = codes); else honor the caller's flag.
          colorDomain: colormapMode.colorDomain ?? [0, 1],
          categorical: (colormapMode.categorical ?? false) || blendActive,
          colormapLut,
          // blend uniforms — off (byte-identical) unless a blend spec is present.
          blendEnabled: blendActive,
          blendChannel: blendSpec?.channel ?? 'lightness',
          modDomain: blendSpec?.modDomain ?? [0, 1],
          alphaFloor: blendSpec?.alphaFloor ?? 0.1,
          // in-shader emphasis: dim the UNselected points while a selection is active.
          selectionActive: emphasise,
          dimOpacity: DIM_OPACITY,
          // re-upload getColorValue/getModValue when the caller bumps colorEpoch OR the GPU
          // densify resolves; re-upload getSelected only when the selection CONTENTS change.
          updateTriggers: {
            getColorValue: [colorEpoch, densifyEpoch],
            getModValue: [colorEpoch],
            getSelected: [selectionEpoch],
          },
        } as never)

      // LOD-while-panning (OPT-1): above the threshold, keep BOTH a full-detail layer AND a
      // downsampled (~1M) LOD layer RESIDENT and toggle which draws via `visible`. A
      // motion↔settle transition is then just a flag flip on immutable, stably-referenced
      // `data` — no re-upload, no attribute re-validation. The full layer stays pickable (hover
      // on the full set when idle); the LOD layer isn't pickable (no hover mid-pan). Below the
      // threshold: a single full layer, no LOD overhead. The full layer is NOT pickable while a
      // large-N motion is in progress (`!useLod`): deck runs a picking pass (render the 10M
      // point cloud into the picking framebuffer + a synchronous glReadPixels) on every
      // pointer move, and that readback is a main-thread stall at 10M — pointless mid-pan (no
      // one hovers while dragging). Hover/pick returns the instant the camera settles.
      const full = buildGpuLayer('viz-scatter', fullData, !useLod, !useLod)
      if (!hasLod || !lodData) return [full]
      const lod = buildGpuLayer('viz-scatter-lod', lodData, useLod, false)
      return [full, lod]
    }
    // CPU path (back-compat): a precomputed RGBA buffer. Same single-layer in-shader
    // selection emphasis via SelectableScatterLayer (no overlay layer). No LOD here (the
    // strided-color length bookkeeping isn't worth it for the small-N/back-compat path).
    const props = buildScatterProps({
      positions,
      colors: colors ?? EMPTY_COLORS,
      radius: denseStyle.radius,
      additive: denseStyle.additive,
      pickable: true,
    })
    const cpuAttributes: Record<string, unknown> = { ...props.data.attributes }
    if (selectedValue) cpuAttributes.getSelected = { value: selectedValue, size: 1 as const }
    return [
      new SelectableScatterLayer({
        ...props,
        data: { length: props.data.length, attributes: cpuAttributes },
        // per-point opacity from the density ramp (base ScatterplotLayer multiplies by layer.opacity).
        opacity: denseStyle.alpha,
        selectionActive: emphasise,
        dimOpacity: DIM_OPACITY,
        // updateTriggers so a same-reference color buffer whose CONTENTS changed re-uploads.
        updateTriggers: { getFillColor: colorEpoch, getSelected: [selectionEpoch] },
      } as never),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    positions,
    colors,
    colormapMode,
    colormapLut,
    effectiveColorValue,
    denseStyle,
    colorEpoch,
    densifyEpoch,
    emphasise,
    selectedValue,
    selectionEpoch,
    hasLod,
    useLod,
    fullData,
    lodData,
    densityActive,
    densityColorStops,
    densityData,
    pointCount,
    cmCategorical,
    blendActive,
    blendSpec,
  ])

  // rAF-throttled hover→setState: rapid mouse movement fires deck's onHover many times per
  // frame; we coalesce to ONE React state update per animation frame. The DATA access
  // itself is immediate (O(1) index in the render) — only the render is batched. The
  // external `onHover` callback fires immediately (uncoalesced) for back-compat.
  //
  // EVENT_API_PLAN Phase 2 `hover`: when a `<Viz>` event bus is present (else `null` — a bare
  // canvas / pop-out / story emits nothing, byte-identical), fan a typed `hover` event from the SAME
  // rAF flush (reusing this throttle — NOT a second one), carrying the picked point index (`null` on
  // leave). Additive to the immediate `onHover` prop, which is untouched.
  const bus = useContext(VizEventBusContext)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<HoverInfo | null>(null)
  // Overlap-tooltip handle, read at hover time (assigned below once `scatterFields` exists). A ref so
  // `handleHover` doesn't churn its deps and can be defined before the hook.
  const overlapApiRef = useRef<OverlapTooltipHandle | null>(null)
  const flush = useCallback(() => {
    rafRef.current = null
    const next = pendingRef.current
    setHovered(next)
    bus?.emit({ type: 'hover', id: next ? next.index : null })
  }, [bus])
  const handleHover = useCallback(
    (info: {
      index: number
      x: number
      y: number
      coordinate?: number[]
      viewport?: { unproject: (xy: number[]) => number[] }
    }) => {
      const next: HoverInfo | null =
        info && info.index >= 0 ? { index: info.index, x: info.x, y: info.y } : null
      pendingRef.current = next
      onHover?.(next)
      // Overlap tooltips (opt-in): feed the world cursor + a world-space overlap radius (the point's
      // screen radius unprojected at the current zoom) to the shared handle. Empty pick → clear. The
      // whole block is gated on `overlapTooltip` so the default path pays NOTHING per hover (M2).
      const api = overlapApiRef.current
      if (overlapTooltip && api) {
        const vp = info.viewport
        if (info.coordinate && vp) {
          const rPx = Math.max(radius, 3) + 3
          const p0 = vp.unproject([info.x, info.y])
          const p1 = vp.unproject([info.x + rPx, info.y])
          const worldRadius = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
          api.hoverAt(info.coordinate[0], info.coordinate[1], info.x, info.y, worldRadius)
        } else {
          api.clear()
        }
      }
      if (typeof requestAnimationFrame === 'undefined') {
        flush()
      } else if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush)
      }
    },
    [onHover, flush, radius, overlapTooltip],
  )
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  // The tooltip field spec: an explicit `tooltipFields` override, else the defaults built
  // from the resident `tooltipContext`, else null ⇒ the minimal index badge fallback.
  const scatterFields = useMemo<TooltipField[] | null>(() => {
    if (tooltipFields) return tooltipFields
    if (tooltipContext) return buildScatterTooltipFields(tooltipContext)
    return null
  }, [tooltipFields, tooltipContext])

  // Overlap tooltips (opt-in): the shared handle over the resident positions + fields. `handleHover`
  // reads it via `overlapApiRef` (assigned each render). Inert when `overlapTooltip` is false.
  // Active ONLY when opted in AND fields exist; otherwise the legacy single-point path (incl. its
  // `point #N` fallback badge) stays, so `overlapTooltip` without a `tooltipContext` doesn't blank
  // the tooltip (M1).
  const overlapActive = overlapTooltip && !!scatterFields
  const overlap = useOverlapTooltip({
    positions,
    fields: scatterFields,
    enabled: overlapActive,
  })
  overlapApiRef.current = overlap

  // Record the live view on every pan/zoom so `viewRef` holds the LAST view for the
  // recovery remount (see viewRef comment above). We only stash the value — the canvas
  // stays uncontrolled, so we don't push it back through a `viewState` prop.
  const handleViewStateChange = useCallback(
    (params: { viewState: OrthographicViewState }) => {
      viewRef.current = params.viewState
      // Camera moved → mark interacting (debounced back to idle) so the large-N LOD path
      // renders the strided subset during motion and the full N once settled.
      markInteracting()
      // Camera moved → re-evaluate the density-aggregate switch (hysteretic + debounced): zoom
      // out past the budget → density image; zoom back in under it → points.
      evalDensity(params.viewState as ViewportCamera)
      // Camera moved → re-evaluate the dense-points style (size/alpha/blend by density). Committed
      // only when it crosses a step, so this is a handful of re-renders across a zoom, not per-frame.
      evalDenseStyle(params.viewState as ViewportCamera)
      // ALSO surface the live view to the parent (M2) so mouse pan/zoom — not just
      // toolbar controls — mirrors to the other window. Kept uncontrolled: we still only
      // stash into viewRef and never push back a `viewState` prop.
      onViewStateChange?.(params.viewState)
    },
    [onViewStateChange, markInteracting, evalDensity, evalDenseStyle],
  )

  // ── Accessibility (opt-in via `accessibleLabel`) ─────────────────────────────────────────────────
  // Keyboard camera control on the focusable container: arrows pan (Shift = larger), +/- zoom, Enter/
  // Space activate, Esc clear — each spoken through an off-screen ARIA live region. Only drives the
  // UNCONTROLLED internal camera; a `viewState`-controlled canvas ignores keyboard pan/zoom. Pan/zoom
  // update `viewRef` + bump `a11yNav`, which is folded into the <DeckGL> key so it re-reads the new
  // `initialViewState` (the same remount pattern the a11y showcase proved) — cheap since keyboard nav
  // is deliberate, not per-frame.
  const a11yEnabled = accessibleLabel != null && !controlledViewState
  const liveRef = useRef<A11yLiveRegionHandle | null>(null)
  const [a11yNav, setA11yNav] = useState(0)
  const nPoints = positions.length / 2
  // announce through the live region AND surface to a host observer (status line / e2e).
  const onAnnounceRef = useRef(onA11yAnnounce)
  onAnnounceRef.current = onA11yAnnounce
  const say = useCallback((m: string) => {
    liveRef.current?.announce(m)
    onAnnounceRef.current?.(m)
  }, [])
  useCanvasKeyboard({
    ref: containerRef,
    enabled: a11yEnabled,
    onPan: ({ dx, dy }) => {
      const v = viewRef.current
      const t = (v.target as number[] | undefined) ?? [0, 0, 0]
      // world units per key so a keypress moves a roughly-constant SCREEN distance across zooms.
      const step = 24 / 2 ** ((v.zoom as number | undefined) ?? 4)
      viewRef.current = { ...v, target: [t[0] + dx * step, t[1] + dy * step, 0] }
      setA11yNav(k => k + 1)
    },
    onZoom: ({ dir }) => {
      const v = viewRef.current
      viewRef.current = { ...v, zoom: (((v.zoom as number | undefined) ?? 4) + (dir === 'in' ? 1 : -1)) }
      setA11yNav(k => k + 1)
      say(announceViewChange(dir === 'in' ? 1 : -1))
    },
    onActivate: () => {
      if (onA11yActivate) onA11yActivate()
      else say(announceSelection(0, nPoints)) // no selection wired → announce total
    },
    onClearSelection: () => {
      onA11yClear?.()
      say(announceEmpty())
    },
  })

  return (
    <div
      ref={containerRef}
      {...(accessibleLabel != null
        ? { tabIndex: 0, role: 'application', 'aria-label': accessibleLabel }
        : {})}
      style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}
      data-testid="viz-scatter-canvas"
      // '1' while the density-aggregate image is showing (zoomed-out large-N tier), '0' for the
      // point path — observable by the perf harness / e2e to assert the auto-switch behavior.
      data-density-mode={densityActive ? '1' : '0'}
    >
      <DeckGL
        key={`${restoreKey}:${a11yNav}`}
        views={view}
        controller
        // CONTROLLED when a `viewState` prop is supplied (the dataZoom sliders drive the camera);
        // else UNCONTROLLED via `initialViewState` + the internal `viewRef` (byte-identical to
        // before — no per-frame React re-render on pan). Both keep `onViewStateChange` so user
        // gestures still flow out (and, controlled, back in through the parent).
        {...(controlledViewState
          ? { viewState: controlledViewState as never }
          : { initialViewState: viewRef.current })}
        onViewStateChange={handleViewStateChange as never}
        layers={layers}
        onHover={handleHover as never}
      />
      {/* Off-screen ARIA live region for the keyboard-a11y announcements (opt-in). */}
      {accessibleLabel != null && <A11yLiveRegion ref={liveRef} />}
      {lost && <ContextLostOverlay />}
      {/* Overlap tooltips (opt-in + fields present) REPLACE the single-point badge; else the
          existing path (which still shows the fallback badge when no fields). */}
      {overlapActive && overlap.render(theme)}
      {!overlapActive &&
        hovered !== null &&
        (scatterFields ? (
          // Rich O(1) tooltip: resolveTooltip only INDEXES the resident columns at the
          // picked point — constant-time regardless of N.
          <VizTooltip
            rows={resolveTooltip(scatterFields, hovered.index).rows}
            x={hovered.x}
            y={hovered.y}
            theme={theme}
          />
        ) : (
          // Fallback minimal badge (no tooltipContext supplied) — back-compat.
          <div
            data-testid="viz-hover-badge"
            style={{ position: 'absolute', top: 4, left: 4, pointerEvents: 'none' }}
          >
            point #{hovered.index}
          </div>
        ))}
    </div>
  )
}
