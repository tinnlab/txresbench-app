// vizErrorSurface.story.tsx — proves `<Viz>`'s declarative-option ERROR SURFACE and, critically,
// the revert-clears-error lifecycle (round-4 regression fix). A BAD option (an explicit encode
// binding to a nonexistent column → `parseOption` throws → `setOption` rejects) must render a
// visible `<ChartError>`, and reverting to the last GOOD option must RESTORE the chart — the error
// must NOT stick over the (valid, already-applied) grid. Two buttons drive good ↔ bad.

import { useEffect, useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// A valid single-cell scatter grid.
const GOOD: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: 'g', region: { col: 0 } }],
  series: [{ id: 's', type: 'scatter', coordId: 'g', encode: { layout: 'primary' } }],
}
// A heatmap whose encode EXPLICITLY binds a column that does not exist → `validateBindings`
// throws at parse → `setOption` rejects → `<Viz>` renders `<ChartError>`.
const BAD: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: 'g', region: { col: 0 } }],
  series: [
    {
      id: 's',
      type: 'heatmap',
      coordId: 'g',
      encode: { groupKey: 'group', valueKeys: ['__no_such_column__'] },
    },
  ],
}

function VizErrorSurfaceStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 20_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [option, setOption] = useState<VizOption>(GOOD)

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const c = await computeColoring(source, DEFAULT_COLOR_BY)
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  const ready = positions && colors && catalog
  return (
    <div
      data-testid="viz-error-surface"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" data-testid="viz-err-good" onClick={() => setOption(GOOD)}>
          good option
        </button>
        <button type="button" data-testid="viz-err-bad" onClick={() => setOption(BAD)}>
          bad option (missing column)
        </button>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          A bad option renders an error; reverting to the good option restores the chart.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <Viz
            option={option}
            positions={positions}
            colors={colors}
            colorEpoch={colorEpoch}
            source={source}
            catalog={catalog}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-error-surface',
  category: 'States',
  title: 'Viz — declarative option error surface (bad → revert)',
  covers: 'viz-error-surface',
  Component: VizErrorSurfaceStory,
})
