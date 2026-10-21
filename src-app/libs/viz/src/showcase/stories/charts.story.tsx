// charts.story.tsx — one showcase story per companion statistical chart kind (violin /
// box / dotplot / heatmap / volcano / bar / histogram), each seeded from a
// `FixtureSource` and rendered through its chart VIEW component (which does the async
// data load internally, exactly like `scatter.story.tsx`). Category 'View kinds';
// `covers` names the chart kind for the story-completeness gate (DEC-36).

import { useMemo } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { BoxView } from '../../viz-core/charts/BoxView'
import { DotplotView } from '../../viz-core/charts/DotplotView'
import { HeatmapView } from '../../viz-core/charts/HeatmapView'
import { VolcanoView } from '../../viz-core/charts/VolcanoView'
import { BarView } from '../../viz-core/charts/BarView'
import { HistogramView } from '../../viz-core/charts/HistogramView'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 20_000 } as const
const VALUE_KEYS = ['Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E', 'Feature F']

/** Full-height demo pane wrapper shared by every chart story. */
function Pane({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', minHeight: 0 }}>{children}</div>
}

/** Matrix-chart pane: a caption calling out the range-zoom sliders + the full-height view.
 *  Matrix charts (heatmap / dotplot) navigate by a RANGE window (DEC-38), not free zoom —
 *  drag the row (right) / column (bottom) sliders, wheel over the grid to zoom the range,
 *  drag the grid to pan. */
function MatrixPane({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 4 }}>
      <div style={{ fontSize: 12, opacity: 0.7, padding: '2px 4px' }}>
        Range-zoom: drag the row (right) / column (bottom) sliders, wheel to zoom the range, drag to pan.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  )
}

function ViolinStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <ViolinView source={source} valueKey="Feature A" groupKey="group" />
    </Pane>
  )
}

function BoxStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <BoxView source={source} valueKey="Feature A" groupKey="group" />
    </Pane>
  )
}

function DotplotStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <MatrixPane>
      <DotplotView source={source} valueKeys={VALUE_KEYS} groupKey="group" />
    </MatrixPane>
  )
}

function HeatmapStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <MatrixPane>
      <HeatmapView source={source} valueKeys={VALUE_KEYS} groupKey="group" />
    </MatrixPane>
  )
}

function VolcanoStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <VolcanoView source={source} tableName="de" />
    </Pane>
  )
}

function BarStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <BarView source={source} groupKey="group" mode="grouped" />
    </Pane>
  )
}

function HistogramStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <HistogramView source={source} valueKey="qcA" bins={30} />
    </Pane>
  )
}

registerStory({ id: 'chart-violin', category: 'View kinds', title: 'Violin — per-group KDE (SolidPolygon)', covers: 'violin', Component: ViolinStory })
registerStory({ id: 'chart-box', category: 'View kinds', title: 'Box — Tukey IQR + whiskers + outliers', covers: 'box', Component: BoxStory })
registerStory({ id: 'chart-dotplot', category: 'View kinds', title: 'Dotplot — value×group grid (radius=fraction) · range-zoom sliders', covers: 'dotplot', Component: DotplotStory })
registerStory({ id: 'chart-heatmap', category: 'View kinds', title: 'Heatmap — mean matrix (BitmapLayer texture) · range-zoom sliders', covers: 'heatmap', Component: HeatmapStory })
registerStory({ id: 'chart-volcano', category: 'View kinds', title: 'Volcano — effect × significance + guides', covers: 'volcano', Component: VolcanoStory })
registerStory({ id: 'chart-bar', category: 'View kinds', title: 'Bar — per-category counts (grouped)', covers: 'bar', Component: BarStory })
registerStory({ id: 'chart-histogram', category: 'View kinds', title: 'Histogram — 1-D binned counts', covers: 'histogram', Component: HistogramStory })
