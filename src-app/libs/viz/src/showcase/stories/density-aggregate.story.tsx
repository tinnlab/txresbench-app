// density-aggregate.story.tsx — the "aggregate then shade" density view over a LARGE
// fixture (research item #1). Renders a 2,000,000-point FixtureSource through the real GPU
// DensityView: at this scale drawing every point is wasted overdraw, so the view bins to a
// viewport-sized screen grid and colormaps the per-cell aggregate — the render cost tracks
// the on-screen cell count, not the point count.
//
// Controls: a COUNT / MEAN toggle (mean colors each bin by the mean of a continuous value
// column — "mean expression per bin"; count colors by raw density) and a cell-size (px)
// control that changes the density resolution + the cost bound. The planned grid dims are
// mirrored onto `window.__VIZ_TEST__.densityGridDims` so the orchestrator's real-GPU harness
// can assert the cost bound + drive parity against the `densityBin` CPU oracle.

import { useEffect, useMemo, useState } from 'react'
import { DensityView } from '../../viz-core/density/DensityView'
import type { DensityGrid, DensityMode } from '../../viz-core/density/densityBin'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

const DEFAULT_POINTS = 2_000_000
const CELL_PX_OPTIONS = [8, 16, 24, 40, 64]

function DensityAggregateStory() {
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: points }), [points])

  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [values, setValues] = useState<Float32Array | null>(null)
  const [mode, setMode] = useState<DensityMode>('mean')
  const [cellPx, setCellPx] = useState(24)
  const [grid, setGrid] = useState<DensityGrid | null>(null)

  // Load the large fixture: positions + a continuous column to average per bin.
  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const col = await source.continuous('qcA')
      if (!alive) return
      setPositions(pos.positions)
      setValues(col.value)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Mirror the planned grid dims (the cost bound) onto window for the harness.
  useEffect(() => {
    if (!grid || typeof window === 'undefined') return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      densityGridDims: {
        gridW: grid.gridW,
        gridH: grid.gridH,
        cellCount: grid.cellCount,
        cellPx: grid.cellPx,
      },
    }
  }, [grid])

  const loaded = positions && values

  return (
    <div
      data-testid="viz-density-aggregate"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div
        style={{
          padding: 8,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 600 }}>Density aggregate</span>
        {pointControl}
        <span style={{ opacity: 0.7 }}>{points.toLocaleString()} points → screen-grid bins</span>

        <span role="group" aria-label="Aggregation mode" style={{ display: 'inline-flex', gap: 4 }}>
          {(['mean', 'count'] as DensityMode[]).map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`viz-density-mode-${m}`}
              onClick={() => setMode(m)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: '1px solid #ccc',
                cursor: 'pointer',
                background: mode === m ? '#3355dd' : '#f2f2f2',
                color: mode === m ? '#fff' : '#222',
              }}
            >
              {m === 'mean' ? 'Mean (value)' : 'Count'}
            </button>
          ))}
        </span>

        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span>cell px</span>
          <select
            data-testid="viz-density-cellpx"
            value={cellPx}
            onChange={e => setCellPx(Number(e.target.value))}
          >
            {CELL_PX_OPTIONS.map(px => (
              <option key={px} value={px}>
                {px}
              </option>
            ))}
          </select>
        </label>

        <span
          data-testid="viz-density-grid-readout"
          style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.85 }}
        >
          {grid
            ? `grid ${grid.gridW}×${grid.gridH} = ${grid.cellCount.toLocaleString()} cells · mode=${mode}`
            : 'sizing…'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {loaded ? (
          <DensityView
            positions={positions}
            values={values}
            mode={mode}
            cellPx={cellPx}
            colormap="viridis"
            onGridDims={setGrid}
          />
        ) : (
          <div style={{ padding: 16 }}>Generating {points.toLocaleString()}-point fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'density-aggregate',
  category: 'Scale / perf',
  title: 'Density aggregate — bin-then-shade for the 10M+ zoomed-out tier',
  covers: 'density',
  Component: DensityAggregateStory,
})
