// migrateOption.test.ts — ITEM-7. `migrateOption(raw): VizOption` forward-migrates any persisted
// blob into a current `VizOption`, absorbing the (superseded) `sessionState.ts` v1/v2/v3 migration
// arms: a VizSessionState snapshot (v1 added dataZoom/filter interaction; v2 added docking keys; v3
// added the multi-dataset id set), a legacy WorkspaceSpec, and a current VizOption — while REFUSING
// a newer-than-this-build blob rather than dropping state.

import { describe, it, expect } from 'vitest'
import { migrateOption, VIZ_OPTION_VERSION } from './parse'
import type { LayoutNode } from '@ziee/dock'

const LAYOUT: LayoutNode = {
  kind: 'split',
  dir: 'col',
  sizes: [0.5, 0.5],
  children: [
    { kind: 'leaf', id: 'cell-0' },
    { kind: 'leaf', id: 'cell-1' },
  ],
}

/** A VizSessionState-shaped snapshot at the given version (all v1/v2/v3 fields are optional). */
const sessionSnapshot = (version: number, extra: Record<string, unknown> = {}) => ({
  version,
  dataset: { id: 'demo' },
  grid: {
    layout: LAYOUT,
    cells: {
      'cell-0': { id: 'cell-0', kind: 'scatter', layoutId: 'primary' },
      'cell-1': { id: 'cell-1', kind: 'violin', layoutId: 'primary' },
    },
    seq: 2,
  },
  interaction: {
    viewStates: {},
    selection: { ids: [5, 1, 9], origin: null },
    gridLinked: false,
    colorScales: { 'grid:embedding:primary': { key: 'qcA', domain: [0, 42], colormap: 'viridis' } },
    colorBySelection: 'group',
    dataZoomWindows: {},
    filters: { 'cell-0::qcA': [3, 8] },
    colorOverrides: { group: { categoryColors: { A: '#ff0000' } } },
  },
  ...extra,
})

describe('migrateOption — VizSessionState v1/v2/v3 arms', () => {
  it('v1 snapshot → a VizOption (grid ids, layout, series from cells, interaction fields carried)', () => {
    const opt = migrateOption(sessionSnapshot(1))
    expect(opt.version).toBe(VIZ_OPTION_VERSION)
    expect(opt.grid.map(g => g.id).sort()).toEqual(['cell-0', 'cell-1'])
    expect(opt.layout).toEqual(LAYOUT)
    // series reconstructed from cells (id = cell id, type = kind).
    expect(opt.series.map(s => [s.id, s.type]).sort()).toEqual([
      ['cell-0', 'scatter'],
      ['cell-1', 'violin'],
    ])
    // selection ids carried + SORTED (strict-JSON).
    expect(opt.selection?.ids).toEqual([1, 5, 9])
    // colorScale domains derived from the colorScales scope (keyed by the scope's column key).
    expect(opt.colorScale?.domains).toEqual({ qcA: [0, 42] })
    expect(opt.filters).toEqual({ 'cell-0::qcA': [3, 8] })
    expect(opt.colorBySelection).toBe('group')
    expect(opt.colorOverrides).toEqual({ group: { categoryColors: { A: '#ff0000' } } })
  })

  it('v2 snapshot (adds OPTIONAL docking keys to the grid slice) → migrates, no throw', () => {
    const snap = sessionSnapshot(2)
    // v2 additive docking keys live on the grid slice; migrateOption tolerates them.
    ;(snap.grid as Record<string, unknown>).containerLayouts = {}
    ;(snap.grid as Record<string, unknown>).containerLayouts = { pop1: LAYOUT }
    ;(snap.grid as Record<string, unknown>).paneContainer = { 'cell-1': 'pop1' }
    const opt = migrateOption(snap)
    expect(opt.version).toBe(VIZ_OPTION_VERSION)
    expect(opt.layout).toEqual(LAYOUT)
    // DOCUMENTED legacy-migration boundary (parse.ts banner): the pre-cutover VizSessionState stored
    // docking as separate `grid.containerLayouts`/`grid.paneContainer` keys with NO 1:1 map to the
    // current `DockingSnapshot`, so `sessionStateToOption` does NOT reconstruct `docking` from a v2
    // blob (it would be a guess). Assert that explicitly — this is the ENUMERATED, non-silent boundary,
    // NOT a masked drop. (The forward getOption/setOption path round-trips docking for current options.)
    expect(opt.docking).toBeUndefined()
  })

  it('v3 snapshot (adds dataset.ids + per-cell datasetId) → carries the multi-dataset set', () => {
    const snap = sessionSnapshot(3, {})
    snap.dataset = { id: 'A', ids: ['A', 'B'] } as never
    ;(snap.grid.cells['cell-1'] as Record<string, unknown>).datasetId = 'B'
    const opt = migrateOption(snap)
    expect(opt.datasets?.map(d => d.id)).toEqual(['A', 'B'])
    // the per-cell datasetId rides onto the reconstructed series.
    expect(opt.series.find(s => s.id === 'cell-1')?.datasetId).toBe('B')
  })

  it('REFUSES a session snapshot newer than the absorbed max (v4) rather than dropping state', () => {
    expect(() => migrateOption(sessionSnapshot(4))).toThrow(/newer than this build/)
  })
})

describe('migrateOption — legacy WorkspaceSpec arm', () => {
  it('wraps a top-level {layout, cells[]} spec forward (drops the legacy string colorBy)', () => {
    const spec = {
      version: 1,
      layout: { kind: 'leaf', id: 'cell-0' },
      cells: [{ id: 'cell-0', kind: 'scatter', colorBy: 'group' }],
    }
    const opt = migrateOption(spec)
    expect(opt.version).toBe(VIZ_OPTION_VERSION)
    expect(opt.grid).toEqual([{ id: 'cell-0' }])
    expect(opt.layout).toEqual({ kind: 'leaf', id: 'cell-0' })
    expect(opt.series).toEqual([{ id: 'cell-0', type: 'scatter', coordId: 'cell-0' }])
  })
})

describe('migrateOption — current VizOption arm', () => {
  it('normalizes an already-VizOption forward (fills version, coerces hidden Set → sorted number[])', () => {
    const raw = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a', region: { col: 0 } }],
      series: [
        {
          id: 's-a',
          type: 'scatter',
          coordId: 'a',
          encode: { layout: 'primary', colorBy: { mode: 'categorical', key: 'group', hidden: new Set([9, 2]) } },
        },
      ],
    }
    const opt = migrateOption(raw)
    expect(opt.version).toBe(VIZ_OPTION_VERSION)
    const hidden = (opt.series[0].encode as { colorBy: { hidden: unknown } }).colorBy.hidden
    expect(hidden).toEqual([2, 9]) // strict-JSON sorted array, not a Set
  })

  it('REFUSES a VizOption whose version is newer than this build', () => {
    expect(() =>
      migrateOption({ version: VIZ_OPTION_VERSION + 1, grid: [], series: [] }),
    ).toThrow(/newer than this build/)
  })
})

describe('migrateOption — rejection', () => {
  it('throws on a non-object', () => {
    expect(() => migrateOption(null)).toThrow(/not an option object/)
    expect(() => migrateOption(42 as never)).toThrow(/not an option object/)
  })

  it('throws on an unrecognized shape', () => {
    expect(() => migrateOption({ foo: 'bar' })).toThrow(/unrecognized shape/)
  })
})
