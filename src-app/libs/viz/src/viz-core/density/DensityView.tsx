// DensityView.tsx — the "aggregate then shade" GPU view for the 10M+/zoomed-out LOD tier
// (research item #1). A screen is ~2M pixels, so past ~10M points drawing every point is
// wasted overdraw; instead we bin points to a VIEWPORT-SIZED grid (one cell ≈ `cellPx`
// screen pixels) and colormap the per-cell aggregate — the render cost scales with CELLS,
// not points, so millions of points render as a density image at 60fps.
//
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/* + react (no @ziee/*), mirroring
// DeckScatterCanvas. RENDERER: deck.gl's `@deck.gl/aggregation-layers` `ScreenGridLayer`,
// which does the screen-space binning + aggregation ON THE GPU (`gpuAggregation`) — the same
// class of additive-blend-into-a-float-target technique the in-repo `gpu/groupReduce` /
// `gpu/densifyGpu` passes use, but packaged by deck. `densityBin.ts` is the pure CPU ORACLE
// for that GPU aggregation (and the data source for a BitmapLayer fallback).
//
// COLOR-BY-MEAN keeps the biology: with `mode='mean'` the layer aggregates `getWeight` (the
// value column) with `aggregation:'MEAN'`, so each cell is colored by the MEAN of the value
// column over its points ("mean expression per bin"). `mode='count'` colors by raw density.
// Feeding a `values` buffer is what distinguishes the two — count mode ignores the weight.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState, type Color } from '@deck.gl/core'
import { ScreenGridLayer } from '@deck.gl/aggregation-layers'
import { buildColormapLUT } from '../gpu/colormapLut'
import { DEFAULT_CONTINUOUS_COLORMAP, type ContinuousColormap } from '../data/color'
import { planDensityGrid, type DensityMode, type DensityGrid } from './densityBin'
import { resolveDensityGpuAggregation } from '../gpu/renderCapability'
import type { Device } from '@luma.gl/core'

const DEFAULT_CELL_PX = 24

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

/**
 * Sample the continuous colormap into a discrete `Color[]` range for ScreenGridLayer's
 * `colorRange` (low weight → high weight). Reuses the SAME 256-entry LUT
 * (`buildColormapLUT`) as the point path + the DOM colorbar, so a density cell's color is
 * consistent with a scatter point of the same value. The layer interpolates its
 * `colorDomain` across these stops.
 */
function colorRangeFromColormap(colormap: ContinuousColormap, steps = 12): Color[] {
  const lut = buildColormapLUT(colormap) // Uint8Array, 256*4 RGBA
  const range: Color[] = []
  for (let i = 0; i < steps; i++) {
    const k = steps === 1 ? 0 : Math.round((i / (steps - 1)) * 255)
    const o = k * 4
    range.push([lut[o], lut[o + 1], lut[o + 2]])
  }
  return range
}

export interface DensityViewProps {
  /** interleaved xy Float32Array, length N*2. */
  positions: Float32Array
  /**
   * The value column to AVERAGE per bin (length N), used as `getWeight` in `mode='mean'`.
   * Absent (or `mode='count'`) ⇒ the layer aggregates by COUNT and this is ignored.
   */
  values?: Float32Array | null
  /** continuous colormap for the per-cell shading (default viridis). */
  colormap?: ContinuousColormap
  /** cell edge in SCREEN pixels — the density resolution + the cost bound (default 24). */
  cellPx?: number
  /** color by raw density (`count`) or by the MEAN of the value column (`mean`, default). */
  mode?: DensityMode
  /**
   * Explicit color domain `[lo, hi]` the aggregate maps over. `null`/absent ⇒ the layer
   * auto-scales to `[1, max]` (count) / the observed weight range (mean).
   */
  colorDomain?: [number, number] | null
  /** bump when `positions` / `values` CONTENTS change under a stable reference to re-aggregate. */
  dataEpoch?: number
  initialViewState?: Partial<OrthographicViewState>
  /** cells-per-side callback, fired on mount + resize + cellPx change (the LOD cost bound). */
  onGridDims?: (grid: DensityGrid) => void
}

/**
 * A single GPU density-aggregate view. Renders `positions` (+ an optional value column) as a
 * screen-space binned density image via ScreenGridLayer. The heavy path (millions of points)
 * stays on the GPU: binning + aggregation + shading are all device-side; the cost is bounded
 * by the on-screen cell count, not N.
 */
export function DensityView({
  positions,
  values,
  colormap = DEFAULT_CONTINUOUS_COLORMAP,
  cellPx = DEFAULT_CELL_PX,
  mode = 'mean',
  colorDomain = null,
  dataEpoch = 0,
  initialViewState,
  onGridDims,
}: DensityViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // BUG #6: the actual GL device (from DeckGL's onDeviceInitialized) decides whether ScreenGridLayer's
  // GPU aggregation can render into a float target. `null` until initialized ⇒ the capable-GPU default.
  const [device, setDevice] = useState<Device | null>(null)
  const gpuAggregation = resolveDensityGpuAggregation(device)

  // Measure the canvas so the grid dims (the render cost bound) track the actual viewport —
  // a ScreenGridLayer cell is `cellPx` SCREEN pixels, so the number of cells = viewport/cell.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The planned grid dims (cells-per-side) for the current viewport + cell size. Surfaced via
  // onGridDims so a harness/LOD controller can observe the cost bound.
  const grid = useMemo(
    () => planDensityGrid(viewportSize.w, viewportSize.h, cellPx),
    [viewportSize.w, viewportSize.h, cellPx],
  )
  useEffect(() => {
    onGridDims?.(grid)
  }, [grid, onGridDims])

  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const viewState = useMemo(
    () => ({ ...DEFAULT_VIEW_STATE, ...initialViewState }),
    [initialViewState],
  )

  const colorRange = useMemo(() => colorRangeFromColormap(colormap), [colormap])

  // Mean mode needs a per-point weight (the value column); count mode ignores it. When mean is
  // requested but no values are supplied, fall back to count so the view still renders.
  const useMean = mode === 'mean' && !!values
  const aggregation = useMean ? 'MEAN' : 'COUNT'

  const layers = useMemo(() => {
    const N = positions.length >> 1
    // Binary attributes (zero-copy typed arrays) — the same pattern as the scatter path.
    // getWeight defaults to 1 when no column is bound (count mode).
    const attributes: Record<string, unknown> = {
      getPosition: { value: positions, size: 2 as const },
    }
    if (useMean && values) {
      attributes.getWeight = { value: values, size: 1 as const }
    }
    return [
      new ScreenGridLayer({
        id: 'viz-density-grid',
        data: { length: N, attributes },
        cellSizePixels: Math.max(1, cellPx),
        cellMarginPixels: 0,
        aggregation,
        colorRange,
        colorScaleType: 'linear',
        colorDomain: colorDomain ?? null,
        // BUG #6: gate on the device's float-renderable capability — a software/weak-GL device that
        // can't render a float target would read back an empty aggregation texture (blank grid), so
        // route it to ScreenGridLayer's CPU-aggregation draw path instead.
        gpuAggregation,
        pickable: false,
        // Re-aggregate when the buffers' CONTENTS change (stable-reference recolor/reload),
        // or when the aggregation mode / cell size changes.
        updateTriggers: {
          getPosition: [dataEpoch],
          getWeight: [dataEpoch, aggregation],
        },
      } as never),
    ]
  }, [positions, values, useMean, cellPx, aggregation, colorRange, colorDomain, dataEpoch, gpuAggregation])

  const handleViewStateChange = useCallback(() => {
    // Uncontrolled canvas: ScreenGridLayer re-bins in screen space on every camera change
    // automatically (GPU), so we don't need to mirror the view state here.
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-density-canvas"
    >
      <DeckGL
        views={view}
        controller
        initialViewState={viewState}
        onViewStateChange={handleViewStateChange as never}
        onDeviceInitialized={((d: Device) => setDevice(d)) as never}
        layers={layers}
      />
    </div>
  )
}
