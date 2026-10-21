// controls.story.tsx — the Controls showcase story (ITEM-66, covers 'visualMap'). A GPU
// scatter of the fixture colored by a CONTINUOUS column, with the draggable visualMap BAR
// beside it: dragging the bar's two handles sets a [lo,hi] value range that filters the
// scatter points ON THE GPU via a `DataFilterExtension.filterRange` (DEC-26 — interaction
// is a GPU filter uniform, zero per-frame CPU re-upload). A categorical Legend + a
// continuous Colorbar are shown alongside to exercise all four control primitives.

import { useEffect, useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { buildScatterProps } from '../../viz-core/layers/scatter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import type { CategoricalColumn } from '../../viz-core/data/wire'
import type { ColorbarDescriptor } from '../../viz-core/data/color'
import { VisualMap, visualMapFilterProps } from '../../viz-core/controls/VisualMap'
import { Legend } from '../../viz-core/controls/Legend'
import { Colorbar } from '../../viz-core/controls/Colorbar'
import { registerStory } from '../registry'

const COLORMAP = 'viridis' as const
const CONTINUOUS_KEY = 'qcA'
const CATEGORICAL_KEY = 'group'

const VIEW_STATE: OrthographicViewState = { target: [0, 0, 0], zoom: 4 } as OrthographicViewState

/** An inline filter-capable scatter canvas (mirrors DeckScatterCanvas, adding the
 *  DataFilterExtension binary attribute + filterRange + updateTriggers on the range). */
function FilteredScatter({
  positions,
  colors,
  filterValues,
  range,
  colorEpoch,
}: {
  positions: Float32Array
  colors: Uint8Array
  filterValues: Float32Array
  range: readonly [number, number]
  colorEpoch: number
}) {
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])

  const layer = useMemo(() => {
    const base = buildScatterProps({ positions, colors, radius: 3, pickable: false })
    const filter = visualMapFilterProps(range)
    return new ScatterplotLayer({
      ...base,
      data: {
        length: base.data.length,
        attributes: {
          ...base.data.attributes,
          // binary per-point filter value (takes precedence over the accessor)
          getFilterValue: { value: filterValues, size: 1 },
        },
      },
      filterRange: filter.filterRange,
      extensions: filter.extensions,
      updateTriggers: { getFillColor: colorEpoch, getFilterValue: 0 },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, colors, filterValues, range[0], range[1], colorEpoch])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} data-testid="viz-scatter-canvas">
      <DeckGL views={view} controller initialViewState={VIEW_STATE} layers={[layer]} />
    </div>
  )
}

function ControlsStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [filterValues, setFilterValues] = useState<Float32Array | null>(null)
  const [colorbar, setColorbar] = useState<ColorbarDescriptor | null>(null)
  const [legendCol, setLegendCol] = useState<CategoricalColumn | null>(null)
  const [domain, setDomain] = useState<readonly [number, number]>([0, 1])
  const [range, setRange] = useState<[number, number]>([0, 1])
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const col = await source.continuous(CONTINUOUS_KEY)
      const cat = await source.categorical(CATEGORICAL_KEY)
      const coloring = await computeColoring(source, {
        mode: 'continuous',
        key: CONTINUOUS_KEY,
        colormap: COLORMAP,
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setPositions(pos.positions)
      setColors(coloring.colors)
      setColorEpoch(e => e + 1)
      setFilterValues(col.value)
      setLegendCol(cat)
      if (coloring.colorbar) {
        setColorbar(coloring.colorbar)
        setDomain(coloring.colorbar.domain)
        setRange([coloring.colorbar.domain[0], coloring.colorbar.domain[1]])
      }
    })()
    return () => {
      alive = false
    }
  }, [source])

  return (
    <div style={{ display: 'flex', height: '100%', gap: 12, padding: 8 }}>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {positions && colors && filterValues ? (
          <FilteredScatter
            positions={positions}
            colors={colors}
            filterValues={filterValues}
            range={range}
            colorEpoch={colorEpoch}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 4 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>
            visualMap — drag to filter
          </div>
          <VisualMap
            min={domain[0]}
            max={domain[1]}
            colormap={COLORMAP}
            value={range}
            onChange={setRange}
            length={220}
          />
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            showing {range[0].toFixed(1)}–{range[1].toFixed(1)}
          </div>
        </div>
        {colorbar && <Colorbar descriptor={colorbar} title="QC A (value)" length={140} />}
        {legendCol && (
          <Legend column={legendCol} hidden={hidden} onChange={setHidden} title="Group" />
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'controls-visualmap',
  category: 'Controls',
  title: 'visualMap bar — GPU value-range filter (+ legend + colorbar)',
  covers: 'visualMap',
  Component: ControlsStory,
})
