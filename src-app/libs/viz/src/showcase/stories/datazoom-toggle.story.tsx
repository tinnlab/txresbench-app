// datazoom-toggle.story.tsx — PROVES the Wave-2 "enable/disable dataZoom per plot" contract is
// real, not hardcoded. A BOX plot whose `dataZoom` is flipped between a config and `false` by a
// toggle button (the value slider appears / disappears with it), plus a SCATTER with its opt-in
// x+y sliders bound to the free camera. A `window.__VIZ_TEST__` hook exposes:
//
//   • `dataZoomBarsVisible` — the LIVE count of rail containers in the story (every rail's
//     `data-testid` ends in `-slider`; the DragRail handle/band children do NOT). Toggling the
//     box `dataZoom` to `false` REMOVES its rail (count drops); re-enabling restores it. This is
//     the machine-checkable proof that the per-plot enable/disable works.
//   • `boxDataZoomEnabled` — the toggle state.
//   • `scatterXWindow` / `scatterYWindow` — the scatter's live visible world window (moves on a
//     rail drag or a camera pan/zoom), so a drag can be asserted.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BoxView, DEFAULT_BOX_DATAZOOM } from '../../viz-core/charts/BoxView'
import { ScatterDataZoom } from '../../viz-core/ScatterDataZoom'
import type { AxisWindow } from '../../viz-core/charts/axisWindow'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'
const VALUE_KEY = 'Feature A'

function DataZoomToggleStory() {
  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: 12_000, groupCount: 5 }), [])
  const rootRef = useRef<HTMLDivElement | null>(null)

  const [boxEnabled, setBoxEnabled] = useState(true)
  const [barsVisible, setBarsVisible] = useState(0)
  const [xWin, setXWin] = useState<AxisWindow | null>(null)
  const [yWin, setYWin] = useState<AxisWindow | null>(null)

  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setPositions(pos.positions)
      setColors(c.colors)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Recount the rail containers after EVERY render (the DragRail children end in -handle-*/-band,
  // never -slider, so this counts only the rails themselves). Guarded to a real change so it can't
  // loop. This is exactly what the enable/disable e2e asserts.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const n = root.querySelectorAll(
      '[data-testid$="-slider"], [data-testid$="-cols"], [data-testid$="-rows"]',
    ).length
    setBarsVisible(prev => (prev === n ? prev : n))
  })

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      dataZoomBarsVisible: barsVisible,
      boxDataZoomEnabled: boxEnabled,
      scatterXWindow: xWin ? [xWin.lo, xWin.hi] : null,
      scatterYWindow: yWin ? [yWin.lo, yWin.hi] : null,
    }
  }, [barsVisible, boxEnabled, xWin, yWin])

  return (
    <div
      ref={rootRef}
      data-testid="viz-datazoom-toggle"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
      >
        <button
          type="button"
          data-testid="viz-datazoom-toggle-box"
          aria-pressed={boxEnabled}
          onClick={() => setBoxEnabled(v => !v)}
        >
          Box dataZoom: {boxEnabled ? 'ON' : 'OFF'}
        </button>
        <span data-testid="viz-datazoom-toggle-readout" style={{ opacity: 0.75 }}>
          Rails visible: {barsVisible}
          {xWin && ` · scatter x [${xWin.lo.toFixed(1)}, ${xWin.hi.toFixed(1)}]`}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          data-testid="viz-datazoom-toggle-box-pane"
          style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}
        >
          <BoxView
            source={source}
            valueKey={VALUE_KEY}
            groupKey={GROUP_KEY}
            dataZoom={boxEnabled ? DEFAULT_BOX_DATAZOOM : false}
          />
        </div>
        <div data-testid="viz-datazoom-toggle-scatter-pane" style={{ flex: 1, minWidth: 0 }}>
          {positions && colors ? (
            <ScatterDataZoom
              positions={positions}
              colors={colors}
              dataZoom={{ x: 'slider', y: 'slider' }}
              onWindowsChange={(x, y) => {
                setXWin(x)
                setYWin(y)
              }}
            />
          ) : (
            <div style={{ padding: 16 }}>Loading fixture…</div>
          )}
        </div>
      </div>
    </div>
  )
}

registerStory({
  id: 'datazoom-toggle',
  category: 'Controls',
  title: 'DataZoom — per-plot enable/disable (box toggle + scatter camera-bound sliders)',
  covers: 'datazoom-toggle',
  Component: DataZoomToggleStory,
})
