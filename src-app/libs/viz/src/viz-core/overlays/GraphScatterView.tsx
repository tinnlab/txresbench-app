// GraphScatterView.tsx — the composed "graph on top of scatter" canvas (ITEM-16/53,
// DEC-34). A FRESH standalone `<DeckGL>` (OrthographicView) — deliberately NOT reusing
// DeckScatterCanvas — that composites, in ONE view sharing ONE coordinate system:
//   layer 0  base ScatterplotLayer (the embedding, colored by a categorical)   [UNDER]
//   layer 1  LineLayer   — lineage/trajectory EDGES between group centroids     [OVER]
//   layer 2  ScatterplotLayer — NODE markers at the centroids                   [OVER]
//   layer 3  TextLayer   — NODE labels                                          [OVER]
// The overlay geometry is derived by the pure builders in graphOverlay.ts. A toggle
// shows/hides the whole overlay stack (base scatter stays). All-GPU deck.gl.

import { useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer, LineLayer, TextLayer } from '@deck.gl/layers'
import { buildScatterProps } from '../layers/scatter'
import type { GraphData } from '../data/wire'
import { buildGraphOverlay, type GraphOverlayStyle } from './graphOverlay'
import {
  colorbarDescriptor,
  DEFAULT_CONTINUOUS_COLORMAP,
  type ContinuousColormap,
} from '../data/color'

export interface GraphScatterViewProps {
  /** interleaved xy Float32Array, length N*2 — the base embedding. */
  positions: Float32Array
  /** base-scatter RGBA colors, length N*4 (color-by categorical). */
  colors: Uint8Array
  /** per-point group codes, length N — the grouping the centroids/graph nodes reduce over. */
  codes: Uint16Array
  /** the node-link graph: `paths` are ordered lists of group codes (lineage / trajectory). */
  graph: GraphData
  /** category labels indexed by code (for node labels); falls back to the numeric code. */
  categories?: readonly string[]
  /** base-scatter point radius (pixels). */
  radius?: number
  /** overlay style knobs. */
  overlayStyle?: GraphOverlayStyle
  /** whether the overlay starts visible. */
  defaultShowOverlay?: boolean
  /**
   * whether nodes/edges start colored by their continuous ORDER value (pseudotime)
   * instead of the flat default. Off by default (flat-color path unchanged).
   */
  defaultColorByOrder?: boolean
  /** colormap the order value is mapped through when order coloring is on. */
  orderColormap?: ContinuousColormap
  initialViewState?: Partial<OrthographicViewState>
  /** bump when `colors`/`positions` content changes so the base layer re-uploads. */
  colorEpoch?: number
}

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

/**
 * The composed graph-on-scatter canvas. One `Deck`, one `OrthographicView`; the base
 * scatter and the graph overlay share the coordinate system, so edges/nodes land on the
 * same centroids the points cluster around.
 */
export function GraphScatterView({
  positions,
  colors,
  codes,
  graph,
  categories,
  radius = 2,
  overlayStyle,
  defaultShowOverlay = true,
  defaultColorByOrder = false,
  orderColormap = DEFAULT_CONTINUOUS_COLORMAP,
  initialViewState,
  colorEpoch = 0,
}: GraphScatterViewProps) {
  const [showOverlay, setShowOverlay] = useState(defaultShowOverlay)
  const [colorByOrder, setColorByOrder] = useState(defaultColorByOrder)

  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])

  // Pure derivation of the overlay geometry + prop objects (centroids/edges/nodes).
  // Order colors (when on) are computed ONCE here via the shared continuous colormap LUT.
  const overlay = useMemo(
    () =>
      buildGraphOverlay(positions, codes, graph.paths, categories, overlayStyle, {
        colorByOrder,
        colormap: orderColormap,
      }),
    [positions, codes, graph.paths, categories, overlayStyle, colorByOrder, orderColormap],
  )

  // A small colorbar hint (root → tip) shown only when order coloring is active.
  const colorbar = useMemo(
    () => (colorByOrder ? colorbarDescriptor(orderColormap, [0, 1]) : null),
    [colorByOrder, orderColormap],
  )

  const layers = useMemo(() => {
    // Base embedding scatter — UNDER the overlay; not pickable (the overlay owns hover).
    const baseProps = buildScatterProps({
      id: 'graph-base-scatter',
      positions,
      colors,
      radius,
      pickable: false,
    })
    const base = new ScatterplotLayer({
      ...baseProps,
      updateTriggers: { getFillColor: colorEpoch },
    })
    if (!showOverlay) return [base]

    const edges = new LineLayer(overlay.edgeProps as never)
    const nodes = new ScatterplotLayer(overlay.nodeProps as never)
    const labels = new TextLayer(overlay.labelProps as never)
    // base UNDER, then edges, node markers, labels on TOP.
    return [base, edges, nodes, labels]
  }, [positions, colors, radius, colorEpoch, showOverlay, overlay])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="graph-scatter-view"
    >
      <label
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 1,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.85)',
          padding: '4px 8px',
          borderRadius: 6,
          fontSize: 13,
          pointerEvents: 'auto',
        }}
      >
        <input
          type="checkbox"
          data-testid="graph-overlay-toggle"
          checked={showOverlay}
          onChange={e => setShowOverlay(e.target.checked)}
        />
        Graph overlay
        <span style={{ opacity: 0.6 }}>
          ({overlay.nodes.length} nodes · {overlay.edges.length} edges)
        </span>
      </label>
      <label
        style={{
          position: 'absolute',
          top: 44,
          left: 8,
          zIndex: 1,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.85)',
          padding: '4px 8px',
          borderRadius: 6,
          fontSize: 13,
          pointerEvents: 'auto',
        }}
      >
        <input
          type="checkbox"
          data-testid="graph-pseudotime-toggle"
          checked={colorByOrder}
          disabled={!showOverlay}
          onChange={e => setColorByOrder(e.target.checked)}
        />
        Pseudotime color
      </label>
      {showOverlay && colorbar && (
        <div
          data-testid="graph-pseudotime-colorbar"
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            background: 'rgba(255,255,255,0.85)',
            padding: '4px 8px',
            borderRadius: 6,
            fontSize: 11,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 120,
              height: 8,
              borderRadius: 2,
              background: `linear-gradient(to right, ${colorbar.stops.join(', ')})`,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7 }}>
            <span>root</span>
            <span>tip</span>
          </div>
        </div>
      )}
      <DeckGL
        views={view}
        controller
        initialViewState={{ ...DEFAULT_VIEW_STATE, ...initialViewState }}
        layers={layers}
      />
    </div>
  )
}
