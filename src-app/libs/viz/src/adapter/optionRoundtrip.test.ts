// optionRoundtrip.test.ts — the ECharts-style getOption/setOption ROUND-TRIP (ITEM-2/3/12).
//
// Proves the "save exactly where the user is" promise end-to-end: drive the live stores (grid
// splits + a per-space selection + a dataZoom window + a filter + a color override + colorBySelection),
// `getOption()` → strict-JSON round-trip (`JSON.parse(JSON.stringify(o))`) → `setOption(o,{replace})`,
// then assert every store's LIVE state reproduces the encoded option — AND that a SECOND getOption()
// is a FIXPOINT (byte-equal to the first), the rigorous proof the serialized form is lossless.
//
// A second block proves the DEFAULT (merge) path: adding a pane by a new id leaves the existing panes
// untouched and dedups a re-sent dataset (no re-resolve).

import { describe, it, expect, vi } from 'vitest'
import { VizController } from './VizController'
import { createVizStores } from './vizStores'
import { DEFAULT_SELECTION_SPACE } from './Coordination.store'
import { FixtureSource } from '../viz-core/data/fixtures'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import type { VizOption } from '../viz-core/option/types'

installBuiltins()

/** A two-pane scatter option over one dataset, with a value-axis dataZoom on the left pane. */
const BASE: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'g1', region: { col: 0 } },
    { id: 'g2', region: { col: 1 } },
  ],
  dataZoom: [{ id: 'dz1', type: 'inside', coordId: 'g1', axes: ['y'] }],
  series: [
    { id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' } },
    { id: 'g2', type: 'scatter', coordId: 'g2', encode: { layout: 'primary' } },
  ],
}

describe('VizController getOption/setOption — strict-JSON round-trip (ITEM-2/3)', () => {
  it('grid split + per-space selection + dataZoom + filter + override + colorBySelection restore EXACTLY', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 11, pointCount: 800 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption(BASE)

    // ── DRIVE the live stores through their real actions ─────────────────────────────────────
    // A grid split (creates cell-3 beside g1) — layout structure + sizes must survive.
    const splitId = controller.splitCell('g1', 'row')
    expect(splitId).toBe('cell-3')

    // A DEFAULT-space selection + a NON-default (multi-dataset) space selection (origin null so the
    // canonical-id round-trip is byte-exact — origin is transient attribution, not option state).
    stores.coordination.getState().setSelectionInSpace(DEFAULT_SELECTION_SPACE, null, Uint32Array.from([7, 3, 5]))
    stores.coordination.getState().setSelectionInSpace('spaceB', null, Uint32Array.from([20, 12]))

    // A value-axis dataZoom window on dz1 + a per-plot filter on g2 (the PlotInteraction store = the
    // single authoritative home).
    stores.plotInteraction.getState().setDataZoomWindow('dz1', { lo: 1.5, hi: 4.25 })
    stores.plotInteraction.getState().setFilter('g2', [0.2, 0.8])

    // A per-group color override + the shared color-by-selection axis.
    stores.colorOverride.getState().setCategoryColor('cell_type', 'T cells', '#ff8800')
    stores.colorOverride.getState().setCategoryLabel('cell_type', 'T cells', 'T lymphocytes')
    stores.coordination.getState().setColorBySelection('cell_type')

    // ── getOption → strict-JSON → setOption(replace) ─────────────────────────────────────────
    const o1 = controller.getOption()
    const o1json = JSON.parse(JSON.stringify(o1)) as VizOption
    // The JSON round-trip must not have altered the option (proves it is strict-JSON — no Set/Map).
    expect(o1json).toEqual(o1)

    await controller.setOption(o1json, { replace: true })

    // ── assert the LIVE store state reproduces what o1 encoded ───────────────────────────────
    const coord = stores.coordination.getState()
    expect(Array.from(coord.pointSelection ?? [])).toEqual([3, 5, 7]) // default space (sorted canonical ids)
    expect(Array.from(coord.selectionBySpace.spaceB?.ids ?? [])).toEqual([12, 20])
    expect(coord.colorBySelection).toBe('cell_type')

    const plot = stores.plotInteraction.getState()
    expect(plot.dataZoomWindows.dz1).toEqual({ lo: 1.5, hi: 4.25 })
    expect(plot.filters.g2).toEqual([0.2, 0.8])

    expect(stores.colorOverride.getState().overrides.cell_type).toEqual({
      categoryColors: { 'T cells': '#ff8800' },
      categoryLabels: { 'T cells': 'T lymphocytes' },
    })

    // Grid layout tree (nested split + sizes) reproduced verbatim; every cell's kind restored.
    const grid = stores.gridWorkspace.getState()
    expect(grid.layout).toEqual(o1.layout)
    const kinds = Object.fromEntries(Object.entries(grid.cells).map(([id, c]) => [id, c.kind]))
    expect(kinds).toEqual({ g1: 'scatter', g2: 'scatter', 'cell-3': 'scatter' })

    // ── FIXPOINT: a second getOption is byte-equal to the first → the serialized form is lossless.
    const o2 = controller.getOption()
    expect(o2).toEqual(o1json)
  })
})

describe('VizController setOption — DEFAULT merge (DEC-6)', () => {
  it('adds a pane by a NEW id, leaves existing panes untouched, and dedups the re-sent dataset', async () => {
    const stores = createVizStores()
    const calls: Record<string, number> = {}
    const resolveDataset = vi.fn((id: string) => {
      calls[id] = (calls[id] ?? 0) + 1
      return new FixtureSource({ seed: id.charCodeAt(0), pointCount: 300 })
    })
    const controller = new VizController({ resolveDataset, stores })
    await controller.setOption(BASE) // acquires 'demo' once

    // Give g2 a distinctive kind so we can prove the merge left it untouched.
    stores.gridWorkspace.getState().setCellKind('g2', 'violin')
    expect(calls).toEqual({ demo: 1 })

    // MERGE (default): add a THIRD pane split from g1, re-sending the SAME dataset id.
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'g3', split: { from: 'g1', dir: 'row' } }],
      series: [{ id: 'g3', type: 'scatter', coordId: 'g3', encode: { layout: 'primary' } }],
    })

    const cells = stores.gridWorkspace.getState().cells
    // The new pane exists…
    expect(cells.g3?.kind).toBe('scatter')
    // …and the existing panes are UNTOUCHED (g1 scatter, g2 still the violin we set).
    expect(cells.g1?.kind).toBe('scatter')
    expect(cells.g2?.kind).toBe('violin')
    expect(Object.keys(cells).sort()).toEqual(['g1', 'g2', 'g3'])

    // Dataset DEDUP (DEC-4): the re-sent id was reused, never re-resolved.
    expect(calls).toEqual({ demo: 1 })
    expect(stores.datasetStore.getState().getEntry('demo')?.refCount).toBe(1)
  })
})

describe('VizController getOption — non-default encode bindings survive (ITEM-1b overlayEncode inverse FIDELITY)', () => {
  it("a heatmap's explicit groupKey + valueKeys round-trip through getOption→setOption(replace)", async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 21, pointCount: 600 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    // A heatmap declaring a NON-DEFAULT encode: 3 EXPLICIT value columns + a group key. The fixture
    // ships 12 value columns, so the catalog default would resolve a DIFFERENT (wider) set — the 3 are
    // observable end-to-end, distinguishing bindingsToEncode FIDELITY from a default re-derivation
    // (which the plain scatter fixpoint can't, since scatter has no bindingSchema).
    const OPT: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'h', region: { col: 0 } }],
      series: [
        { id: 'h', type: 'heatmap', coordId: 'h', encode: { groupKey: 'group', valueKeys: ['Feature A', 'Feature B', 'Feature C'] } },
      ],
    }
    await controller.setOption(OPT)

    // getOption must RE-EMIT the explicit encode (the inverse actually reconstructs the bindings).
    const o1 = controller.getOption()
    const s1 = o1.series.find(s => s.id === 'h')!
    expect(s1.encode?.groupKey).toBe('group')
    expect(s1.encode?.valueKeys).toEqual(['Feature A', 'Feature B', 'Feature C'])

    // …and it SURVIVES a strict-JSON replace round-trip (fidelity, not just stability).
    await controller.setOption(JSON.parse(JSON.stringify(o1)) as VizOption, { replace: true })
    const s2 = controller.getOption().series.find(s => s.id === 'h')!
    expect(s2.encode?.groupKey).toBe('group')
    expect(s2.encode?.valueKeys).toEqual(['Feature A', 'Feature B', 'Feature C'])
  })
})

// TEST-1 [covers: ITEM-1] — the plot-editing `controls` capability round-trips through
// getOption→setOption: a NON-default control survives; an all-default option emits NO `controls`.
describe('VizController getOption/setOption — plot-editing controls round-trip (ITEM-1)', () => {
  it('a non-default controls block survives getOption → strict-JSON → setOption(replace)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 31, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      ...BASE,
      controls: { legend: { show: false }, colormap: { editable: true } },
    })
    const o1 = controller.getOption()
    // getOption re-emits ONLY the non-default flags (diffControls): legend.editable (default true) and
    // colormap.show (default true) are omitted.
    expect(o1.controls).toEqual({ legend: { show: false }, colormap: { editable: true } })
    const o1json = JSON.parse(JSON.stringify(o1)) as VizOption
    await controller.setOption(o1json, { replace: true })
    // FIXPOINT: a second getOption is byte-equal → the controls encoding is lossless.
    expect(controller.getOption().controls).toEqual(o1.controls)
  })

  it('an all-default option emits NO controls (byte-identical to pre-feature)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 32, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption(BASE)
    expect(controller.getOption().controls).toBeUndefined()
  })

  // TEST-7 [covers: ITEM-5/7] — per-cell mark style (radius/opacity) round-trips through the cell.
  it('a per-series mark style (radius+opacity) survives getOption → setOption(replace)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 33, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      ...BASE,
      series: [
        { id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' }, style: { radius: 6, opacity: 0.3 } },
        { id: 'g2', type: 'scatter', coordId: 'g2', encode: { layout: 'primary' } },
      ],
    })
    const o1 = controller.getOption()
    expect(o1.series.find(s => s.id === 'g1')?.style).toEqual({ radius: 6, opacity: 0.3 })
    expect(o1.series.find(s => s.id === 'g2')?.style).toBeUndefined()
    await controller.setOption(JSON.parse(JSON.stringify(o1)) as VizOption, { replace: true })
    expect(controller.getOption().series.find(s => s.id === 'g1')?.style).toEqual({ radius: 6, opacity: 0.3 })
  })

  // TEST-6 [covers: ITEM-4/7] — plot title + axis titles round-trip through the cell.
  it('a plot title + axis titles survive getOption → setOption(replace)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 34, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      ...BASE,
      series: [
        { id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' }, title: 'Left', axisTitles: { x: 'X1', y: 'Y1' } },
        { id: 'g2', type: 'scatter', coordId: 'g2', encode: { layout: 'primary' } },
      ],
    })
    const o1 = controller.getOption()
    expect(o1.series.find(s => s.id === 'g1')?.title).toBe('Left')
    expect(o1.series.find(s => s.id === 'g1')?.axisTitles).toEqual({ x: 'X1', y: 'Y1' })
    expect(o1.series.find(s => s.id === 'g2')?.title).toBeUndefined()
    await controller.setOption(JSON.parse(JSON.stringify(o1)) as VizOption, { replace: true })
    const g1 = controller.getOption().series.find(s => s.id === 'g1')!
    expect(g1.title).toBe('Left')
    expect(g1.axisTitles).toEqual({ x: 'X1', y: 'Y1' })
  })
})

describe('VizController getOption — controlled cell round-trips (Phase 3)', () => {
  it('a controlled series survives getOption → strict-JSON → setOption(replace)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 100 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'g1', region: { col: 0 } }],
      series: [{ id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' }, controlled: true }],
    })
    // getOption projects the controlled flag back out (not dropped).
    const saved = controller.getOption()
    expect(saved.series?.find(s => s.id === 'g1')?.controlled).toBe(true)
    // strict-JSON round-trip + replace keeps the cell controlled (no reopen-loop regression on restore).
    await controller.setOption(JSON.parse(JSON.stringify(saved)), { replace: true })
    expect(stores.gridWorkspace.getState().cells['g1'].controlled).toBe(true)
  })
})
