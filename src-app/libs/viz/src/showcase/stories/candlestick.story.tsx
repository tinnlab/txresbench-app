// candlestick.story.tsx — the showcase story for the CANDLESTICK extension. It proves the
// capability claim end-to-end: `use(CandlestickChart)` at MODULE LOAD registers the new type
// through the same extension seam the built-ins use, then a `GridWorkspace` cell of kind
// `'candlestick'` is dispatched by the SAME registry path (`CellView` → `getChartType(kind).view`)
// as every built-in chart — no engine edit, no `installBuiltins` entry. The bar-range BRUSH
// (produces a selection) + the resulting dim/emphasis (consumes it) + the price-axis dataZoom all
// run through the shared coordination + dataZoom components.

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { use } from '../../viz-core/extension'
import { OhlcFixtureSource } from '../../extensions/candlestick/ohlcFixture'
import { CandlestickChart } from '../../extensions/candlestick/candlestick'
import { registerStory } from '../registry'

// SELF-REGISTER at module load: the whole point — opting into the new chart type registers it
// into the SAME chart-type registry `installBuiltins()` populates, with ZERO core edits.
use(CandlestickChart)

function CandlestickStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). The
  // reset-on-unmount below was the previous defence, and a cleanup is only as good as its
  // completeness; isolating the set makes it unnecessary.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new OhlcFixtureSource({ seed: 7, bars: 120 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)

  useEffect(() => {
    let alive = true
    void source.catalog().then(c => {
      if (alive) setCatalog(c)
    })
    return () => {
      alive = false
    }
  }, [source])

  // Seed the grid with a SINGLE candlestick cell (no `bindings` ⇒ the descriptor's own
  // `candlestickModel` resolves the 4 distinct continuous channels). No unmount reset is needed:
  // the set is this story's own, so nothing to clean up for the next story.
  useEffect(() => {
    const store = stores.gridWorkspace.getState()
    store.reset()
    store.setCellKind(INITIAL_CELL_ID, 'candlestick')
  }, [stores])

  // No DENSE cell ⇒ the shared deck never mounts; these satisfy GridWorkspace's required props.
  const positions = useMemo(() => new Float32Array(0), [])
  const colors = useMemo(() => new Uint8Array(0), [])

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-candlestick"
        style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.7 }}>
          Candlestick (OHLC) — a NEW chart type added as a <code>use(CandlestickChart)</code>{' '}
          self-registering extension, dispatched by the SAME <code>GridWorkspace</code> → registry
          path as every built-in. Toggle <b>Brush</b> and drag over the bars to select a range
          (produces a selection); selected candles stay lit while the rest dim (consumes it). Drag
          the price slider to zoom the y axis.
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {catalog ? (
            <GridWorkspace positions={positions} colors={colors} source={source} catalog={catalog} />
          ) : (
            <div style={{ padding: 16 }}>Loading…</div>
          )}
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'viz-candlestick',
  category: 'View kinds',
  title: 'Candlestick — OHLC (self-registering extension, zero core edits)',
  covers: 'candlestick',
  Component: CandlestickStory,
})
