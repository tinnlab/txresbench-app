// DensityCanvas.tsx — the `density-grid` view-kind (ITEM-23 / DEC-22). A GPU
// aggregation canvas: bins millions of points into a grid (ScreenGridLayer) or
// hexbin (HexagonLayer, toggled by a prop), aggregating by COUNT (cells per bin)
// or MEAN (mean of a weight column per bin, DEC-22). Framework-agnostic (viz-core).
//
// The aggregation-layer prop assembly is a small PURE helper (`buildAggregationProps`)
// so it is unit-testable in node; the canvas spreads its `props` into the layer ctor.
// (Wraps the intent of scatter.ts `buildDensityProps`, adding the count/mean +
// square/hexbin vocabulary the first-class view-kind needs.)

import { useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScreenGridLayer, HexagonLayer } from '@deck.gl/aggregation-layers'

/** Square grid (`screen-grid`) or hexbin (`hexagon`) binning. */
export type DensityLayerKind = 'screen-grid' | 'hexagon'
/** COUNT = points per bin; MEAN = mean of the weight column per bin (DEC-22). */
export type AggregationMode = 'count' | 'mean'

export interface AggregationPropsOpts {
  positions: Float32Array
  /** per-point weight column (required for `mean`; ignored for `count`). */
  weights?: Float32Array
  kind: DensityLayerKind
  /** bin size: `cellSizePixels` for screen-grid; `radius` (common units) for hexagon. */
  binSize: number
  aggregation: AggregationMode
  id?: string
}

export interface AggregationBuild {
  kind: DensityLayerKind
  /** deck.gl aggregation operation ('SUM' behaves as COUNT when weight ≡ 1). */
  aggregation: 'SUM' | 'MEAN'
  binSize: number
  /** spreadable into `new ScreenGridLayer(...)` / `new HexagonLayer(...)`. */
  props: Record<string, unknown>
}

// a colorblind-safe sequential ramp (viridis-like) for the aggregated bins.
const COLOR_RANGE: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 144, 141],
  [93, 201, 99],
  [253, 231, 37],
  [255, 255, 200],
]

/**
 * Pure builder: assemble the binary-attribute aggregation-layer props for a
 * `density-grid` cell. `mean` with a `weights` column aggregates MEAN of that
 * column per bin; otherwise the layer SUMs a unit weight (i.e. COUNT).
 */
export function buildAggregationProps(opts: AggregationPropsOpts): AggregationBuild {
  const length = opts.positions.length / 2
  const useMean = opts.aggregation === 'mean' && !!opts.weights
  const op: 'SUM' | 'MEAN' = useMean ? 'MEAN' : 'SUM'

  if (opts.kind === 'hexagon') {
    const attributes: Record<string, unknown> = {
      getPosition: { value: opts.positions, size: 2 },
    }
    if (useMean) attributes.getColorWeight = { value: opts.weights, size: 1 }
    return {
      kind: 'hexagon',
      aggregation: op,
      binSize: opts.binSize,
      props: {
        id: opts.id ?? 'viz-density-hexagon',
        data: { length, attributes },
        radius: opts.binSize,
        coverage: 0.9,
        colorAggregation: op,
        ...(useMean ? {} : { getColorWeight: 1 }),
        colorRange: COLOR_RANGE,
        opacity: 0.85,
        pickable: true,
      },
    }
  }

  const attributes: Record<string, unknown> = {
    getPosition: { value: opts.positions, size: 2 },
  }
  if (useMean) attributes.getWeight = { value: opts.weights, size: 1 }
  return {
    kind: 'screen-grid',
    aggregation: op,
    binSize: opts.binSize,
    props: {
      id: opts.id ?? 'viz-density-screen-grid',
      data: { length, attributes },
      cellSizePixels: opts.binSize,
      aggregation: op,
      ...(useMean ? {} : { getWeight: 1 }),
      colorRange: COLOR_RANGE,
      opacity: 0.85,
      pickable: true,
    },
  }
}

export interface DensityCanvasProps {
  /** interleaved xy Float32Array (the points to aggregate). */
  positions: Float32Array
  /** optional per-point weight column enabling the MEAN aggregation. */
  weights?: Float32Array
  /** toggle hexbin (HexagonLayer) instead of the default square grid. */
  hexagon?: boolean
  /** initial bin size (cell px for grid / radius for hexbin). */
  initialBinSize?: number
  initialViewState?: Partial<OrthographicViewState>
}

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

/** The `density-grid` view: GPU-binned points with cell-size + aggregation controls. */
export function DensityCanvas({
  positions,
  weights,
  hexagon = false,
  initialBinSize,
  initialViewState,
}: DensityCanvasProps) {
  const kind: DensityLayerKind = hexagon ? 'hexagon' : 'screen-grid'
  const [binSize, setBinSize] = useState(initialBinSize ?? (hexagon ? 1 : 24))
  const [aggregation, setAggregation] = useState<AggregationMode>('count')

  const view = useMemo(() => new OrthographicView({ id: 'density', flipY: false }), [])

  const layer = useMemo(() => {
    const built = buildAggregationProps({ positions, weights, kind, binSize, aggregation })
    return built.kind === 'hexagon'
      ? new HexagonLayer(built.props as never)
      : new ScreenGridLayer(built.props as never)
  }, [positions, weights, kind, binSize, aggregation])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-density-canvas"
    >
      <DeckGL
        views={view}
        controller
        initialViewState={{ ...DEFAULT_VIEW_STATE, ...initialViewState }}
        layers={[layer]}
      />
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.7)',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <label>
          {hexagon ? 'Bin radius' : 'Cell size'}{' '}
          <input
            data-testid="density-binsize"
            type="range"
            min={hexagon ? 0.25 : 6}
            max={hexagon ? 4 : 64}
            step={hexagon ? 0.25 : 2}
            value={binSize}
            onChange={e => setBinSize(Number(e.target.value))}
          />
        </label>
        <label>
          Aggregate{' '}
          <select
            data-testid="density-aggregation"
            value={aggregation}
            onChange={e => setAggregation(e.target.value as AggregationMode)}
          >
            <option value="count">count</option>
            <option value="mean" disabled={!weights}>
              mean
            </option>
          </select>
        </label>
      </div>
    </div>
  )
}
