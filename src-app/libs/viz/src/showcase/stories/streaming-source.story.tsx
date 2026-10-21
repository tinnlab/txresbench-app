// streaming-source.story.tsx — the ONE STREAMING DATA-INPUT story (ITEM-10/17).
//
// Proves the consolidated `<Viz source={StreamingSource} option={…} onChange={…} />` seam renders the
// REAL grid end-to-end off the streaming path — no legacy pull `DataSource`. The app hands `<Viz>` a
// resident `StreamingFixtureSource` (which streams every bulk read as keyed byte chunks) plus a tiny
// declarative `option`; `GridWorkspace` pulls its buffers through `asDataSource(source)` and renders
// the same linked scatter + heatmap the `optionDeclarative` story draws from a `FixtureSource`. The
// `onChange` / `getOption` round-trip is proven by dispatching a selection and observing the emit.

import { useEffect, useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { StreamingFixtureSource } from '../../viz-core/data/streamingFixtures'
import { VizController } from '../../adapter/VizController'
import type { ResolvedOption, VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// A linked scatter (primary layout, continuous color-by) + heatmap (group × Features) — the same
// coordinated grid the imperative/declarative stories build, but fed entirely by streamed channels.
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'g-left', region: { col: 0 } },
    { id: 'g-right', region: { col: 1 } },
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

function StreamingSourceStory() {
  // The app holds ONLY the streaming source + the controller handle — every bulk read is a byte stream.
  const source = useMemo(() => new StreamingFixtureSource({ seed: 42, pointCount: 60_000 }), [])
  const [controller, setController] = useState<VizController | null>(null)
  const [seriesCount, setSeriesCount] = useState(0)
  const [changeCount, setChangeCount] = useState(0)
  const [lastSeries, setLastSeries] = useState(0)

  // `onMounted` proves the streaming path resolved + built the grid; `onChange` proves the
  // getOption/onChange round-trip fires after an interaction (a dispatched selection).
  const onMounted = (resolved: ResolvedOption) => setSeriesCount(resolved.series.length)
  const onChange = (o: VizOption) => {
    setChangeCount(c => c + 1)
    setLastSeries(o.series?.length ?? 0)
  }

  // e2e observation hook: the mounted-series count proves the streamed grid built; the change count +
  // last-emitted series length prove `onChange(getOption())` fired off the streaming source.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      streamingMountedSeries: seriesCount,
      streamingChangeCount: changeCount,
      streamingLastEmittedSeries: lastSeries,
      streamingHasController: controller != null,
    }
  }, [seriesCount, changeCount, lastSeries, controller])

  // Dispatch a selection ORIGINATING from the scatter — it fans through the shared Coordination store
  // to the linked heatmap and drives the debounced `onChange(getOption())` emit.
  const dispatchSelect = () => {
    const ids = Uint32Array.from({ length: 200 }, (_, i) => i * 3)
    controller?.dispatch({ type: 'select', originId: 's-scatter', ids })
  }
  const dispatchClear = () => controller?.dispatch({ type: 'select', originId: null, ids: null })

  return (
    <div
      data-testid="viz-streaming-source"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="streaming-dispatch-select" onClick={dispatchSelect}>
          dispatch select →
        </button>
        <button type="button" data-testid="streaming-dispatch-clear" onClick={dispatchClear}>
          clear
        </button>
        <span style={{ opacity: 0.6 }}>
          Streaming <code>&lt;Viz source=&#123;StreamingSource&#125;&gt;</code> — {seriesCount} series;
          onChange fired {changeCount}×
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        The app hands <code>&lt;Viz&gt;</code> a resident <code>StreamingFixtureSource</code> (every
        bulk read is a keyed byte <code>stream(channel)</code>) + a declarative <code>option</code>.
        The SAME linked scatter + heatmap grid the <code>optionDeclarative</code> story draws from a
        pull <code>FixtureSource</code> renders here entirely off the streaming path;{' '}
        <code>dispatch(&#123;type:'select'&#125;)</code> drives the{' '}
        <code>onChange(getOption())</code> round-trip.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz
          source={source}
          option={OPTION}
          onController={setController}
          onMounted={onMounted}
          onChange={onChange}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-streaming-source',
  category: 'Grid + resize',
  title: 'Streaming source — <Viz source={StreamingSource}/> renders the grid off keyed byte streams',
  covers: 'streaming-source',
  Component: StreamingSourceStory,
})
