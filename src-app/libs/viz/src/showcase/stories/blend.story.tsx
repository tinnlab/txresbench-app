// blend.story.tsx — the BLEND MODE Phase-1 showcase (BLEND_MODE_PLAN Phase 1). A GPU scatter
// where ONE categorical column drives the BASE HUE (palette LUT) and ONE continuous column
// modulates LIGHTNESS (default) or ALPHA — "which cluster AND how much" in a single mark. Toggles
// exercise: single-channel (hue only) vs blend, the lightness/alpha channel, and the per-group vs
// shared-global domain. The 2D legend (hue rows × value ramp) renders beside it.
//
// Precisely pixel-verifying a GPU HSL modulation mid-frame is flaky, so the machine-checkable proof
// is the WIRING — a `window.__VIZ_TEST__` hook exposes whether the blend is enabled, the resolved
// channel/domain, and that BOTH per-point attributes (colorValue = codes + modValue) are bound.

import { useEffect, useMemo, useState } from 'react'
import { DeckScatterCanvas, type GpuColormapSpec } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, type BlendChannel, type ColorBy } from '../../viz-core/data/engine'
import type { Blend2DLegend } from '../../viz-core/data/blend'
import { resolveSharedDomain } from '../../viz-core/coordination/colorScale'
import { BlendLegend } from '../../viz-core/controls/BlendLegend'
import { registerStory } from '../registry'

const CATEGORY_KEY = 'group'
const VALUE_KEY = 'qcA'
// Phase-2 multi-column reduce: concat TWO categorical columns into one composite category and
// aggregate TWO continuous columns into one value. `group` (6) × `batch` (3) are INDEPENDENT, so
// the observed cross-product is larger than either alone (a visible composite domain).
const CATEGORICAL_COLUMNS = ['group', 'batch'] as const
const CONTINUOUS_COLUMNS = ['qcA', 'qcB'] as const

function BlendStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 120_000, groupCount: 6 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [codes, setCodes] = useState<Float32Array | null>(null)
  const [modValue, setModValue] = useState<Float32Array | null>(null)
  const [modDomain, setModDomain] = useState<[number, number]>([0, 1])
  const [legend2d, setLegend2d] = useState<Blend2DLegend | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  // Toggles.
  const [blendOn, setBlendOn] = useState(true)
  const [channel, setChannel] = useState<BlendChannel>('lightness')
  const [perGroupDomain, setPerGroupDomain] = useState(true)
  // Phase-2: single-column (group × qcA) vs multi-column (group+type × mean(qcA,qcB)).
  const [multiColumn, setMultiColumn] = useState(false)
  const alphaFloor = 0.12

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

  // Recompute the blend encoding whenever the domain/channel toggles change. Exercises the real
  // `computeColoring` blend branch (category codes + normalized modulation + the 2D legend).
  useEffect(() => {
    let alive = true
    void (async () => {
      const colorBy: ColorBy = {
        mode: 'blend',
        key: CATEGORY_KEY,
        categoryKey: CATEGORY_KEY,
        valueKey: VALUE_KEY,
        channel,
        alphaFloor,
        perGroupDomain,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set<number>(),
        // Phase-2 multi-column reduce: concat the categorical columns + aggregate the
        // continuous columns (mean). Absent ⇒ the single-column Phase-1 path.
        ...(multiColumn
          ? {
              categoricalColumns: [...CATEGORICAL_COLUMNS],
              continuousColumns: [...CONTINUOUS_COLUMNS],
              aggregate: 'mean' as const,
            }
          : {}),
      }
      const c = await computeColoring(source, colorBy)
      if (!alive || !c.blend) return
      // Shared-global option: run the (single-scope) shared-domain coordination so linked panels
      // would map identical values to identical colors. Per-group keeps its pre-normalized [0,1].
      const dom = perGroupDomain
        ? c.blend.modDomain
        : resolveSharedDomain(
            [{ key: VALUE_KEY, domain: c.blend.globalDomain, colormap: 'viridis' }],
            VALUE_KEY,
          ) ?? c.blend.modDomain
      setCodes(c.blend.codes)
      setModValue(c.blend.modValue)
      setModDomain(dom as [number, number])
      setLegend2d(c.blend.legend2d)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, channel, perGroupDomain, multiColumn])

  // The GPU render intent: single-channel (hue only) vs blend (hue + modulation).
  const colormapMode = useMemo<GpuColormapSpec | undefined>(() => {
    if (!codes) return undefined
    if (!blendOn) return { colorValue: codes, categorical: true }
    if (!modValue) return { colorValue: codes, categorical: true }
    return { colorValue: codes, categorical: true, blend: { modValue, channel, modDomain, alphaFloor } }
  }, [codes, modValue, blendOn, channel, modDomain])

  // Wiring proof for the driver: enabled + resolved params + BOTH attributes bound.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      blendEnabled: blendOn && !!colormapMode?.blend,
      blendChannel: channel,
      blendPerGroupDomain: perGroupDomain,
      blendModDomain: modDomain,
      // the two-attribute contract: colorValue (codes) + modValue both present when blending.
      blendTwoAttrsBound: !!colormapMode?.colorValue && !!colormapMode?.blend?.modValue,
      blendLegendRows: legend2d?.rows.length ?? 0,
      // Phase-2 wiring: whether the multi-column reduce is active + the composite domain size.
      blendComposite: multiColumn,
      blendCompositeRows: legend2d?.rows.length ?? 0,
    }
  }, [blendOn, colormapMode, channel, perGroupDomain, modDomain, legend2d, multiColumn])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="viz-blend-story">
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <button type="button" data-testid="viz-blend-toggle-btn" aria-pressed={blendOn} onClick={() => setBlendOn(v => !v)}>
          Encoding: {blendOn ? 'blend (hue + value)' : 'single-channel (hue only)'}
        </button>
        <label>
          Channel:{' '}
          <select
            data-testid="viz-blend-channel"
            value={channel}
            onChange={e => setChannel(e.target.value as BlendChannel)}
            disabled={!blendOn}
          >
            <option value="lightness">lightness</option>
            <option value="alpha">alpha</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="viz-blend-domain-btn"
          aria-pressed={perGroupDomain}
          onClick={() => setPerGroupDomain(v => !v)}
          disabled={!blendOn}
        >
          Domain: {perGroupDomain ? 'per-group' : 'shared-global'}
        </button>
        <button
          type="button"
          data-testid="viz-blend-columns-btn"
          aria-pressed={multiColumn}
          onClick={() => setMultiColumn(v => !v)}
          disabled={!blendOn}
        >
          Columns: {multiColumn ? 'multi (group+batch × mean(qcA,qcB))' : 'single (group × qcA)'}
        </button>
        <span style={{ opacity: 0.6 }}>category → hue · continuous → {channel}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          {positions && colormapMode ? (
            <DeckScatterCanvas positions={positions} colormapMode={colormapMode} colorEpoch={colorEpoch} />
          ) : (
            <div style={{ padding: 16 }}>Loading fixture…</div>
          )}
        </div>
        {blendOn && legend2d && (
          <div style={{ width: 240, padding: 12, overflow: 'auto' }}>
            <BlendLegend legend={legend2d} title="Cluster × value" />
          </div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'scatter-blend',
  category: 'View kinds',
  title: 'Scatter — blend mode (category → hue × continuous → lightness/alpha)',
  covers: 'scatter-blend',
  Component: BlendStory,
})
