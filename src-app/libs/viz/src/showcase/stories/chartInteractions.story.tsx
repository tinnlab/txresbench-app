// chartInteractions.story.tsx — dedicated showcase stories for the chart INTERACTIONS /
// OVERLAYS added on top of the base view-kinds (ITEM-41/39/35): the volcano's draggable
// fold-change + p-value threshold rails (recolor + top-N labels), the violin's inner box
// + jitter strip + pairwise Mann-Whitney significance brackets, and the box plot's mean
// marker. Existing `chart-volcano/violin/box` ids in `charts.story.tsx` are left intact;
// these are new ids in the same 'View kinds' category so the showcase surfaces the
// interaction affordances explicitly. Each is seeded from a `FixtureSource`.

import { useMemo, useState } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VolcanoView } from '../../viz-core/charts/VolcanoView'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { BoxView } from '../../viz-core/charts/BoxView'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 20_000 } as const

function Pane({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', minHeight: 0 }}>{children}</div>
}

function VolcanoInteractiveStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      {/* interactive: draggable ±fc / p-value rails recolor points + place guides + top-N labels */}
      <VolcanoView source={source} tableName="de" fcThreshold={1} pThreshold={1.30103} interactive />
    </Pane>
  )
}

function ViolinSignificanceStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      {/* inner box + jitter strip + pairwise Mann-Whitney significance brackets */}
      <ViolinView source={source} valueKey="Feature A" groupKey="group" showSignificance />
    </Pane>
  )
}

function BoxMeanStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      {/* whiskers + outliers + median (from buildBoxProps) + a hollow mean marker */}
      <BoxView source={source} valueKey="Feature A" groupKey="group" showMean />
    </Pane>
  )
}

/**
 * ITEM-33 axis-pointer crosshair, browsable via a live toggle. The checkbox forwards
 * `axisPointer` into two representative charts at once: a VIOLIN (categorical x → the
 * vertical guide snaps to the nearest group; free value y) and a VOLCANO (two free value
 * axes → both guides follow the cursor). Off by default so the charts render identically
 * to their non-crosshair peers until you opt in.
 */
function AxisPointerStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  const [on, setOn] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          data-testid="viz-axispointer-toggle"
          checked={on}
          onChange={e => setOn(e.target.checked)}
        />
        Axis pointer (hover a chart to see the crosshair)
      </label>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {/* categorical x (snaps to group) + free value y */}
          <ViolinView source={source} valueKey="Feature A" groupKey="group" axisPointer={on} />
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {/* two free value axes (x = log2FC, y = -log10 p) */}
          <VolcanoView source={source} tableName="de" axisPointer={on} />
        </div>
      </div>
    </div>
  )
}

registerStory({
  id: 'chart-axis-pointer',
  category: 'Overlays',
  title: 'Axis pointer — crosshair over categorical + value axes (toggle)',
  covers: 'axis-pointer',
  Component: AxisPointerStory,
})
registerStory({
  id: 'chart-volcano-interactive',
  category: 'View kinds',
  title: 'Volcano — draggable ±fc / p thresholds + top-N labels',
  covers: 'volcano-interactive',
  Component: VolcanoInteractiveStory,
})
registerStory({
  id: 'chart-violin-significance',
  category: 'View kinds',
  title: 'Violin — inner box + jitter + significance brackets',
  covers: 'violin-significance',
  Component: ViolinSignificanceStory,
})
registerStory({
  id: 'chart-box-mean',
  category: 'View kinds',
  title: 'Box — whiskers + outliers + median + mean marker',
  covers: 'box-mean',
  Component: BoxMeanStory,
})
