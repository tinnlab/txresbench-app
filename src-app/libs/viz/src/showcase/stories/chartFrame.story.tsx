// chartFrame.story.tsx — showcase stories for the GPU chart FRAME (ITEM-17 / DEC-23): the
// shared axes / ticks / tick-labels / axis-titles / gridlines chrome that every value-space
// chart now draws via deck.gl `TextLayer` + `LineLayer` (no SVG). One story renders a fully
// framed bar chart (category x-ticks + value y-ticks + titles + dashed gridlines) with a
// live `showGrid` toggle; a second frames a histogram (value x + count y). Existing
// `chart-*` ids in `charts.story.tsx` are untouched — these are new ids in the same
// 'View kinds' category. Each is seeded from a `FixtureSource`.

import { useMemo, useState } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { BarView } from '../../viz-core/charts/BarView'
import { HistogramView } from '../../viz-core/charts/HistogramView'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 20_000 } as const

/** Full-height demo pane with an optional caption row for controls. */
function FramedPane({ children, controls }: { children: React.ReactNode; controls?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 4 }}>
      {controls && <div style={{ fontSize: 12, padding: '2px 4px' }}>{controls}</div>}
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  )
}

/** A framed bar chart with a live gridlines toggle — proves axes/ticks/labels/titles + grid. */
function ChartFrameStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  const [showGrid, setShowGrid] = useState(true)
  return (
    <FramedPane
      controls={
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="viz-chartframe-grid-toggle"
            checked={showGrid}
            onChange={e => setShowGrid(e.target.checked)}
          />
          Gridlines
        </label>
      }
    >
      <BarView source={source} groupKey="group" mode="grouped" showGrid={showGrid} />
    </FramedPane>
  )
}

/** A framed histogram — value x-axis + count y-axis + titles + gridlines. */
function HistogramFrameStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <FramedPane>
      <HistogramView source={source} valueKey="qcA" bins={30} />
    </FramedPane>
  )
}

registerStory({
  id: 'chart-frame',
  category: 'View kinds',
  title: 'Chart frame — axes + ticks + labels + titles + gridlines (toggle)',
  covers: 'chart-frame',
  Component: ChartFrameStory,
})
registerStory({
  id: 'chart-frame-histogram',
  category: 'View kinds',
  title: 'Chart frame — framed histogram (value × count)',
  covers: 'chart-frame-histogram',
  Component: HistogramFrameStory,
})
