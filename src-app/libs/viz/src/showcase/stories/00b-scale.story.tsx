// 00b-scale.story.tsx — the scale proof for shared-deck-charts (TEST-15): a LARGE grid of chart cells
// that, before the refactor, would each own a WebGL context (blowing past the browser's ~16 cap). Now
// every chart is a view in the ONE shared deck, so N cells = 1 WebGL context regardless of N. Default
// GRID_N = 100 cells (10×10). The `__VIZ_SCALE__` hook exposes the cell count for the e2e.

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { VizController } from '../../adapter/VizController'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import type { VizOption, VizEncode } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// A rotation of chart kinds (all migrated to the shared deck) + their fixture encode.
const KINDS: { type: string; encode: VizEncode }[] = [
  { type: 'volcano', encode: { table: 'de' } },
  { type: 'box', encode: { groupKey: 'group', valueKey: 'Feature A' } },
  { type: 'histogram', encode: { valueKey: 'qcA' } },
  { type: 'bar', encode: { groupKey: 'group' } },
  { type: 'violin', encode: { groupKey: 'group', valueKey: 'Feature A' } },
]

const GRID_N = 100
const COLS = 10

function buildOption(n: number): VizOption {
  return {
    dataset: { id: 'demo' },
    grid: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, region: { row: Math.floor(i / COLS), col: i % COLS } })),
    series: Array.from({ length: n }, (_, i) => {
      const k = KINDS[i % KINDS.length]
      return { id: `s${i}`, type: k.type, coordId: `c${i}`, encode: k.encode }
    }),
  }
}

function ScaleStory() {
  const source = useMemo(() => new FixtureSource({ seed: 3, pointCount: 8_000 }), [])
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story's
  // `setOption({replace:true})` builds ONE HUNDRED grid cells and 60 dataZoom windows; on the
  // singletons that is process-global and every story mounted later in the same page load inherits
  // it. Measured before this change: leaving this story left `gridWorkspace.cells=100 seq=100
  // plotInteraction.dataZoomWindows=60 datasetStore.datasets=1` behind for the rest of the suite.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [ready, setReady] = useState(false)

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
    return () => { alive = false }
  }, [source])

  useEffect(() => {
    let alive = true
    void controller.setOption(buildOption(GRID_N), { replace: true }).then(() => { if (alive) setReady(true) })
    return () => { alive = false; stores.coordination.getState().clearSelection() }
  }, [controller, stores])

  useEffect(() => {
    ;(window as unknown as { __VIZ_SCALE__?: unknown }).__VIZ_SCALE__ = { cells: GRID_N }
  }, [])

  const go = positions && colors && catalog && ready
  return (
    <div data-testid="viz-scale" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', fontSize: 12, opacity: 0.75 }}>
        <strong>Scale — {GRID_N} chart cells, ONE shared deck.</strong> Before shared-deck-charts this
        would spawn ~{GRID_N} WebGL contexts (browser cap ~16 → plots evicted); now it&apos;s 1 context.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {go ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace positions={positions} colors={colors} colorEpoch={colorEpoch} source={source} catalog={catalog} />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Mounting {GRID_N} cells…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'scale-100',
  category: 'Overview',
  title: 'Scale — 100 chart cells on ONE shared deck (1 WebGL context)',
  covers: 'scale',
  Component: ScaleStory,
})
