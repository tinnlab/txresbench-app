// 00-capabilities.story.tsx — THE capabilities overview (registered first → top of the sidebar).
// ONE coordinated grid, ONE `controller.setOption(option)`, one cell per built-in plot type. Every
// in-cell control shown is what the CORE surfaces from the declarative `VizOption` — a `colorBy`
// (→ the in-cell Legend / VisualMap overlay on a dense scatter) and a `dataZoom` slider entry (→ a
// rail on the chart types whose descriptor declares that axis). NOTHING is hand-wired for the demo:
// remove the option field and the control disappears. This is the ground-truth matrix of "what a
// caller gets declaratively today" (and, by omission, what still needs manual wiring).

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { VizController } from '../../adapter/VizController'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import type { VizOption, ResolvedOption, VizEncode } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// One row per built-in cell type: its registry `type`, the `encode` that binds it to the fixture,
// which dataZoom axes its descriptor supports (→ a slider entry), and the in-cell control the core
// renders from that config. Ordered so related kinds sit together in the grid.
type Spec = {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly encode: VizEncode
  readonly zoom: readonly ('x' | 'y')[] // dataZoom axes the descriptor declares
  readonly control: string // the in-cell control the core surfaces for this cell
}

const FEATURES = ['Feature A', 'Feature B', 'Feature C'] as const

const SPECS: readonly Spec[] = [
  { id: 'scatter-cont', type: 'scatter', title: 'Scatter · continuous', control: 'VisualMap bar (drag → filter)', zoom: ['x', 'y'],
    encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } } },
  { id: 'scatter-cat', type: 'scatter', title: 'Scatter · categorical', control: 'Legend (click → hide)', zoom: ['x', 'y'],
    encode: { layout: 'primary', colorBy: { mode: 'categorical', key: 'group' } } },
  { id: 'image', type: 'image', title: 'Image', control: 'camera + x/y zoom', zoom: ['x', 'y'],
    encode: { layout: 'image' } },
  { id: 'box', type: 'box', title: 'Box', control: 'y-axis dataZoom slider', zoom: ['y'],
    encode: { groupKey: 'group', valueKey: 'Feature A' } },
  { id: 'violin', type: 'violin', title: 'Violin', control: 'y-axis dataZoom slider', zoom: ['y'],
    encode: { groupKey: 'group', valueKey: 'Feature A' } },
  { id: 'bar', type: 'bar', title: 'Bar', control: 'y-axis dataZoom slider', zoom: ['y'],
    encode: { groupKey: 'group' } },
  { id: 'histogram', type: 'histogram', title: 'Histogram', control: '(no dataZoom)', zoom: [],
    encode: { valueKey: 'qcA' } },
  { id: 'heatmap', type: 'heatmap', title: 'Heatmap', control: 'x+y matrix dataZoom + colorbar', zoom: ['x', 'y'],
    encode: { groupKey: 'group', valueKeys: FEATURES } },
  { id: 'dotplot', type: 'dotplot', title: 'Dotplot', control: 'x+y matrix dataZoom', zoom: ['x', 'y'],
    encode: { groupKey: 'group', valueKeys: FEATURES } },
  { id: 'volcano', type: 'volcano', title: 'Volcano', control: '(no dataZoom)', zoom: [],
    encode: { table: 'de' } },
]

// ALL plot types in ONE grid, ONE deck, ONE WebGL context (shared-deck-charts). Every chart cell now
// renders as a VIEW in the single grid deck — so this 2×5 grid of heterogeneous plots (which used to
// blow past the browser's ~16-context cap and evict plots) runs on a single shared context.
const COLS = 5
function buildOption(): VizOption {
  return {
    dataset: { id: 'demo' },
    grid: SPECS.map((s, i) => ({ id: s.id, region: { row: Math.floor(i / COLS), col: i % COLS } })),
    dataZoom: SPECS.filter(s => s.zoom.length > 0).map(s => ({
      id: `z-${s.id}`,
      type: 'slider' as const,
      coordId: s.id,
      axes: [...s.zoom],
    })),
    series: SPECS.map(s => ({ id: `ser-${s.id}`, type: s.type, coordId: s.id, encode: s.encode })),
  }
}

function CapabilitiesStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 60_000 }), [])
  // ISOLATED store set (VIZ_ISOLATION W1), NOT the module singletons — the same thing `<Viz>`
  // does for every app mount, and what `multi-datasource.story.tsx` already does here.
  //
  // WHY IT MATTERS THAT *THIS* STORY IS ISOLATED. This story is registered FIRST, so it is the
  // one the Showcase mounts at LANDING — before `openStory` clicks anything. It drives a
  // `VizController.setOption({replace:true})`, and `setOption` HYDRATES the coordination store
  // with the option's resolved `gridLinked`, which `parse.ts` auto-derives as TRUE here (two
  // `scatter` series over layout `primary` ⇒ ≥2 world2d series in one coordinate space). On the
  // module singletons that write is PROCESS-GLOBAL and survives the story switch, so EVERY viz
  // spec used to reach its own story with `gridLinked` already ON and this grid's cells in the
  // grid-workspace store. That silently inverted `linked-panels.spec.ts`'s precondition: its
  // "turn link ON" click never fired (the toggle already read `aria-pressed=true`), so
  // `toggleLinked`'s shared-scope SEED never ran and `gridSharedZoom` stayed null. Isolating the
  // set makes a story switch leave no residue — the cause, not the symptom.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [resolved, setResolved] = useState<ResolvedOption | null>(null)

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
    void controller.setOption(buildOption(), { replace: true }).then(r => { if (alive) setResolved(r) })
    return () => { alive = false; stores.coordination.getState().clearSelection() }
  }, [controller, stores])

  const ready = positions && colors && catalog && resolved

  return (
    <div data-testid="viz-capabilities" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 8px 4px', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Plot-type capabilities</strong>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          {SPECS.length} plot types, ONE grid, ONE shared deck (one WebGL context) — each in-cell control
          derived from the <code>VizOption</code> (colorBy → legend/visualMap; dataZoom → slider)
        </span>
      </div>
      <div
        data-testid="viz-capabilities-key"
        style={{ padding: '0 8px 6px', display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, opacity: 0.75 }}
      >
        {SPECS.map(s => (
          <span key={s.id} style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 4, padding: '1px 6px' }}>
            <b>{s.title}</b> — {s.control}
          </span>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace positions={positions} colors={colors} colorEpoch={colorEpoch} source={source} catalog={catalog} />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'capabilities',
  category: 'Overview',
  title: 'Capabilities — every plot type + its option-driven in-cell controls',
  covers: 'capabilities',
  Component: CapabilitiesStory,
})
