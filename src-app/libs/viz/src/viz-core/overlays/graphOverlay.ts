// graphOverlay.ts — pure prop builders for the node-link GRAPH overlay (ITEM-16/53,
// DEC-34). The canonical "graph on top of scatter": given the dense point positions,
// each point's GROUP code, and a `GraphData` whose `paths` are ordered lists of group
// codes (a lineage / trajectory / PAGA-style connectivity walk), we derive:
//   (a) EDGE segments connecting consecutive path nodes  → LineLayer props
//   (b) NODE markers at each group centroid              → ScatterplotLayer props
//   (c) NODE labels at each centroid                     → TextLayer props
//
// Every function here is PURE (no GL context, no react) so the geometry derivation is
// unit-testable in node; `GraphScatterView` spreads the results into the layer
// constructors. Centroids reuse the shared `computeCentroids` reduction (scatter.ts) so
// the overlay anchors to the SAME centroids the rest of viz-core computes.

import { computeCentroids } from '../layers/scatter'
import {
  continuousColors,
  DEFAULT_CONTINUOUS_COLORMAP,
  type ContinuousColormap,
} from '../data/color'

/** An RGBA byte tuple. */
export type Rgba = [number, number, number, number]

/**
 * A deck.gl color accessor: either a constant RGBA (the flat-default path) OR a
 * per-object function `(object, {index}) => Rgba` (the pseudotime / order-colored
 * path — the color is looked up from a precomputed array by object index, never
 * recomputed per frame).
 */
export type ColorAccessor<T> = Rgba | ((object: T, info: { index: number }) => Rgba)

/** A derived overlay edge: a segment between two group centroids. */
export interface OverlayEdge {
  /** ordered path index this edge belongs to (for per-path styling / hover). */
  readonly path: number
  /** the source/target group codes (before centroid resolution). */
  readonly sourceCode: number
  readonly targetCode: number
  /** resolved centroid endpoints in layout space. */
  readonly source: [number, number]
  readonly target: [number, number]
}

/** A derived overlay node: a marker + label at a group centroid. */
export interface OverlayNode {
  readonly code: number
  readonly position: [number, number]
  readonly label: string
}

/** Style knobs for the three overlay layers (all optional; sane defaults). */
export interface GraphOverlayStyle {
  edgeColor?: Rgba
  edgeWidthPixels?: number
  nodeColor?: Rgba
  nodeRadiusPixels?: number
  labelColor?: Rgba
  labelSizePixels?: number
}

const DEFAULT_EDGE_COLOR: Rgba = [40, 40, 40, 220]
const DEFAULT_NODE_COLOR: Rgba = [20, 20, 20, 255]
const DEFAULT_LABEL_COLOR: Rgba = [20, 20, 20, 255]

/**
 * A centroid is USABLE only when it's present AND both coordinates are finite. A present
 * group whose points include a NaN position yields `[NaN, NaN]` from `computeCentroids`;
 * treating that the same as an absent code keeps NaN out of the deck.gl LineLayer /
 * ScatterplotLayer / TextLayer position attributes (which would otherwise silently corrupt
 * the overlay geometry).
 */
function isFiniteCentroid(c: readonly [number, number] | undefined): c is [number, number] {
  return c != null && Number.isFinite(c[0]) && Number.isFinite(c[1])
}

/**
 * Per-group centroids (mean position) over the dense positions array. Thin wrapper over
 * the shared `computeCentroids` reduction so the overlay uses the identical anchors.
 */
export function graphCentroids(
  positions: Float32Array,
  codes: Uint16Array,
): Map<number, [number, number]> {
  return computeCentroids(positions, codes)
}

/**
 * Derive the ordered edge segments for the graph. Each `path` is an ordered list of group
 * codes; consecutive codes become one edge, resolved to their centroids. A code with no
 * USABLE centroid (absent from the data, OR present but non-finite because a point in the
 * group had a NaN position) is skipped — the edge is dropped rather than drawn to a bogus /
 * NaN origin. A self-loop (`a → a`) is skipped.
 */
export function deriveEdges(
  centroids: ReadonlyMap<number, [number, number]>,
  paths: readonly (readonly number[])[],
): OverlayEdge[] {
  const edges: OverlayEdge[] = []
  for (let p = 0; p < paths.length; p++) {
    const path = paths[p]
    for (let i = 0; i + 1 < path.length; i++) {
      const sourceCode = path[i]
      const targetCode = path[i + 1]
      if (sourceCode === targetCode) continue
      const a = centroids.get(sourceCode)
      const b = centroids.get(targetCode)
      if (!isFiniteCentroid(a) || !isFiniteCentroid(b)) continue
      edges.push({ path: p, sourceCode, targetCode, source: a, target: b })
    }
  }
  return edges
}

/**
 * Derive the node markers — one per centroid present in the data with a USABLE (finite)
 * position. A present-but-non-finite centroid (a group with a NaN point) is dropped so no
 * NaN position reaches the ScatterplotLayer / TextLayer (the same array drives both node
 * markers and labels). `categories` (the categorical column's category labels, indexed by
 * code) supplies the human label; a code with no matching category falls back to its numeric
 * string. Nodes are emitted in ascending code order for determinism.
 */
export function deriveNodes(
  centroids: ReadonlyMap<number, [number, number]>,
  categories?: readonly string[],
): OverlayNode[] {
  const codes = [...centroids.keys()].sort((x, y) => x - y)
  const nodes: OverlayNode[] = []
  for (const code of codes) {
    const position = centroids.get(code)
    if (!isFiniteCentroid(position)) continue
    nodes.push({
      code,
      position,
      label: categories?.[code] ?? String(code),
    })
  }
  return nodes
}

// ── pseudotime / continuous ORDER coloring (ITEM-16) ─────────────────────────
// The graph carries an implicit ORDERING: a node's position along its path (root →
// tip) is a continuous, domain-agnostic "order value" (a.k.a. pseudotime in a
// trajectory). We surface it generically and color nodes + edge segments by mapping
// that value through the SHARED continuous color pipeline (`continuousColors` — the
// same 256-entry colormap LUT the scatter color-by-value path uses; we do NOT invent
// a new colormap).

/**
 * Derive a continuous ORDER value in `[0, 1]` for every group code that appears in the
 * paths: a node's normalized position index along its path (0 at the root → 1 at the
 * tip). A single-node path maps to 0 (denominator floored at 1 so there is never a
 * NaN / divide-by-zero). A code appearing in several paths / positions gets the mean
 * of its normalized indices (deterministic, order-independent). An explicit `override`
 * (a value already carried out-of-band by the data source) wins wholesale when non-empty.
 */
export function deriveOrderValues(
  paths: readonly (readonly number[])[],
  override?: ReadonlyMap<number, number>,
): Map<number, number> {
  if (override && override.size > 0) return new Map(override)
  const sum = new Map<number, number>()
  const count = new Map<number, number>()
  for (const path of paths) {
    const denom = Math.max(1, path.length - 1)
    for (let i = 0; i < path.length; i++) {
      const code = path[i]
      const v = i / denom
      sum.set(code, (sum.get(code) ?? 0) + v)
      count.set(code, (count.get(code) ?? 0) + 1)
    }
  }
  const out = new Map<number, number>()
  for (const [code, s] of sum) out.set(code, s / (count.get(code) ?? 1))
  return out
}

/**
 * Map a normalized-`[0,1]` value array through the continuous colormap LUT ONCE and
 * return per-index RGBA tuples. Reuses `continuousColors` (the shared GPU-parity color
 * pipeline) with a fixed `[0, 1]` domain so nodes and edges share one consistent scale.
 * Called once per overlay build (never per frame / per point).
 */
function orderColors(values: Float32Array, colormap: ContinuousColormap): Rgba[] {
  const { colors } = continuousColors(values, { colormap, domain: [0, 1] })
  const out: Rgba[] = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const o = i * 4
    out[i] = [colors[o], colors[o + 1], colors[o + 2], colors[o + 3]]
  }
  return out
}

// ── LineLayer props (edges) ──────────────────────────────────────────────────

export interface EdgeLayerProps {
  readonly id: string
  readonly data: OverlayEdge[]
  readonly getSourcePosition: (e: OverlayEdge) => [number, number]
  readonly getTargetPosition: (e: OverlayEdge) => [number, number]
  readonly getColor: ColorAccessor<OverlayEdge>
  readonly getWidth: number
  readonly widthUnits: 'pixels'
  readonly widthMinPixels: number
  readonly pickable: boolean
}

/**
 * `colors` (optional) is a per-edge RGBA array aligned to `edges` (the pseudotime /
 * order-colored path). When present `getColor` becomes an index accessor into it;
 * when absent the flat constant color is used (byte-identical to the pre-ITEM-16 path).
 */
export function buildEdgeLayerProps(
  edges: OverlayEdge[],
  style: GraphOverlayStyle = {},
  id = 'graph-overlay-edges',
  colors?: readonly Rgba[],
): EdgeLayerProps {
  const flat = style.edgeColor ?? DEFAULT_EDGE_COLOR
  return {
    id,
    data: edges,
    getSourcePosition: e => e.source,
    getTargetPosition: e => e.target,
    getColor: colors ? (_e, info) => colors[info.index] ?? flat : flat,
    getWidth: style.edgeWidthPixels ?? 2,
    widthUnits: 'pixels',
    widthMinPixels: style.edgeWidthPixels ?? 2,
    pickable: true,
  }
}

// ── ScatterplotLayer props (nodes) ───────────────────────────────────────────

export interface NodeLayerProps {
  readonly id: string
  readonly data: OverlayNode[]
  readonly getPosition: (n: OverlayNode) => [number, number]
  readonly getFillColor: ColorAccessor<OverlayNode>
  readonly getRadius: number
  readonly radiusUnits: 'pixels'
  readonly radiusMinPixels: number
  readonly radiusMaxPixels: number
  readonly stroked: boolean
  readonly filled: boolean
  readonly pickable: boolean
}

/**
 * `colors` (optional) is a per-node RGBA array aligned to `nodes` (the pseudotime /
 * order-colored path). When present `getFillColor` becomes an index accessor into it;
 * when absent the flat constant color is used (byte-identical to the pre-ITEM-16 path).
 */
export function buildNodeLayerProps(
  nodes: OverlayNode[],
  style: GraphOverlayStyle = {},
  id = 'graph-overlay-nodes',
  colors?: readonly Rgba[],
): NodeLayerProps {
  const r = style.nodeRadiusPixels ?? 6
  const flat = style.nodeColor ?? DEFAULT_NODE_COLOR
  return {
    id,
    data: nodes,
    getPosition: n => n.position,
    getFillColor: colors ? (_n, info) => colors[info.index] ?? flat : flat,
    getRadius: r,
    radiusUnits: 'pixels',
    radiusMinPixels: r,
    radiusMaxPixels: r,
    stroked: false,
    filled: true,
    pickable: true,
  }
}

// ── TextLayer props (labels) ─────────────────────────────────────────────────

export interface LabelLayerProps {
  readonly id: string
  readonly data: OverlayNode[]
  readonly getPosition: (n: OverlayNode) => [number, number]
  readonly getText: (n: OverlayNode) => string
  readonly getColor: Rgba
  readonly getSize: number
  readonly sizeUnits: 'pixels'
  readonly getPixelOffset: [number, number]
  readonly getTextAnchor: 'start'
  readonly getAlignmentBaseline: 'center'
  readonly pickable: boolean
}

export function buildLabelLayerProps(
  nodes: OverlayNode[],
  style: GraphOverlayStyle = {},
  id = 'graph-overlay-labels',
): LabelLayerProps {
  const size = style.labelSizePixels ?? 12
  return {
    id,
    data: nodes,
    getPosition: n => n.position,
    getText: n => n.label,
    getColor: style.labelColor ?? DEFAULT_LABEL_COLOR,
    getSize: size,
    sizeUnits: 'pixels',
    // nudge the label off the node marker so it doesn't sit under the dot.
    getPixelOffset: [(style.nodeRadiusPixels ?? 6) + 4, 0],
    getTextAnchor: 'start',
    getAlignmentBaseline: 'center',
    pickable: false,
  }
}

// ── one-shot convenience ─────────────────────────────────────────────────────

/**
 * Opt-in continuous ORDER (pseudotime) coloring. When `colorByOrder` is on, nodes and
 * edge segments are colored by their normalized order value through the continuous
 * colormap; when off (the default) the overlay keeps its flat default color and the
 * built prop objects are byte-identical to the pre-ITEM-16 output.
 */
export interface GraphOverlayColorOptions {
  /** turn on pseudotime / order coloring. Default `false` (flat color). */
  colorByOrder?: boolean
  /** which continuous colormap to map the order value through. Default `viridis`. */
  colormap?: ContinuousColormap
  /** explicit per-code order values (0..1); when absent/empty they are derived from path position. */
  orderValues?: ReadonlyMap<number, number>
}

export interface GraphOverlayBuild {
  readonly centroids: Map<number, [number, number]>
  readonly edges: OverlayEdge[]
  readonly nodes: OverlayNode[]
  readonly edgeProps: EdgeLayerProps
  readonly nodeProps: NodeLayerProps
  readonly labelProps: LabelLayerProps
  /**
   * The continuous order value (0..1) per group code, when order coloring is on
   * (`undefined` on the flat-default path). Drives an optional colorbar hint.
   */
  readonly orderValues?: Map<number, number>
  /** the colormap the order colors were mapped through (when order coloring is on). */
  readonly colormap?: ContinuousColormap
}

/**
 * Build the whole overlay (centroids + edges + nodes + all three layer prop objects) from
 * the raw positions, the per-point group codes, and the graph paths. `categories` supplies
 * node labels. Pure — returns prop objects a canvas spreads into deck.gl layers.
 *
 * When `color.colorByOrder` is set, each node's continuous ORDER value (root 0 → tip 1,
 * derived from its path position unless supplied) is mapped through the shared continuous
 * colormap and node markers + edge segments are colored by it (edge = mean of its two
 * endpoints' order). The colors are computed ONCE here (256-entry LUT), then indexed by
 * object on the GPU. Off by default → flat-color path unchanged.
 */
export function buildGraphOverlay(
  positions: Float32Array,
  codes: Uint16Array,
  paths: readonly (readonly number[])[],
  categories?: readonly string[],
  style: GraphOverlayStyle = {},
  color: GraphOverlayColorOptions = {},
): GraphOverlayBuild {
  const centroids = graphCentroids(positions, codes)
  const edges = deriveEdges(centroids, paths)
  const nodes = deriveNodes(centroids, categories)

  if (!color.colorByOrder) {
    return {
      centroids,
      edges,
      nodes,
      edgeProps: buildEdgeLayerProps(edges, style),
      nodeProps: buildNodeLayerProps(nodes, style),
      labelProps: buildLabelLayerProps(nodes, style),
    }
  }

  const colormap = color.colormap ?? DEFAULT_CONTINUOUS_COLORMAP
  const orderValues = deriveOrderValues(paths, color.orderValues)

  // Per-node order value, aligned to `nodes` → one colormap pass → per-node RGBA.
  const nodeVals = new Float32Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) nodeVals[i] = orderValues.get(nodes[i].code) ?? 0
  const nodeColors = orderColors(nodeVals, colormap)

  // Per-edge order value = mean of its endpoints' order, aligned to `edges`.
  const edgeVals = new Float32Array(edges.length)
  for (let i = 0; i < edges.length; i++) {
    const s = orderValues.get(edges[i].sourceCode) ?? 0
    const t = orderValues.get(edges[i].targetCode) ?? 0
    edgeVals[i] = (s + t) / 2
  }
  const edgeColors = orderColors(edgeVals, colormap)

  return {
    centroids,
    edges,
    nodes,
    orderValues,
    colormap,
    edgeProps: buildEdgeLayerProps(edges, style, 'graph-overlay-edges', edgeColors),
    nodeProps: buildNodeLayerProps(nodes, style, 'graph-overlay-nodes', nodeColors),
    labelProps: buildLabelLayerProps(nodes, style),
  }
}
