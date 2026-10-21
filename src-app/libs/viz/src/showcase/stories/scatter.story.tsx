// scatter.story.tsx — the first showcase story: a GPU scatter of the fixture, colored
// by a categorical column, with a color-by switch. Exercises ITEM-4/5/3 end-to-end.

import { useEffect, useMemo, useState } from 'react'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, type ColorBy } from '../../viz-core/data/engine'
import type { ContinuousColormap } from '../../viz-core/data/color'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import {
  buildScatterTooltipFields,
  type TooltipContext,
} from '../../viz-core/tooltip/tooltipModel'
import { registerStory } from '../registry'

function ScatterStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [tooltipCtx, setTooltipCtx] = useState<TooltipContext | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [colorBy, setColorBy] = useState<ColorBy>({
    mode: 'categorical',
    key: 'group',
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set(),
  })

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      // Resident columns for the O(1) rich tooltip: positions + the grouping categorical
      // (codes+labels) + a continuous QC column surfaced as a CUSTOM extra field.
      const group = await source.categorical('group')
      const qcA = await source.continuous('qcA')
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setTooltipCtx({
        positions: pos.positions,
        codes: group.codes,
        categories: group.categories,
        columns: { qcA: qcA.value },
      })
    })()
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await computeColoring(source, colorBy)
      if (!alive) return
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, colorBy])

  // A CUSTOMIZED field spec: the defaults (group / x / y) + an extra resident QC column.
  // Each accessor reads ONE index of a resident typed array — O(1), no fetch on hover.
  const tooltipFields = useMemo(() => {
    if (!tooltipCtx) return undefined
    const qc = tooltipCtx.columns?.qcA as Float32Array | undefined
    return buildScatterTooltipFields(
      tooltipCtx,
      { group: 'Cell type' },
      qc ? [{ key: 'qcA', label: 'QC A', accessor: (i: number) => qc[i] }] : [],
    )
  }, [tooltipCtx])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <label>
          Color by:{' '}
          <select
            data-testid="scatter-colorby"
            value={`${colorBy.mode}:${colorBy.key}`}
            onChange={e => {
              const [mode, key] = e.target.value.split(':')
              setColorBy(cb => ({ ...cb, mode: mode as ColorBy['mode'], key }))
            }}
          >
            {catalog?.categoricalColumns.map(c => (
              <option key={c.id} value={`categorical:${c.id}`}>
                {c.label} (categorical)
              </option>
            ))}
            {catalog?.continuousColumns.map(c => (
              <option key={c.id} value={`continuous:${c.id}`}>
                {c.label} (continuous)
              </option>
            ))}
            {catalog?.valueColumns.map(v => (
              <option key={v} value={`value:${v}`}>
                {v} (value)
              </option>
            ))}
          </select>
        </label>
        <span style={{ opacity: 0.6 }}>
          {catalog ? `${catalog.pointCount.toLocaleString()} points` : 'loading…'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors ? (
          <DeckScatterCanvas
            positions={positions}
            colors={colors}
            colorEpoch={colorEpoch}
            tooltipContext={tooltipCtx ?? undefined}
            tooltipFields={tooltipFields}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'scatter-basic',
  category: 'View kinds',
  title: 'Scatter — color-by (categorical / continuous / value)',
  covers: 'scatter',
  Component: ScatterStory,
})

/**
 * GPU in-shader colormap (DEC-4 / ITEM-26): a continuous column is colored ON THE GPU
 * from its RAW value attribute + a colormap LUT texture — no `computeColoring` CPU
 * color loop. Recolor is a value-attribute swap + a uniform, never an O(N) JS pass.
 */
function ScatterGpuColormapStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colorValue, setColorValue] = useState<Float32Array | null>(null)
  const [colorDomain, setColorDomain] = useState<[number, number]>([0, 1])
  const [colorEpoch, setColorEpoch] = useState(0)
  const [colormap, setColormap] = useState<ContinuousColormap>('viridis')
  const [column, setColumn] = useState('qcA')

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      if (alive) setPositions(pos.positions)
    })()
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    let alive = true
    void (async () => {
      // Load the RAW value column straight to a Float32 attribute — NO color loop.
      const col = await source.continuous(column)
      if (!alive) return
      // A min/max reduction (not a per-point color pass) fixes the shader's domain.
      let lo = Infinity
      let hi = -Infinity
      const v = col.value
      for (let i = 0; i < v.length; i++) {
        if (v[i] < lo) lo = v[i]
        if (v[i] > hi) hi = v[i]
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        lo = 0
        hi = 1
      }
      setColorValue(v)
      setColorDomain([lo, hi])
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, column])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <label>
          Column:{' '}
          <select
            data-testid="scatter-gpu-column"
            value={column}
            onChange={e => setColumn(e.target.value)}
          >
            <option value="qcA">QC A</option>
            <option value="qcB">QC B</option>
            <option value="pseudo">Pseudo-order</option>
          </select>
        </label>
        <label>
          Colormap:{' '}
          <select
            data-testid="scatter-gpu-colormap"
            value={colormap}
            onChange={e => setColormap(e.target.value as ContinuousColormap)}
          >
            {(['viridis', 'magma', 'inferno', 'plasma', 'cividis'] as const).map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <span style={{ opacity: 0.6 }}>GPU in-shader colormap · no CPU color loop</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colorValue ? (
          <DeckScatterCanvas
            positions={positions}
            colormapMode={{ colorValue, colormap, colorDomain }}
            colorEpoch={colorEpoch}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'scatter-gpu-colormap',
  category: 'View kinds',
  title: 'Scatter — GPU in-shader colormap (value attribute + LUT texture)',
  covers: 'scatter-gpu',
  Component: ScatterGpuColormapStory,
})
