import { describe, it, expect } from 'vitest'
import {
  graphCentroids,
  deriveEdges,
  deriveNodes,
  deriveOrderValues,
  buildEdgeLayerProps,
  buildNodeLayerProps,
  buildLabelLayerProps,
  buildGraphOverlay,
  type Rgba,
  type OverlayNode,
  type OverlayEdge,
} from './graphOverlay'

// A known 3-group point set: group 0 around (1,0), group 1 around (11,10),
// group 2 around (21,20). Two points each so the centroid is the mean.
const positions = new Float32Array([
  0, 0, 2, 0, // group 0 → centroid (1, 0)
  10, 10, 12, 10, // group 1 → centroid (11, 10)
  20, 20, 22, 20, // group 2 → centroid (21, 20)
])
const codes = new Uint16Array([0, 0, 1, 1, 2, 2])

describe('graphOverlay — centroid derivation (TEST-16/53)', () => {
  it('computes per-group mean positions', () => {
    const c = graphCentroids(positions, codes)
    expect(c.get(0)).toEqual([1, 0])
    expect(c.get(1)).toEqual([11, 10])
    expect(c.get(2)).toEqual([21, 20])
    expect(c.size).toBe(3)
  })
})

describe('graphOverlay — edge derivation (TEST-16/53)', () => {
  it('a path [0,1,2] yields 2 edges between the right centroids', () => {
    const centroids = graphCentroids(positions, codes)
    const edges = deriveEdges(centroids, [[0, 1, 2]])
    expect(edges).toHaveLength(2)

    expect(edges[0].sourceCode).toBe(0)
    expect(edges[0].targetCode).toBe(1)
    expect(edges[0].source).toEqual([1, 0])
    expect(edges[0].target).toEqual([11, 10])

    expect(edges[1].sourceCode).toBe(1)
    expect(edges[1].targetCode).toBe(2)
    expect(edges[1].source).toEqual([11, 10])
    expect(edges[1].target).toEqual([21, 20])
  })

  it('drops edges whose endpoint has no centroid (code absent from data)', () => {
    const centroids = graphCentroids(positions, codes)
    // 9 is not a real group → the 2→9 edge is dropped, 0→1 kept.
    const edges = deriveEdges(centroids, [[0, 1, 2, 9]])
    expect(edges).toHaveLength(2)
    expect(edges.every(e => e.targetCode !== 9)).toBe(true)
  })

  it('drops edges touching a present group whose centroid is non-finite (all-NaN points)', () => {
    // group 0 → (1,0), group 1 present but BOTH points NaN → centroid [NaN,NaN],
    // group 2 → (21,20). Path [0,1,2] must drop 0→1 AND 1→2 (the two edges through the
    // non-finite middle node), leaving no edges — never emit a NaN endpoint.
    const pos = new Float32Array([
      0, 0, 2, 0, // group 0 → centroid (1, 0)
      NaN, NaN, NaN, NaN, // group 1 → centroid (NaN, NaN)
      20, 20, 22, 20, // group 2 → centroid (21, 20)
    ])
    const cds = new Uint16Array([0, 0, 1, 1, 2, 2])
    const centroids = graphCentroids(pos, cds)
    const c1 = centroids.get(1)!
    expect(Number.isFinite(c1[0])).toBe(false) // precondition: centroid is non-finite

    const edges = deriveEdges(centroids, [[0, 1, 2]])
    expect(edges).toHaveLength(0)
    // and nothing emitted carries a NaN endpoint
    expect(
      edges.every(
        e =>
          Number.isFinite(e.source[0]) &&
          Number.isFinite(e.source[1]) &&
          Number.isFinite(e.target[0]) &&
          Number.isFinite(e.target[1]),
      ),
    ).toBe(true)
  })

  it('a fully-finite path is unaffected by the non-finite guard', () => {
    const centroids = graphCentroids(positions, codes)
    const edges = deriveEdges(centroids, [[0, 1, 2]])
    expect(edges).toHaveLength(2)
    expect(edges[0].source).toEqual([1, 0])
    expect(edges[1].target).toEqual([21, 20])
  })

  it('skips self-loops', () => {
    const centroids = graphCentroids(positions, codes)
    const edges = deriveEdges(centroids, [[1, 1, 2]])
    expect(edges).toHaveLength(1)
    expect(edges[0].sourceCode).toBe(1)
    expect(edges[0].targetCode).toBe(2)
  })

  it('handles multiple paths, tagging each edge with its path index', () => {
    const centroids = graphCentroids(positions, codes)
    const edges = deriveEdges(centroids, [[0, 1], [1, 2]])
    expect(edges).toHaveLength(2)
    expect(edges[0].path).toBe(0)
    expect(edges[1].path).toBe(1)
  })
})

describe('graphOverlay — node derivation (TEST-16/53)', () => {
  it('emits one node per centroid, in ascending code order', () => {
    const centroids = graphCentroids(positions, codes)
    const nodes = deriveNodes(centroids)
    expect(nodes).toHaveLength(3)
    expect(nodes.map(n => n.code)).toEqual([0, 1, 2])
    expect(nodes[1].position).toEqual([11, 10])
  })

  it('drops a node (and its label) whose centroid is non-finite (all-NaN points)', () => {
    const pos = new Float32Array([
      0, 0, 2, 0, // group 0 → centroid (1, 0)
      NaN, NaN, NaN, NaN, // group 1 → centroid (NaN, NaN)
      20, 20, 22, 20, // group 2 → centroid (21, 20)
    ])
    const cds = new Uint16Array([0, 0, 1, 1, 2, 2])
    const centroids = graphCentroids(pos, cds)
    const nodes = deriveNodes(centroids, ['Alpha', 'Beta', 'Gamma'])
    // group 1's node/label is dropped — only the two finite-centroid nodes survive.
    expect(nodes.map(n => n.code)).toEqual([0, 2])
    expect(
      nodes.every(n => Number.isFinite(n.position[0]) && Number.isFinite(n.position[1])),
    ).toBe(true)
    // the surviving labels come through unchanged
    expect(nodes.map(n => n.label)).toEqual(['Alpha', 'Gamma'])
  })

  it('labels nodes from the categories array, falling back to the code string', () => {
    const centroids = graphCentroids(positions, codes)
    const nodes = deriveNodes(centroids, ['Alpha', 'Beta'])
    expect(nodes[0].label).toBe('Alpha')
    expect(nodes[1].label).toBe('Beta')
    expect(nodes[2].label).toBe('2') // no category for code 2 → numeric fallback
  })
})

describe('graphOverlay — layer prop builders (TEST-16/53)', () => {
  it('edge props expose the LineLayer accessors returning the resolved endpoints', () => {
    const centroids = graphCentroids(positions, codes)
    const edges = deriveEdges(centroids, [[0, 1, 2]])
    const props = buildEdgeLayerProps(edges)
    expect(props.data).toHaveLength(2)
    expect(props.getSourcePosition(edges[0])).toEqual([1, 0])
    expect(props.getTargetPosition(edges[0])).toEqual([11, 10])
    expect(props.widthUnits).toBe('pixels')
  })

  it('node props expose the ScatterplotLayer position accessor', () => {
    const centroids = graphCentroids(positions, codes)
    const nodes = deriveNodes(centroids)
    const props = buildNodeLayerProps(nodes)
    expect(props.data).toHaveLength(3)
    expect(props.getPosition(nodes[0])).toEqual([1, 0])
    expect(props.filled).toBe(true)
  })

  it('label props expose the TextLayer text + position accessors', () => {
    const centroids = graphCentroids(positions, codes)
    const nodes = deriveNodes(centroids, ['Alpha', 'Beta', 'Gamma'])
    const props = buildLabelLayerProps(nodes)
    expect(props.getText(nodes[0])).toBe('Alpha')
    expect(props.getPosition(nodes[2])).toEqual([21, 20])
    expect(props.sizeUnits).toBe('pixels')
  })
})

describe('graphOverlay — one-shot build (TEST-16/53)', () => {
  it('builds centroids, 2 edges, 3 nodes and all three layer prop objects', () => {
    const build = buildGraphOverlay(positions, codes, [[0, 1, 2]], ['A', 'B', 'C'])
    expect(build.centroids.size).toBe(3)
    expect(build.edges).toHaveLength(2)
    expect(build.nodes).toHaveLength(3)
    expect(build.edgeProps.data).toHaveLength(2)
    expect(build.nodeProps.data).toHaveLength(3)
    expect(build.labelProps.data).toHaveLength(3)
    expect(build.nodes.map(n => n.label)).toEqual(['A', 'B', 'C'])
  })

  it('the flat-default (order coloring OFF) leaves colors as constant tuples (byte-unchanged)', () => {
    const build = buildGraphOverlay(positions, codes, [[0, 1, 2]], ['A', 'B', 'C'])
    // constant color accessors, not per-object functions; the pre-ITEM-16 defaults.
    expect(typeof build.nodeProps.getFillColor).not.toBe('function')
    expect(build.nodeProps.getFillColor).toEqual([20, 20, 20, 255])
    expect(typeof build.edgeProps.getColor).not.toBe('function')
    expect(build.edgeProps.getColor).toEqual([40, 40, 40, 220])
    expect(build.orderValues).toBeUndefined()
  })
})

// helpers to invoke the (possibly-function) color accessors in the order-colored path.
function nodeColorAt(build: ReturnType<typeof buildGraphOverlay>, i: number): Rgba {
  const acc = build.nodeProps.getFillColor
  expect(typeof acc).toBe('function')
  return (acc as (n: OverlayNode, info: { index: number }) => Rgba)(
    build.nodeProps.data[i],
    { index: i },
  )
}
function edgeColorAt(build: ReturnType<typeof buildGraphOverlay>, i: number): Rgba {
  const acc = build.edgeProps.getColor
  expect(typeof acc).toBe('function')
  return (acc as (e: OverlayEdge, info: { index: number }) => Rgba)(
    build.edgeProps.data[i],
    { index: i },
  )
}

describe('graphOverlay — order (pseudotime) value derivation (TEST-16)', () => {
  it('a known path yields monotonically increasing order values, root 0 → tip 1', () => {
    const order = deriveOrderValues([[0, 1, 2, 3, 4]])
    const seq = [0, 1, 2, 3, 4].map(c => order.get(c)!)
    expect(seq[0]).toBe(0) // root
    expect(seq[seq.length - 1]).toBe(1) // tip
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1])
    expect(seq).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('a single-node path is safe (maps to 0, no divide-by-zero)', () => {
    const order = deriveOrderValues([[5]])
    expect(order.get(5)).toBe(0)
    expect(Number.isFinite(order.get(5)!)).toBe(true)
  })

  it('an explicit override wins wholesale when non-empty', () => {
    const order = deriveOrderValues([[0, 1, 2]], new Map([[0, 0.9], [1, 0.1]]))
    expect(order.get(0)).toBe(0.9)
    expect(order.get(1)).toBe(0.1)
  })
})

describe('graphOverlay — order (pseudotime) coloring (TEST-16)', () => {
  it('colors nodes + edges via the continuous colormap, differing from the flat default', () => {
    const build = buildGraphOverlay(positions, codes, [[0, 1, 2]], ['A', 'B', 'C'], {}, {
      colorByOrder: true,
    })
    expect(build.orderValues?.get(0)).toBe(0)
    expect(build.orderValues?.get(2)).toBe(1)
    expect(build.colormap).toBe('viridis')

    const c0 = nodeColorAt(build, 0)
    const c1 = nodeColorAt(build, 1)
    const c2 = nodeColorAt(build, 2)
    // three distinct order values → three distinct colors, none the flat [20,20,20,255].
    expect(c0).not.toEqual(c1)
    expect(c1).not.toEqual(c2)
    expect(c0).not.toEqual([20, 20, 20, 255])
    // all channels are valid bytes.
    for (const c of [c0, c1, c2]) {
      expect(c).toHaveLength(4)
      for (const ch of c) {
        expect(ch).toBeGreaterThanOrEqual(0)
        expect(ch).toBeLessThanOrEqual(255)
      }
    }

    const e0 = edgeColorAt(build, 0)
    const e1 = edgeColorAt(build, 1)
    expect(e0).not.toEqual(e1) // later segment maps to a different pseudotime color
    expect(e0).not.toEqual([40, 40, 40, 220]) // differs from the flat edge default
  })

  it('respects a chosen colormap (magma ≠ viridis for the same order value)', () => {
    const viridis = buildGraphOverlay(positions, codes, [[0, 1, 2]], undefined, {}, {
      colorByOrder: true,
      colormap: 'viridis',
    })
    const magma = buildGraphOverlay(positions, codes, [[0, 1, 2]], undefined, {}, {
      colorByOrder: true,
      colormap: 'magma',
    })
    expect(nodeColorAt(viridis, 1)).not.toEqual(nodeColorAt(magma, 1))
  })

  it('is safe on a degenerate graph — non-finite centroid nodes are dropped, no NaN color', () => {
    const pos = new Float32Array([
      0, 0, 2, 0, // group 0 → (1,0)
      NaN, NaN, NaN, NaN, // group 1 → non-finite (dropped)
      20, 20, 22, 20, // group 2 → (21,20)
    ])
    const cds = new Uint16Array([0, 0, 1, 1, 2, 2])
    const build = buildGraphOverlay(pos, cds, [[0, 1, 2]], undefined, {}, { colorByOrder: true })
    // only the two finite nodes survive; both get finite byte colors.
    expect(build.nodes.map(n => n.code)).toEqual([0, 2])
    for (let i = 0; i < build.nodes.length; i++) {
      const c = nodeColorAt(build, i)
      for (const ch of c) expect(Number.isFinite(ch)).toBe(true)
    }
    // the non-finite middle node dropped both edges → no edge colors to emit, no throw.
    expect(build.edges).toHaveLength(0)
  })

  it('is safe on a single-node graph (one node, no edges)', () => {
    const pos = new Float32Array([0, 0, 2, 0]) // group 0 only
    const cds = new Uint16Array([0, 0])
    const build = buildGraphOverlay(pos, cds, [[0]], undefined, {}, { colorByOrder: true })
    expect(build.nodes).toHaveLength(1)
    expect(build.edges).toHaveLength(0)
    const c = nodeColorAt(build, 0)
    for (const ch of c) expect(Number.isFinite(ch)).toBe(true)
  })
})
