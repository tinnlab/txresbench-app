// heatmap.story.tsx — the ENRICHED heatmap showcase story (ITEM-36/37/38): clustered
// rows + cols with `PathLayer` dendrograms, a categorical annotation track, and a live
// z-score toggle — all seeded from a `FixtureSource` and rendered through `HeatmapView`
// (which loads its data internally, like `charts.story.tsx`). Category 'View kinds';
// `covers: 'heatmap'` for the story-completeness gate (DEC-36). The plain-mean heatmap
// story keeps its own id (`chart-heatmap`) in `charts.story.tsx`.

import { useMemo } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { HeatmapView } from '../../viz-core/charts/HeatmapView'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 20_000 } as const
const VALUE_KEYS = ['Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E', 'Feature F']

function EnrichedHeatmapStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 4 }}>
      <div style={{ fontSize: 12, opacity: 0.7, padding: '2px 4px' }}>
        Range-zoom (DEC-38): drag the row (right) / column (bottom) sliders, wheel over the matrix to
        zoom the range, drag to pan. Dendrograms + annotation track stay framed at the full window.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HeatmapView
          source={source}
          valueKeys={VALUE_KEYS}
          groupKey="group"
          clusterRows
          clusterCols
          showDendrogram
          showAnnotation
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'heatmap-enriched',
  category: 'View kinds',
  title: 'Heatmap — clustered + dendrograms + annotation track · range-zoom sliders',
  covers: 'heatmap',
  Component: EnrichedHeatmapStory,
})
