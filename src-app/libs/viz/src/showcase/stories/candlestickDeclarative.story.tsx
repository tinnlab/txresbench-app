// candlestickDeclarative.story.tsx — the DECLARATIVE candlestick story. Proves the multi-continuous
// binding fix end-to-end on the declarative path: `VizController.setOption` mounts a `candlestick`
// series over the OHLC fixture with NO per-channel encode, so the cell carries resolved `bindings`
// and thus routes through the SHARED resolver (`resolveBindings`/`makeChartModel`, the exact code the
// fix touched). It now binds the FOUR distinct price channels (open/high/low/close) + index to their
// own columns (id-match first, then ordinal); before the fix every `continuous` channel collapsed
// onto the SAME first continuous column.
//
// Uses the `VizController` + `GridWorkspace` pattern (like `optionDeclarative.story.tsx`) rather than
// the `<Viz>` façade: OHLC data has no spatial positions, so this is a CHART-ONLY grid — the same
// path the imperative `candlestick.story.tsx` renders. (`<Viz>`'s thin wrapper does not currently
// mount a canvas for a chart-only grid — a separate finding, tracked for the declarative wave.)

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { use } from '../../viz-core/extension'
import { OhlcFixtureSource } from '../../extensions/candlestick/ohlcFixture'
import { CandlestickChart } from '../../extensions/candlestick/candlestick'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import type { ResolvedOption, VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// SELF-REGISTER at module load — the same extension seam the imperative candlestick story uses.
use(CandlestickChart)

// A single candlestick region over the OHLC dataset. NO `encode` price keys: the four price channels
// + the index channel are resolved BY THE SHARED RESOLVER from the fixture catalog's like-named
// continuous columns (index/open/high/low/close) — the exact multi-continuous case the fix makes work.
const OPTION: VizOption = {
  dataset: { id: 'ohlc' },
  grid: [{ id: 'g', region: { col: 0 } }],
  series: [{ id: 's-candles', type: 'candlestick', coordId: 'g' }],
}

function CandlestickDeclarativeStory() {
  const source = useMemo(() => new OhlcFixtureSource({ seed: 7, bars: 120 }), [])
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // previously reset ONLY the grid store on unmount — a PARTIAL cleanup, which is the same shape as
  // the bug it was written to avoid: measured, it still left
  // `coordination.exclusiveSelectionEpoch=1 datasetStore.datasets=1 datasetStore.resolver=true`
  // behind for every later story. Isolation makes the cleanup unnecessary rather than incomplete.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [resolved, setResolved] = useState<ResolvedOption | null>(null)

  useEffect(() => {
    let alive = true
    void source.catalog().then(c => {
      if (alive) setCatalog(c)
    })
    return () => {
      alive = false
    }
  }, [source])

  // Drive the declarative plan into the existing stores, then read the resolved candlestick bindings.
  useEffect(() => {
    let alive = true
    void controller.setOption(OPTION).then(r => {
      if (!alive) return
      setResolved(r)
      const b = r.series[0]?.model.bindings ?? {}
      const priceCols = ['open', 'high', 'low', 'close'].map(id => b[id])
      const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
      w.__VIZ_TEST__ = {
        ...(w.__VIZ_TEST__ ?? {}),
        candlestickDeclarativeBindings: JSON.stringify(b),
        candlestickDeclarativeDistinctPriceCols: new Set(priceCols).size,
      }
    })
    return () => {
      alive = false
    }
  }, [controller])

  const positions = useMemo(() => new Float32Array(0), [])
  const colors = useMemo(() => new Uint8Array(0), [])
  const b = resolved?.series[0]?.model.bindings

  return (
    <div
      data-testid="viz-candlestick-declarative"
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.7 }}>
        Candlestick — DECLARATIVE <code>setOption</code>. A single <code>type:'candlestick'</code>{' '}
        series with NO per-channel encode; the shared binding resolver binds the four DISTINCT price
        channels (open/high/low/close) + index from the fixture's like-named continuous columns.
        Before the multi-continuous fix these all collapsed onto one column.
        {b ? (
          <span data-testid="viz-candlestick-declarative-bindings">
            {' '}Resolved: open=<b>{String(b.open)}</b>, high=<b>{String(b.high)}</b>, low=
            <b>{String(b.low)}</b>, close=<b>{String(b.close)}</b>.
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {catalog ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={0}
              source={source}
              catalog={catalog}
            />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-candlestick-declarative',
  category: 'View kinds',
  title: 'Candlestick — declarative setOption (multi-continuous binding resolver)',
  covers: 'candlestick-declarative',
  Component: CandlestickDeclarativeStory,
})
