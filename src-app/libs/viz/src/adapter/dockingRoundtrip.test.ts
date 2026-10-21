// dockingRoundtrip.test.ts — the pop-out DOCKING round-trip (ITEM-18/DEC-15).
//
// Proves the docking half of "save exactly where the user is": a pane DOCKED OUT into a pop-out
// container keeps its series + config through `getOption()` → strict-JSON → `setOption(replace)`.
// Before ITEM-18, `getOption` emitted `grid`/`series` for the MAIN-grid leaves only, so a docked-out
// pane lost its config on restore (only its container placement rode `docking`). Now `getOption`
// emits EVERY cell (main + docked), and `setOption(replace)` feeds the `docking` snapshot back through
// the grid store's `hydrate` — so the docked LAYOUT (containers / paneContainer / anchors) AND the
// docked cell's config both round-trip.
//
// REOPEN NOTE (ITEM-19, deferred): restore rebuilds the docked layout and lists the pop-out container
// in `pendingRestore` for the window layer to reopen; this package does NOT call `window.open`.

import { describe, it, expect, vi } from 'vitest'
import { VizController } from './VizController'
import { createVizStores } from './vizStores'
import { FixtureSource } from '../viz-core/data/fixtures'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import { leafIds } from '@ziee/dock'
import type { VizOption } from '../viz-core/option/types'

installBuiltins()

/** A two-pane option over one dataset (left scatter, right — later — docked out as a violin). */
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

describe('VizController getOption/setOption — pop-out DOCKING round-trip (ITEM-18)', () => {
  it('a docked-out pane keeps its series + config, and restore reconstructs the docked layout', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 17, pointCount: 500 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption(BASE)

    // ── DOCK a pane OUT ──────────────────────────────────────────────────────────────────────
    // Give g2 a DISTINCTIVE, non-default kind (its config), then pop it out into a pop-out container
    // (`popup:1`). `movePane` removes g2 from the MAIN tree (main = [g1] only) and records g2 → popup:1.
    stores.gridWorkspace.getState().setCellKind('g2', 'violin')
    stores.gridWorkspace.getState().movePane('g2', 'popup:1', { kind: 'root' })

    // Sanity: the live store really did dock g2 out.
    const live = stores.gridWorkspace.getState()
    expect(leafIds(live.layout)).toEqual(['g1']) // main grid holds only g1 now
    expect(live.paneContainer.g2).toBe('popup:1') // g2 is in the pop-out container
    expect(leafIds(live.containerLayouts['popup:1'])).toContain('g2')

    // ── getOption → the docked cell's series + config are PRESENT + docking captured ──────────
    const o1 = controller.getOption()

    // The main `layout` still carries only the MAIN-grid leaf…
    expect(leafIds(o1.layout!)).toEqual(['g1'])
    // …but grid + series now carry the DOCKED cell too (ITEM-18).
    expect(o1.grid.map(g => g.id).sort()).toEqual(['g1', 'g2'])
    const g2series = o1.series.find(s => s.id === 'g2')
    expect(g2series).toBeDefined()
    expect(g2series!.type).toBe('violin') // the docked cell's config round-trips
    expect(g2series!.coordId).toBe('g2')
    // `docking` is captured verbatim (container list + per-pane binding + anchors).
    expect(o1.docking).toBeDefined()
    expect(o1.docking!.paneContainer.g2).toBe('popup:1')
    expect(o1.docking!.containers.map(c => c.id)).toContain('popup:1')
    expect(leafIds(o1.docking!.containers.find(c => c.id === 'popup:1')!.layout)).toContain('g2')

    // Strict-JSON: the docking snapshot survives a JSON round-trip untouched (no Set/Map).
    const o1json = JSON.parse(JSON.stringify(o1)) as VizOption
    expect(o1json).toEqual(o1)

    // ── setOption(replace) into a FRESH controller/stores (a "reload") ───────────────────────
    const stores2 = createVizStores()
    const controller2 = new VizController({
      resolveDataset: () => new FixtureSource({ seed: 17, pointCount: 500 }),
      stores: stores2,
    })
    await controller2.setOption(o1json, { replace: true })

    // The grid store RECONSTRUCTS the docked layout from `docking` (containers / paneContainer / anchors)…
    const restored = stores2.gridWorkspace.getState()
    expect(leafIds(restored.layout)).toEqual(['g1']) // main grid = g1 only (docked cell NOT in main tree)
    expect(restored.paneContainer.g2).toBe('popup:1') // g2 docked into popup:1 again
    expect(restored.containerLayouts['popup:1']).toBeDefined()
    expect(leafIds(restored.containerLayouts['popup:1'])).toContain('g2')
    // …AND the docked cell's config is restored (kind survived the round-trip).
    expect(restored.cells.g2?.kind).toBe('violin')
    expect(restored.cells.g1?.kind).toBe('scatter')
    // REOPEN deferred (ITEM-19): the restored pop-out container is queued for the window layer to
    // reopen — no `window.open` here.
    expect(restored.pendingRestore).toContain('popup:1')

    // ── FIXPOINT on the RESOLVED form: a second getOption→replace→getOption is byte-stable, the
    // rigorous proof the docking round-trip is lossless. (The resolved form is the fixpoint because a
    // schema chart's default bindings are resolved on the first parse.)
    const o2 = controller2.getOption()
    expect(o2.docking!.paneContainer.g2).toBe('popup:1')
    expect(o2.series.find(s => s.id === 'g2')!.type).toBe('violin')
    const o2json = JSON.parse(JSON.stringify(o2)) as VizOption
    await controller2.setOption(o2json, { replace: true })
    const o3 = controller2.getOption()
    expect(o3).toEqual(o2json)
  })

  it('a single-window (no-docking) workspace emits NO docking and stays byte-identical', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 300 })
    const resolveDataset = vi.fn(() => source)
    const controller = new VizController({ resolveDataset, stores })
    await controller.setOption(BASE)

    const o = controller.getOption()
    // No pane docked out ⇒ no `docking` key, and grid/series cover exactly the main-grid leaves.
    expect(o.docking).toBeUndefined()
    expect(o.grid.map(g => g.id).sort()).toEqual(['g1', 'g2'])
    expect(leafIds(o.layout!).sort()).toEqual(['g1', 'g2'])

    // Round-trips through the byte-identical single-window path.
    const ojson = JSON.parse(JSON.stringify(o)) as VizOption
    await controller.setOption(ojson, { replace: true })
    expect(controller.getOption()).toEqual(ojson)
  })
})
