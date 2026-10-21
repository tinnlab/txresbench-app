// colorOverrides.story.tsx — PROVES the CATEGORICAL color-override layer (COLOR_PALETTE_PLAN) is
// REAL + drives BOTH the scatter marks/legend AND the categorical AXIS (a violin), and that the
// NO-override path is the built-in palette. A mode toggle cycles:
//
//   • default    — no overrides (built-in 20-palette + raw "Group N" labels).
//   • palette     — a custom ORDERED palette (code → palette[code]).
//   • byName      — an explicit BY-NAME `categoryColors` map (stable identity per group).
//   • labels      — `categoryLabels` renaming a group ("Group 1" → "T cells") — visible in the
//                   legend AND the violin's group-axis ticks.
//   • autoextend  — a SHORT 2-color custom palette over all groups → auto-extended to N DISTINCT
//                   colors (no silent cycle).
//
// A `window.__VIZ_TEST__` hook exposes the RESOLVED effective swatch hexes + the displayed labels
// (+ a distinct-swatch count) so the e2e can assert the override reflects in the legend/axis and
// that the auto-extend produced distinct colors, without pixel-diffing a GPU canvas.

import { useEffect, useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { buildScatterProps } from '../../viz-core/layers/scatter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import {
  resolveEffectivePalette,
  displayCategory,
  rgbToHex,
  type CategoricalOverrides,
} from '../../viz-core/data/color'
import type { CategoricalColumn } from '../../viz-core/data/wire'
import { Legend } from '../../viz-core/controls/Legend'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'
const VALUE_KEY = 'qcA'
const GROUP_COUNT = 8
const VIEW_STATE: OrthographicViewState = { target: [0, 0, 0], zoom: 4 } as OrthographicViewState

type Mode = 'default' | 'palette' | 'byName' | 'labels' | 'autoextend'
const MODES: Mode[] = ['default', 'palette', 'byName', 'labels', 'autoextend']

// A vivid 8-color custom palette (all distinct) for the `palette` mode.
const CUSTOM_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
] as const

// The override bundle for each mode. Group names are "Group 1".."Group 8" (fixture).
function overridesFor(mode: Mode): CategoricalOverrides | undefined {
  switch (mode) {
    case 'default':
      return undefined
    case 'palette':
      return { palette: CUSTOM_PALETTE }
    case 'byName':
      // stable identity: these named groups always get these exact colors
      return { categoryColors: { 'Group 1': '#ff0000', 'Group 3': '#00c853', 'Group 5': '#2962ff' } }
    case 'labels':
      return { categoryLabels: { 'Group 1': 'T cells', 'Group 3': 'B cells' } }
    case 'autoextend':
      // a SHORT 2-color palette over 8 groups → auto-extend to 8 distinct colors
      return { palette: ['#e6194b', '#3cb44b'] }
  }
}

function OverrideScatter({ positions, colors, epoch }: { positions: Float32Array; colors: Uint8Array; epoch: number }) {
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const layer = useMemo(() => {
    const base = buildScatterProps({ positions, colors, radius: 3, pickable: false })
    return new ScatterplotLayer({ ...base, updateTriggers: { getFillColor: epoch } })
  }, [positions, colors, epoch])
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} data-testid="viz-scatter-canvas">
      <DeckGL views={view} controller initialViewState={VIEW_STATE} layers={[layer]} />
    </div>
  )
}

function ColorOverridesStory() {
  const source = useMemo(
    () => new FixtureSource({ seed: 42, pointCount: 40_000, groupCount: GROUP_COUNT }),
    [],
  )
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [legendCol, setLegendCol] = useState<CategoricalColumn | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())
  const [mode, setMode] = useState<Mode>('default')

  const overrides = useMemo(() => overridesFor(mode), [mode])

  // Positions + categorical column load once.
  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const cat = await source.categorical(GROUP_KEY)
      if (!alive) return
      setPositions(pos.positions)
      setLegendCol(cat)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Recolor the scatter whenever the override mode changes (real `computeColoring` categorical path).
  useEffect(() => {
    let alive = true
    void (async () => {
      const coloring = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
        ...(overrides ?? {}),
      })
      if (!alive) return
      setColors(coloring.colors)
      setEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, overrides])

  // The machine-checkable proof: the RESOLVED effective swatch hexes + displayed labels for the
  // current mode — exactly what the legend swatches + violin axis render.
  const testHook = useMemo(() => {
    if (!legendCol) return null
    const eff = resolveEffectivePalette(legendCol.categories, overrides)
    const swatchHexes = eff.map(rgbToHex)
    const displayedLabels = legendCol.categories.map(c => displayCategory(c, overrides?.categoryLabels))
    return {
      mode,
      swatchHexes,
      displayedLabels,
      distinctSwatchCount: new Set(swatchHexes).size,
      categoryCount: legendCol.categories.length,
    }
  }, [legendCol, overrides, mode])

  useEffect(() => {
    if (!testHook) return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), colorOverrides: testHook }
  }, [testHook])

  return (
    <div
      data-testid="viz-color-overrides"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>Override:</span>
        {MODES.map(m => (
          <button
            key={m}
            type="button"
            data-testid={`viz-color-overrides-mode-${m}`}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            style={{ fontWeight: mode === m ? 700 : 400 }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, padding: 8 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }} data-testid="viz-color-overrides-scatter-pane">
          {positions && colors ? (
            <OverrideScatter positions={positions} colors={colors} epoch={epoch} />
          ) : (
            <div style={{ padding: 16 }}>Loading fixture…</div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }} data-testid="viz-color-overrides-violin-pane">
          <ViolinView
            source={source}
            valueKey={VALUE_KEY}
            groupKey={GROUP_KEY}
            showSignificance={false}
            overrides={overrides}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 4 }}>
          {legendCol && (
            <Legend
              column={legendCol}
              hidden={hidden}
              onChange={setHidden}
              title="Group"
              overrides={overrides}
              data-testid="viz-color-overrides-legend"
            />
          )}
        </div>
      </div>
    </div>
  )
}

registerStory({
  id: 'color-overrides',
  category: 'Color / legend / colorbar',
  title: 'Categorical color overrides — custom palette / by-name colors / label rename (legend + axis)',
  covers: 'color-overrides',
  Component: ColorOverridesStory,
})
