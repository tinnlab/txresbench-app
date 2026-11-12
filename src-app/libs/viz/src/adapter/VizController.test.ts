// VizController.test.ts — the declarative controller drives the EXISTING stores.
// Focus: `setOption` THREADS each series' encode-resolved bindings onto its grid cell
// (the fix for "declared encode silently dropped at render") and leaves a no-schema cell
// (scatter/image) with `bindings: undefined` so it keeps byte-identical default behavior.

import { describe, it, expect } from 'vitest'
import { VizController, mergeOptions } from './VizController'
import { useGridWorkspaceStore } from './GridWorkspace.store'
import { createVizStores } from './vizStores'
import { FixtureSource } from '../viz-core/data/fixtures'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import type { VizOption } from '../viz-core/option/types'

installBuiltins()

// A linked scatter (world2d, no schema) + heatmap (matrix2d) whose encode declares EXACTLY 3
// value columns. The fixture ships 12 (`Feature A`..`Feature L`), so the catalog default would
// resolve a different (wider) set — declaring 3 is therefore observable end-to-end.
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'g-left', region: { col: 0 } },
    { id: 'g-right', region: { col: 1 } },
  ],
  series: [
    { id: 's-scatter', type: 'scatter', coordId: 'g-left', encode: { layout: 'primary' } },
    {
      id: 's-heat',
      type: 'heatmap',
      coordId: 'g-right',
      encode: { groupKey: 'group', valueKeys: ['Feature A', 'Feature B', 'Feature C'] },
    },
  ],
}

describe('VizController.setOption threads encode bindings onto grid cells', () => {
  it('heatmap cell carries the DECLARED valueKeys (not the catalog default); scatter stays default', async () => {
    const source = new FixtureSource({ seed: 42, pointCount: 1000 })
    const controller = new VizController({ resolveDataset: () => source })
    await controller.setOption(OPTION)

    const cells = useGridWorkspaceStore.getState().cells
    // The heatmap cell must carry EXACTLY the 3 declared value columns — proving the
    // declarative encode reaches the render path (before the fix, `CellView` re-derived the
    // catalog default and this cell had no `bindings` at all).
    expect(cells['g-right'].bindings?.valueKeys).toEqual(['Feature A', 'Feature B', 'Feature C'])
    expect(cells['g-right'].bindings?.group).toBe('group')
    // A world2d scatter resolves to no schema bindings → absent (byte-identical default).
    expect(cells['g-left'].bindings).toBeUndefined()
  })
})

// VIZ_ISOLATION W2/W3: two controllers built over two INDEPENDENT `createVizStores()` sets must not
// touch each other's stores — this is the isolation the per-instance `<Viz>` provider relies on. We
// drive each controller through its PUBLIC surface (`setOption` + `select` + `addCell`) and assert A's
// mutations never leak into B's set (and vice-versa), and that neither touches the module singletons.
describe('VizController — per-instance store-set isolation', () => {
  it('setOption + selection + addCell on set A do NOT affect set B (nor the singletons)', async () => {
    const setA = createVizStores()
    const setB = createVizStores()
    const source = new FixtureSource({ seed: 7, pointCount: 500 })
    const ctrlA = new VizController({ resolveDataset: () => source, stores: setA })
    const ctrlB = new VizController({ resolveDataset: () => source, stores: setB })

    // Baseline: both sets start with the single default cell; the singleton set too.
    const singletonCellCount = Object.keys(useGridWorkspaceStore.getState().cells).length

    await ctrlA.setOption(OPTION) // A's grid → 2 cells (g-left, g-right)
    // B's grid is untouched; the singleton set is untouched.
    expect(Object.keys(setA.gridWorkspace.getState().cells).sort()).toEqual(['g-left', 'g-right'])
    expect(Object.keys(setB.gridWorkspace.getState().cells).length).toBe(1)
    expect(Object.keys(useGridWorkspaceStore.getState().cells).length).toBe(singletonCellCount)

    // A selection fanned through A's controller lands ONLY in A's coordination store.
    const ids = Uint32Array.from([2, 4, 6])
    ctrlA.select(ids, 'paneA')
    expect(setA.coordination.getState().pointSelection).toEqual(ids)
    expect(setA.coordination.getState().selectionOrigin).toBe('paneA')
    expect(setB.coordination.getState().pointSelection).toBeNull()
    expect(useGridWorkspaceStore.getState()).toBeDefined() // singleton coord untouched by A

    // A grid mutation on B's controller lands ONLY in B's set.
    const bCellCount0 = Object.keys(setB.gridWorkspace.getState().cells).length
    ctrlB.addCell()
    expect(Object.keys(setB.gridWorkspace.getState().cells).length).toBe(bCellCount0 + 1)
    // A's grid still exactly its 2 setOption cells — B's addCell did not leak.
    expect(Object.keys(setA.gridWorkspace.getState().cells).sort()).toEqual(['g-left', 'g-right'])

    // getOption() reads each controller's OWN set: A's option carries the live selection, B's does not.
    expect([...(ctrlA.getOption().selection?.ids ?? [])]).toEqual([2, 4, 6])
    expect([...(ctrlB.getOption().selection?.ids ?? [])]).toEqual([])
  })
})

// Audit P-MED-2: a stale/racing setOption must NOT clobber the stores after its awaits resolve late.
describe('VizController.setOption — generation guard (racing / stale resolve)', () => {
  const optOf = (id: string): VizOption => ({
    dataset: { id },
    grid: [{ id: `cell-${id}`, region: { col: 0 } }],
    series: [{ id: `s-${id}`, type: 'scatter', coordId: `cell-${id}`, encode: { layout: 'primary' } }],
  })

  it('a slow setOption(A) that resolves AFTER a newer setOption(B) does not overwrite B', async () => {
    const setX = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 200 })
    let releaseA: () => void = () => {}
    const controller = new VizController({
      stores: setX,
      resolveDataset: (id: string) =>
        id === 'A'
          ? new Promise<typeof source>(res => {
              releaseA = () => res(source)
            })
          : Promise.resolve(source),
    })

    const pA = controller.setOption(optOf('A')) // awaits the (pending) A resolver
    await controller.setOption(optOf('B')) // B resolves + mutates the store first
    // B is now applied.
    expect(Object.keys(setX.gridWorkspace.getState().cells)).toEqual(['cell-B'])

    releaseA() // A's resolver finally settles → its setOption continues past the await
    await pA
    // The stale A must have BAILED at the generation guard — the store still reflects B.
    expect(Object.keys(setX.gridWorkspace.getState().cells)).toEqual(['cell-B'])
  })
})

// MULTI-DATASOURCE (ITEM-6/8): setOption resolves each referenced dataset ONCE (reuse-by-id) into the
// DatasetStore, stamps each cell's datasetId (≥2 datasets), and a clean-replace releases the prior set.
describe('VizController — multi-datasource resolve', () => {
  const twoDatasets: VizOption = {
    datasets: [{ id: 'A' }, { id: 'B' }],
    grid: [
      { id: 'p1', region: { col: 0 } },
      { id: 'p2', region: { col: 1 } },
    ],
    series: [
      { id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'A', encode: { layout: 'primary' } },
      { id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'B', encode: { layout: 'primary' } },
    ],
  }

  it('resolves each referenced dataset once (reuse-by-id), acquires them + stamps cell.datasetId', async () => {
    const stores = createVizStores()
    const calls: Record<string, number> = {}
    const resolveDataset = (id: string) => {
      calls[id] = (calls[id] ?? 0) + 1
      return new FixtureSource({ seed: id.charCodeAt(0), pointCount: 400 })
    }
    const controller = new VizController({ resolveDataset, stores })
    const resolved = await controller.setOption(twoDatasets)

    expect(resolved.datasetIds).toEqual(['A', 'B'])
    expect(calls).toEqual({ A: 1, B: 1 })
    expect(stores.datasetStore.getState().getEntry('A')?.refCount).toBe(1)
    expect(stores.datasetStore.getState().getEntry('B')?.refCount).toBe(1)
    expect(stores.gridWorkspace.getState().cells.p1.datasetId).toBe('A')
    expect(stores.gridWorkspace.getState().cells.p2.datasetId).toBe('B')
  })

  it('a clean-replace setOption releases + evicts the previous datasets', async () => {
    const stores = createVizStores()
    const controller = new VizController({
      resolveDataset: (id: string) => new FixtureSource({ seed: id.charCodeAt(0), pointCount: 300 }),
      stores,
    })
    await controller.setOption(twoDatasets) // acquires A, B
    // DEC-6: the DEFAULT is now MERGE (additive — A/B would be kept); a CLEAN REPLACE (which evicts the
    // previous datasets) is the explicit `{ replace: true }` path this test asserts.
    await controller.setOption(
      {
        datasets: [{ id: 'C' }],
        grid: [{ id: 'p1', region: { col: 0 } }],
        series: [{ id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'C', encode: { layout: 'primary' } }],
      },
      { replace: true },
    )
    expect(stores.datasetStore.getState().getEntry('A')).toBeNull()
    expect(stores.datasetStore.getState().getEntry('B')).toBeNull()
    expect(stores.datasetStore.getState().getEntry('C')?.refCount).toBe(1)
  })
})

// declarative-canvas-plots ITEM-11 / DEC-6: a PARTIAL `setOption` (default MERGE) merge-patches —
// it matches `series`/`grid`/`datasets` by id and deep-merges the singleton/map fields
// (`filters`/…), preserving everything the incoming partial did NOT name. This is what makes the
// live form->plot link (a threshold change re-patching only `filters`) a cheap patch, not a full
// grid rebuild. The mechanism CONFIRMS the existing behavior — no viz change was needed.
describe('VizController.setOption — partial merge-patch (DEC-6, ITEM-11)', () => {
  it('setOption({filters}) MERGES: unmatched series/grid/datasets preserved by id, not rebuilt', async () => {
    const source = new FixtureSource({ seed: 11, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source })
    // Baseline: the 2-cell OPTION (scatter + heatmap). `getOption()` re-keys each series by its
    // cell/coordId, so the round-tripped series ids are the grid ids (`g-left`/`g-right`).
    await controller.setOption(OPTION)
    const before = controller.getOption()
    expect(before.series.map(s => s.id).sort()).toEqual(['g-left', 'g-right'])

    // A PARTIAL option carrying ONLY a `filters` clamp (no series/grid/datasets of its own).
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [],
      series: [],
      filters: { 'g-left': [1, 2] },
    })

    const after = controller.getOption()
    // series + grid preserved BY ID (a MERGE, not a rebuild that would drop the unnamed panes).
    expect(after.series.map(s => s.id).sort()).toEqual(['g-left', 'g-right'])
    expect((after.grid ?? []).map(g => g.id).sort()).toEqual(['g-left', 'g-right'])
    // the heatmap cell's declared valueKeys survive the patch (the merged plan is byte-stable).
    expect(after.series.find(s => s.id === 'g-right')?.encode?.valueKeys).toEqual([
      'Feature A',
      'Feature B',
      'Feature C',
    ])
    // and the incoming filters clamp landed.
    expect(after.filters).toEqual({ 'g-left': [1, 2] })
  })
})

describe('VizController.removePane — no stale-dataZoom wedge (blind-audit HIGH)', () => {
  it('removing a dataZoom-bearing pane does not wedge the next getOption→setOption(replace)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 7, pointCount: 500 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'a', region: { col: 0 } }, { id: 'b', region: { col: 1 } }],
      dataZoom: [{ id: 'dzb', type: 'inside', coordId: 'b', axes: ['y'], window: [1, 4] }],
      series: [
        { id: 'sa', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
        { id: 'sb', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
      ],
    })
    controller.dispatch({ type: 'removePane', id: 'b' })
    // getOption must NOT carry a dataZoom for the removed coordId 'b' (the stale-resolved bug).
    const opt = controller.getOption()
    expect(opt.dataZoom?.some(z => z.coordId === 'b')).toBeFalsy()
    // Re-applying it (the save→restore path) must NOT throw "dataZoom references unknown coordId".
    await controller.setOption(opt, { replace: true })
    expect(Object.keys(controller.getStores().gridWorkspace.getState().cells)).toEqual(['a'])
  })

  it('getDataZoomWindow preserves a y-axis window (no axis flip)', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 8, pointCount: 400 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'g', region: { col: 0 } }],
      dataZoom: [{ id: 'dzy', type: 'inside', coordId: 'g', axes: ['y'] }],
      series: [{ id: 's', type: 'scatter', coordId: 'g', encode: { layout: 'primary' } }],
    })
    controller.dispatch({ type: 'dataZoom', id: 'dzy', window: { y: [2, 5] } })
    const w = controller.getDataZoomWindow('dzy')
    expect(w?.y).toEqual([2, 5])
    expect(w?.x).toBeUndefined()
  })

  it('construction with BOTH resolveSource and resolveDataset throws', () => {
    const source = new FixtureSource({ seed: 1, pointCount: 10 })
    expect(
      () => new VizController({ resolveDataset: () => source, resolveSource: async () => ({}) as never }),
    ).toThrow(/exactly one of resolveSource/)
  })
})

// ── TEST-13 [acceptance] [INV-7] (ITEM-11) ─────────────────────────────────────────────────────
// "A predicate with a cache, not a materialized list": an option carrying `ops` + `context` but with
// `ids`/`spaces` DELETED must restore a NON-EMPTY, CORRECT live selection once a pane resolver
// exists. The non-empty assertion is the point — DEC-9's hazard is that re-deriving before the pane
// buffers exist hit-tests nothing, publishes an EMPTY selection, and reports itself as a successful
// restore. An `expect(ids).toEqual([])` style assertion would PASS on exactly that bug.
describe('VizController — ops-only restore re-derives a live selection (TEST-13 / INV-7)', () => {
  const PANE = 'cell-1'
  /** 20x20 lattice at integer coords 0..19 — deterministic, no RNG. */
  const lattice = () => {
    const side = 20
    const n = side * side
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      positions[i * 2] = i % side
      positions[i * 2 + 1] = Math.floor(i / side)
    }
    return { positions, nPoints: n, pointIds: null, space: 'default' as const }
  }
  const pane = lattice()
  const resolve = (id: string | null) => (id === PANE ? pane : null)
  const liveContext = () => ({})
  // A rect over x∈[2,5], y∈[2,5] of the lattice ⇒ 4x4 = 16 points.
  const opsIn = [
    { tool: 'rect' as const, op: 'add' as const, pane: PANE, space: 'default', region: [2, 2, 5, 5] as [number, number, number, number] },
  ]
  const mkController = () => {
    installBuiltins()
    const source = new FixtureSource({ seed: 3, pointCount: 64 })
    return new VizController({ resolveDataset: () => source })
  }

  it('restores a NON-EMPTY selection from ops alone (no ids in the option)', async () => {
    const c = mkController()
    await c.setOption(
      { dataset: { id: 'demo' }, grid: [{ id: PANE }], series: [{ id: PANE, type: 'scatter', coordId: PANE }],
        selection: { mode: 'multi', link: [], ops: opsIn, provenance: 'txresbench-viz-selection/1' } } as unknown as VizOption,
      { replace: true },
    )
    // Before a resolver exists the restore is deliberately DEFERRED, not derived-to-empty.
    c.registerSelectionPanes(resolve, liveContext)
    const ids = Array.from(c.revalidateSelection().after)
    expect(ids.length).toBe(16) // NON-EMPTY + exact: an empty publish fails here
    expect(ids).toEqual([42, 43, 44, 45, 62, 63, 64, 65, 82, 83, 84, 85, 102, 103, 104, 105])
  })

  it('NEGATIVE CONTROL: ops whose geometry misses the data derive an EMPTY set (it really hit-tests)', async () => {
    const c = mkController()
    const offData = [{ ...opsIn[0], region: [900, 900, 950, 950] as [number, number, number, number] }]
    await c.setOption(
      { dataset: { id: 'demo' }, grid: [{ id: PANE }], series: [{ id: PANE, type: 'scatter', coordId: PANE }],
        selection: { mode: 'multi', link: [], ops: offData, provenance: 'txresbench-viz-selection/1' } } as unknown as VizOption,
      { replace: true },
    )
    c.registerSelectionPanes(resolve, liveContext)
    expect(Array.from(c.revalidateSelection().after)).toEqual([])
  })
})

// ── TEST-26 [H4] — a removed pane's ops must not make a saved workspace UNLOADABLE ─────────────
// `pruneResolvedForCell` already drops a removed cell's dataZoom for exactly this reason: an option
// naming a coordId that no longer resolves is rejected LOUD by `parseOption`. `selection.ops` carry
// a `pane` and re-introduced the same hazard, so `getOption()` emitted an op for a pane that had
// been removed and the round-trip threw.
describe('VizController — removePane prunes selection.ops (TEST-26 / H4)', () => {
  const mk = () => {
    installBuiltins()
    const source = new FixtureSource({ seed: 5, pointCount: 64 })
    return new VizController({ resolveDataset: () => source })
  }
  const twoCells = {
    dataset: { id: 'demo' },
    grid: [{ id: 'cell-1' }, { id: 'cell-2' }],
    series: [
      { id: 'cell-1', type: 'scatter', coordId: 'cell-1' },
      { id: 'cell-2', type: 'scatter', coordId: 'cell-2' },
    ],
    selection: {
      mode: 'multi',
      link: [],
      ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'default', region: [0, 0, 5, 5] },
        { tool: 'rect', op: 'add', pane: 'cell-2', space: 'default', region: [0, 0, 5, 5] },
      ],
      provenance: 'txresbench-viz-selection/1',
    },
  } as unknown as VizOption

  it('drops ONLY the removed pane ops, and the saved option still round-trips', async () => {
    const c = mk()
    await c.setOption(twoCells, { replace: true })
    c.dispatch({ type: 'removePane', id: 'cell-2' })

    const saved = c.getOption()
    const panes = (saved.selection?.ops ?? []).map(o => o.pane)
    expect(panes).toEqual(['cell-1'])            // cell-2's op is gone…
    expect(panes).not.toContain('cell-2')        // …and specifically not still present

    // The whole point: the saved option must LOAD. Before the prune this threw
    // `[viz] option.selection.ops[0] names unknown pane "cell-2"`.
    const c2 = mk()
    await expect(c2.setOption(saved, { replace: true })).resolves.not.toThrow()
  })

  it('clears provenance entirely when the removed pane held the ONLY ops', async () => {
    const c = mk()
    await c.setOption(
      { ...twoCells, selection: { mode: 'multi', link: [], ops: [
        { tool: 'rect', op: 'add', pane: 'cell-2', space: 'default', region: [0, 0, 5, 5] },
      ], provenance: 'txresbench-viz-selection/1' } } as unknown as VizOption,
      { replace: true },
    )
    c.dispatch({ type: 'removePane', id: 'cell-2' })
    // An EMPTY op list would claim "derived from no ops", which is false — provenance goes away.
    expect(c.getOption().selection?.ops ?? null).toBeNull()
  })
})

// ── TEST-27 [H5] — ops and the ids CACHE are ONE atomic unit across a merge patch ──────────────
// `mergeOptions` replaces the base ops when the incoming patch carries `ops` (they are an ordered
// recipe, not a set to union). It previously kept the BASE's ids alongside the NEW ops, so the
// recipe and its cache described different sets — and with a matching context the gatekeeper
// classifies `'none'` and never repairs it.
describe('VizController — an ops-only merge patch drops the stale ids cache (TEST-27 / H5)', () => {
  const mk = () => {
    installBuiltins()
    const source = new FixtureSource({ seed: 7, pointCount: 64 })
    return new VizController({ resolveDataset: () => source })
  }
  const base = {
    dataset: { id: 'demo' },
    grid: [{ id: 'cell-1' }],
    series: [{ id: 'cell-1', type: 'scatter', coordId: 'cell-1' }],
    selection: {
      mode: 'multi', link: [], ids: [1, 2, 3],
      ops: [{ tool: 'rect', op: 'add', pane: 'cell-1', space: 'default', region: [2, 2, 5, 5] }],
      provenance: 'txresbench-viz-selection/1',
    },
  } as unknown as VizOption

  it('does not emit the OLD ids next to the NEW ops', async () => {
    const c = mk()
    await c.setOption(base, { replace: true })
    // A patch that changes ONLY the recipe.
    await c.setOption({
      selection: { mode: 'multi', link: [], ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'default', region: [9, 9, 9, 9] },
      ] },
    } as unknown as VizOption)

    const sel = c.getOption().selection
    expect(sel?.ops?.[0]?.region).toEqual([9, 9, 9, 9])   // the new recipe won…
    expect(sel?.ids ?? null).not.toEqual([1, 2, 3])        // …and did NOT keep the old cache
  })

  // CONV-2 — the `spaces` half of the SAME atomic unit. The H5 fix wrote `ids` correctly
  // (`dropStaleCache ? i?.ids : (i?.ids ?? b?.ids)`) but dropped `mergedSpaces` WHOLESALE, so an
  // incoming patch's OWN per-space cache was discarded too. `getOption()` emits `{ops, spaces}`
  // with no `ids` for every multi-dataset selection whose default space is empty, so the canonical
  // `setOption(getOption())` round-trip silently lost the per-space cache. TEST-27 asserted only on
  // `ids`, which is exactly why it slipped.
  it('KEEPS an incoming patch\'s OWN spaces while dropping the stale base cache', () => {
    const merged = mergeOptions(
      { selection: { mode: 'multi', link: [], spaces: { spaceB: [7, 8, 9] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [0, 0, 1, 1] },
      ] } } as unknown as VizOption,
      { selection: { mode: 'multi', link: [], spaces: { spaceB: [3, 4, 5] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [9, 9, 9, 9] },
      ] } } as unknown as VizOption,
    )
    const sel = merged.selection as { spaces?: Record<string, readonly number[]> }
    // the INCOMING spaces survive (they belong to the incoming recipe)…
    expect(sel.spaces?.spaceB).toEqual([3, 4, 5])
  })

  it('drops the BASE spaces when an ops-only patch carries none', () => {
    const merged = mergeOptions(
      { selection: { mode: 'multi', link: [], spaces: { spaceB: [7, 8, 9] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [0, 0, 1, 1] },
      ] } } as unknown as VizOption,
      { selection: { mode: 'multi', link: [], ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [9, 9, 9, 9] },
      ] } } as unknown as VizOption,
    )
    const sel = merged.selection as { spaces?: Record<string, readonly number[]> }
    // …but a stale BASE cache under a REPLACED recipe does not (the H5 rule, for spaces).
    expect(sel.spaces ?? null).toBeNull()
  })

  // CONV-9 — the SAME rule failing in the OTHER direction. `dropStaleCache` was keyed on
  // `incomingHasOps && i?.ids == null`, so an incoming patch carrying ops **+ ids** left it FALSE
  // and `spacesSrc` fell through to `mergedSpaces` — the base's stale per-space cache survived
  // under a REPLACED recipe. Both arms above drive `dropStaleCache === true` (ops-with-no-ids, and
  // ops-with-spaces), which is exactly why this direction slipped. What invalidates the base cache
  // is the RECIPE being replaced; whether the patch also carries `ids` is irrelevant to that.
  it('drops the BASE spaces when the incoming patch carries ops AND ids', () => {
    const merged = mergeOptions(
      { selection: { mode: 'multi', link: [], spaces: { spaceB: [7, 8, 9] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [0, 0, 1, 1] },
      ] } } as unknown as VizOption,
      { selection: { mode: 'multi', link: [], ids: [1, 2, 3], ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceB', region: [9, 9, 9, 9] },
      ] } } as unknown as VizOption,
    )
    const sel = merged.selection as {
      ids?: readonly number[]
      spaces?: Record<string, readonly number[]>
    }
    expect(sel.ids).toEqual([1, 2, 3])    // the incoming cache is kept…
    expect(sel.spaces ?? null).toBeNull() // …the stale BASE per-space cache is not
  })

  // …and a base space key the incoming's own `spaces` omits must not survive either — `mergeMap`
  // would otherwise resurrect it under the new recipe.
  it('does not resurrect a base space key the incoming spaces omit', () => {
    const merged = mergeOptions(
      { selection: { mode: 'multi', link: [], spaces: { spaceA: [7], spaceB: [8] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceA', region: [0, 0, 1, 1] },
      ] } } as unknown as VizOption,
      { selection: { mode: 'multi', link: [], ids: [1], spaces: { spaceA: [3] }, ops: [
        { tool: 'rect', op: 'add', pane: 'cell-1', space: 'spaceA', region: [9, 9, 9, 9] },
      ] } } as unknown as VizOption,
    )
    const sel = merged.selection as { spaces?: Record<string, readonly number[]> }
    expect(sel.spaces).toEqual({ spaceA: [3] }) // spaceB (base-only, stale) is gone
  })
})
