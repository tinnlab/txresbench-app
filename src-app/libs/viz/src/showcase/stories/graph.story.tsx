// graph.story.tsx — the "graph on top of scatter" showcase story (ITEM-16/53, DEC-34).
// Renders a GPU embedding scatter (colored by the `group` categorical) with a node-link
// GRAPH overlaid: lineage EDGES between group centroids + NODE markers + labels, all in
// one OrthographicView. The graph comes from the fixture's `graph()` (a path walking the
// groups in order — a synthetic trajectory/lineage). A toggle shows/hides the overlay.

import { useEffect, useMemo, useState } from 'react'
import { GraphScatterView } from '../../viz-core/overlays/GraphScatterView'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import type { GraphData } from '../../viz-core/data/wire'
import { registerStory } from '../registry'

function GraphOnScatterStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [codes, setCodes] = useState<Uint16Array | null>(null)
  const [categories, setCategories] = useState<readonly string[]>([])
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      // The `group` categorical drives BOTH the base coloring and the graph centroids.
      const groupCol = await source.categorical('group')
      const coloring = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      const g = await source.graph()
      if (!alive) return
      setPositions(pos.positions)
      setCodes(groupCol.codes)
      setCategories(groupCol.categories)
      setColors(coloring.colors)
      setGraph(g)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, opacity: 0.7 }}>
        Node-link graph (group lineage) overlaid on the embedding scatter — edges connect
        consecutive group centroids. Nodes + edge segments are colored by their continuous
        ORDER value (pseudotime: root → tip) through the shared viridis colormap. Toggle the
        overlay and the pseudotime coloring on the canvas.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && codes && graph ? (
          <GraphScatterView
            positions={positions}
            colors={colors}
            codes={codes}
            graph={graph}
            categories={categories}
            colorEpoch={colorEpoch}
            defaultColorByOrder
            orderColormap="viridis"
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'graph-on-scatter',
  category: 'Overlays',
  title: 'Graph overlay — node-link lineage on a scatter',
  covers: 'graph',
  Component: GraphOnScatterStory,
})
