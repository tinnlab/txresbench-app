// optionDeclarative.story.tsx — the DECLARATIVE `VizOption` story (EXTENSIBILITY_STUDY Part 4 /
// Part 6 STEP 6). Builds the SAME coordinated grid the imperative `grid` story wires by hand —
// a linked scatter (world2d) + heatmap (matrix2d) with a shared selection + a linked color scale
// — but declaratively, through `controller.setOption(option)`. This proves the declarative path
// populates the EXISTING stores and renders through the EXISTING `GridWorkspace` (no rendering
// reimplementation): `setOption` is a translation layer, `dispatch(action)` the mutation path.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import type { ResolvedOption, VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// The Part 4 example, bound to the fixture's ids (layout 'primary', group 'group', 'Feature *'
// value columns, continuous 'qcA').
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'g-left', region: { col: 0 } },
    { id: 'g-right', region: { col: 1 } },
  ],
  dataZoom: [
    { id: 'z-scatter', type: 'inside', coordId: 'g-left', axes: ['x', 'y'] },
    { id: 'z-heat', type: 'slider', coordId: 'g-right', axes: ['x'] },
  ],
  selection: { mode: 'lasso', link: ['s-scatter', 's-heat'] },
  colorScale: { link: ['s-scatter'] },
  series: [
    {
      id: 's-scatter',
      type: 'scatter',
      coordId: 'g-left',
      encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
      emphasis: { consumesSelection: true },
      select: { produces: true },
    },
    {
      id: 's-heat',
      type: 'heatmap',
      coordId: 'g-right',
      encode: { groupKey: 'group', valueKeys: ['Feature A', 'Feature B', 'Feature C'] },
      emphasis: { consumesSelection: true },
    },
  ],
}

function OptionDeclarativeStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 120_000 }), [])
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`): `setOption`
  // hydrates grid cells, dataZoom windows AND `gridLinked` (auto-derived TRUE for two world2d
  // series in one coordinate space) — process-global on the singletons, and inherited by every
  // story mounted later in the same page load.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )

  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [resolved, setResolved] = useState<ResolvedOption | null>(null)

  const pointSelection = useStore(stores.coordination, s => s.pointSelection)

  // Load the fixture (positions/colors feed the dense scatter cell; catalog feeds the heatmap).
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

  // MOUNT THE OPTION: setOption populates the grid + coordination stores from the declarative plan.
  useEffect(() => {
    let alive = true
    void controller.setOption(OPTION).then(r => {
      if (alive) setResolved(r)
    })
    return () => {
      alive = false
      stores.coordination.getState().clearSelection()
    }
  }, [controller, stores])

  // e2e observation hook: the mounted series count + kinds prove the declarative path built the
  // grid; `optionSelectionLength` reflects a `dispatch({type:'select'})` fan-out.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      optionMountedSeries: resolved?.series.length ?? 0,
      optionSeriesKinds: resolved?.series.map(s => `${s.id}:${s.type}`).join(',') ?? '',
      optionGridLinked: resolved?.gridLinked ?? null,
      optionSelectionLength: pointSelection?.length ?? 0,
    }
  }, [resolved, pointSelection])

  // A dispatch demo: publish a selection ORIGINATING from the scatter — it fans through the shared
  // Coordination store to the linked heatmap (the `selection.link` members), exactly like the
  // imperative lasso path. Uses the real store, no reimplementation.
  const dispatchSelect = () => {
    const ids = Uint32Array.from({ length: 200 }, (_, i) => i * 3)
    controller.dispatch({ type: 'select', originId: 's-scatter', ids })
  }
  const dispatchClear = () => controller.dispatch({ type: 'select', originId: null, ids: null })

  const ready = positions && colors && catalog && resolved

  return (
    <div
      data-testid="viz-option-declarative"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="option-dispatch-select" onClick={dispatchSelect}>
          dispatch select →
        </button>
        <button type="button" data-testid="option-dispatch-clear" onClick={dispatchClear}>
          clear
        </button>
        <span style={{ opacity: 0.6 }}>
          Declarative <code>viz.setOption(option)</code> — {resolved?.series.length ?? 0} series
          {resolved ? ` (${resolved.series.map(s => s.type).join(' + ')})` : ''}; selection ={' '}
          {pointSelection?.length ?? 0} pts
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        The SAME linked scatter + heatmap grid as the imperative <code>grid</code> story, but built
        from a declarative <code>VizOption</code> (Part 4): <code>setOption</code> resolves the
        option and drives the existing <code>GridWorkspace</code> + <code>Coordination</code>
        stores; <code>dispatch(&#123;type:'select'&#125;)</code> fans a selection from the scatter
        to the linked heatmap through the same store the lasso writes.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={colorEpoch}
              source={source}
              catalog={catalog}
            />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-option-declarative',
  category: 'Grid + resize',
  title: 'Option — declarative setOption (linked scatter + heatmap, Part 4)',
  covers: 'option-declarative',
  Component: OptionDeclarativeStory,
})
