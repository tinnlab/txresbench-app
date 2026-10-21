// colorEditor.story.tsx — PROVES the INTERACTIVE per-group color + label editing (COLOR_PALETTE_PLAN
// "interactive editing"). A categorical scatter + a violin (categorical axis) + an INTERACTIVE
// `Legend` (per-swatch `<input type="color">` + click-to-rename), all wired through the runtime
// `colorOverride.store`:
//
//   Legend edit → store.setCategoryColor/Label(COLUMN, NAME, …) → store overrides
//     → fed back as `CategoricalOverrides` into `computeColoring` (recolors the scatter marks)
//        AND the `Legend`/`ViolinView` `overrides` prop (recolors swatches + renames the axis).
//
// The override is keyed by COLUMN + category NAME (stable identity), so it would apply to that named
// group across every pane coloring by the column — here demonstrated on one scatter + one violin.
//
// `window.__VIZ_TEST__.colorEditor` exposes the RESOLVED effective swatch hexes (== the scatter's
// point colors, since both go through `resolveEffectivePalette`) + the displayed labels AFTER an
// edit, so the e2e can assert the picker/label edit reflects in the plot + legend + axis without
// pixel-diffing a GPU canvas.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { buildScatterProps } from '../../viz-core/layers/scatter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { resolveEffectivePalette, displayCategory, rgbToHex } from '../../viz-core/data/color'
import type { CategoricalColumn } from '../../viz-core/data/wire'
import { Legend } from '../../viz-core/controls/Legend'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { overridesForColumn } from '../../adapter/colorOverride.store'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'
const VALUE_KEY = 'qcA'
const GROUP_COUNT = 8
const VIEW_STATE: OrthographicViewState = { target: [0, 0, 0], zoom: 4 } as OrthographicViewState

function EditorScatter({ positions, colors, epoch }: { positions: Float32Array; colors: Uint8Array; epoch: number }) {
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

function ColorEditorStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`): the colour
  // overrides this story writes are process-global on the singleton and would follow every story
  // mounted after it in the same page load. The reset-on-mount/unmount below was the previous
  // defence; the isolated set makes it structural.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(
    () => new FixtureSource({ seed: 42, pointCount: 40_000, groupCount: GROUP_COUNT }),
    [],
  )
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [legendCol, setLegendCol] = useState<CategoricalColumn | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())

  // Reactive read of the runtime override store → the CategoricalOverrides bundle for this column.
  const overridesMap = useStore(stores.colorOverride, s => s.overrides)
  const setCategoryColor = useStore(stores.colorOverride, s => s.setCategoryColor)
  const setCategoryLabel = useStore(stores.colorOverride, s => s.setCategoryLabel)
  const resetColumn = useStore(stores.colorOverride, s => s.resetColumn)
  const overrides = useMemo(() => overridesForColumn(overridesMap, GROUP_KEY), [overridesMap])

  // Start each session (and each e2e run) from a clean override slate for this column.
  useEffect(() => {
    resetColumn(GROUP_KEY)
    return () => resetColumn(GROUP_KEY)
  }, [resetColumn])

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

  // Recolor the scatter whenever the store's overrides change (real `computeColoring` categorical
  // path fed the same by-name maps the legend + axis resolve through → the PLOT tracks the edit).
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

  // The machine-checkable proof: the RESOLVED effective swatch hexes (== scatter point colors) +
  // displayed labels for the CURRENT override state — updated after every edit.
  const testHook = useMemo(() => {
    if (!legendCol) return null
    const eff = resolveEffectivePalette(legendCol.categories, overrides)
    const swatchHexes = eff.map(rgbToHex)
    const displayedLabels = legendCol.categories.map(c => displayCategory(c, overrides?.categoryLabels))
    return {
      swatchHexes,
      displayedLabels,
      distinctSwatchCount: new Set(swatchHexes).size,
      categoryCount: legendCol.categories.length,
    }
  }, [legendCol, overrides])

  useEffect(() => {
    if (!testHook) return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), colorEditor: testHook }
  }, [testHook])

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-color-editor"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div style={{ padding: 8, fontSize: 13, color: 'inherit' }}>
          Click a swatch color to recolor a group; click its label to rename it. Edits are live in the
          plot, the legend, and the violin axis — and ride into export.
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, padding: 8 }}>
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }} data-testid="viz-color-editor-scatter-pane">
            {positions && colors ? (
              <EditorScatter positions={positions} colors={colors} epoch={epoch} />
            ) : (
              <div style={{ padding: 16 }}>Loading fixture…</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }} data-testid="viz-color-editor-violin-pane">
            <ViolinView
              coordination={coordination}
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
                onEditColor={(code, hex) => setCategoryColor(GROUP_KEY, legendCol.categories[code], hex)}
                onEditLabel={(code, text) => setCategoryLabel(GROUP_KEY, legendCol.categories[code], text)}
                data-testid="viz-color-editor-legend"
              />
            )}
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'color-editor',
  category: 'Color / legend / colorbar',
  title: 'Interactive per-group color + label editing (legend picker → live plot + axis + export)',
  covers: 'color-editor',
  Component: ColorEditorStory,
})
