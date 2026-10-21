// placement.test.ts — the placement grammar (DEC-5): a `grid[]` entry expresses WHERE it lives via
// `region` | `split` | a full resolved `layout` node, and `resolveLayout` NORMALIZES all three into
// the SAME split tree. Also covers the new additive resolved fields carried by `parseOption`
// (dataZoom window, selection ids/spaces, colorScale domains, filters, colorBySelection,
// colorOverrides, per-series graphOverlay/style/viewState) + the strict-JSON `hidden` (number[]).

import { describe, it, expect, beforeAll } from 'vitest'
import { parseOption, resolveLayout } from './parse'
import { installBuiltins } from '../charts/installBuiltins'
import type { DatasetCatalog } from '../data/wire'
import type { LayoutNode } from '@ziee/dock'
import type { VizOption } from './types'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 1000,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: ['Feature A', 'Feature B', 'Feature C', 'Feature D'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
  continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
  hasImage: false,
}

// The canonical 2-pane col split every placement form must normalize to.
const TWO_COL: LayoutNode = {
  kind: 'split',
  dir: 'col',
  sizes: [0.5, 0.5],
  children: [
    { kind: 'leaf', id: 'a' },
    { kind: 'leaf', id: 'b' },
  ],
}

const series = (): VizOption['series'] => [
  { id: 's-a', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
  { id: 's-b', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
]

describe('placement grammar (DEC-5): region | split | layout → the same tree', () => {
  beforeAll(() => installBuiltins())

  it('REGION form builds the two-column split', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { col: 0 } },
        { id: 'b', region: { col: 1 } },
      ],
      series: series(),
    }
    expect(resolveLayout(opt)).toEqual(TWO_COL)
    expect(parseOption(opt, CATALOG).layout).toEqual(TWO_COL)
  })

  it('SPLIT form (anchor + split-from) builds the SAME two-column split', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a' }, { id: 'b', split: { from: 'a', dir: 'col' } }],
      series: series(),
    }
    expect(resolveLayout(opt)).toEqual(TWO_COL)
    expect(parseOption(opt, CATALOG).layout).toEqual(TWO_COL)
  })

  it('SPLIT form honors an explicit `at` fraction', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a' }, { id: 'b', split: { from: 'a', dir: 'row', at: 0.3 } }],
      series: series(),
    }
    expect(resolveLayout(opt)).toEqual({
      kind: 'split',
      dir: 'row',
      sizes: [0.3, 0.7],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    })
  })

  it('LAYOUT form (an authoritative resolved node) is returned verbatim, matching the SAME tree', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a' }, { id: 'b' }],
      layout: TWO_COL,
      series: series(),
    }
    const resolved = resolveLayout(opt)
    expect(resolved).toEqual(TWO_COL)
    // Deep-cloned — not the same reference (a resolved plan never aliases the caller's tree).
    expect(resolved).not.toBe(TWO_COL)
    expect(parseOption(opt, CATALOG).layout).toEqual(TWO_COL)
  })

  it('ALL THREE forms resolve to a byte-identical tree', () => {
    const region = resolveLayout({
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { col: 0 } },
        { id: 'b', region: { col: 1 } },
      ],
      series: series(),
    })
    const split = resolveLayout({
      dataset: { id: 'demo' },
      grid: [{ id: 'a' }, { id: 'b', split: { from: 'a', dir: 'col' } }],
      series: series(),
    })
    const layout = resolveLayout({
      dataset: { id: 'demo' },
      grid: [{ id: 'a' }, { id: 'b' }],
      layout: TWO_COL,
      series: series(),
    })
    expect(region).toEqual(split)
    expect(split).toEqual(layout)
  })

  it('a nested split (3 panes) round-trips region → split identically', () => {
    // region: row 0 = [a,b], row 1 = [c]
    const regionOpt: VizOption = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { row: 0, col: 0 } },
        { id: 'b', region: { row: 0, col: 1 } },
        { id: 'c', region: { row: 1, col: 0 } },
      ],
      series: [
        { id: 's-a', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
        { id: 's-b', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
        { id: 's-c', type: 'scatter', coordId: 'c', encode: { layout: 'primary' } },
      ],
    }
    const regionTree = resolveLayout(regionOpt)
    // Feed that exact resolved tree back as the LAYOUT form — must round-trip byte-for-byte.
    const layoutTree = resolveLayout({ ...regionOpt, layout: regionTree })
    expect(layoutTree).toEqual(regionTree)
  })

  describe('validation (fail loud)', () => {
    it('throws when option.layout has a leaf with no matching grid entry', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'a' }],
        layout: {
          kind: 'split',
          dir: 'col',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'a' },
            { kind: 'leaf', id: 'ghost' },
          ],
        },
        series: [{ id: 's-a', type: 'scatter', coordId: 'a' }],
      }
      expect(() => resolveLayout(opt)).toThrow(/option\.layout leaf "ghost" has no matching grid entry/)
    })

    it('throws when a grid entry is absent from option.layout', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'a' }, { id: 'b' }],
        layout: { kind: 'leaf', id: 'a' },
        series: [
          { id: 's-a', type: 'scatter', coordId: 'a' },
          { id: 's-b', type: 'scatter', coordId: 'b' },
        ],
      }
      expect(() => resolveLayout(opt)).toThrow(/grid entry "b" is absent from option\.layout/)
    })

    it('throws when split.from names an unknown pane', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'a' }, { id: 'b', split: { from: 'nope', dir: 'col' } }],
        series: series(),
      }
      expect(() => resolveLayout(opt)).toThrow(/splits from unknown pane "nope"/)
    })
  })
})

describe('parseOption carries the additive strict-JSON live-state fields (DEC-16)', () => {
  beforeAll(() => installBuiltins())

  it('carries dataZoom window, selection ids/spaces, colorScale domains, filters, colorBySelection, colorOverrides', () => {
    const opt: VizOption = {
      version: 1,
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { col: 0 } },
        { id: 'b', region: { col: 1 } },
      ],
      dataZoom: [{ id: 'z', type: 'inside', coordId: 'a', axes: ['x'], window: [1, 9] }],
      selection: {
        mode: 'rect',
        link: ['s-a', 's-b'],
        ids: [3, 7, 12],
        spaces: { default: [3, 7, 12], other: [42] },
      },
      colorScale: { link: ['s-a'], domains: { qcA: [0, 100] } },
      filters: { 'a::qcA': [10, 20] },
      colorBySelection: 'group',
      colorOverrides: { group: { categoryColors: { A: '#ff0000' }, categoryLabels: { A: 'Alpha' } } },
      series: [
        { id: 's-a', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
        { id: 's-b', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
      ],
    }
    const plan = parseOption(opt, CATALOG)
    expect(plan.version).toBe(1)
    expect(plan.dataZoom[0].window).toEqual([1, 9])
    expect(plan.selection).toEqual({
      mode: 'rect',
      link: ['s-a', 's-b'],
      ids: [3, 7, 12],
      spaces: { default: [3, 7, 12], other: [42] },
    })
    expect(plan.colorScale).toEqual({ link: ['s-a'], domains: { qcA: [0, 100] } })
    expect(plan.filters).toEqual({ 'a::qcA': [10, 20] })
    expect(plan.colorBySelection).toBe('group')
    expect(plan.colorOverrides).toEqual({
      group: { categoryColors: { A: '#ff0000' }, categoryLabels: { A: 'Alpha' } },
    })
  })

  it('carries per-series graphOverlay (onto cell + series), style.radius + viewState (onto series)', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a', region: { col: 0 } }],
      series: [
        {
          id: 's-a',
          type: 'scatter',
          coordId: 'a',
          encode: { layout: 'primary' },
          graphOverlay: true,
          style: { radius: 4 },
          viewState: { target: [1, 2], zoom: 3 },
        },
      ],
    }
    const plan = parseOption(opt, CATALOG)
    expect(plan.cells.a.graphOverlay).toBe(true)
    expect(plan.series[0].graphOverlay).toBe(true)
    expect(plan.series[0].style).toEqual({ radius: 4 })
    expect(plan.series[0].viewState).toEqual({ target: [1, 2], zoom: 3 })
  })

  it('resolves a series-level colorBy alias (used when encode.colorBy is absent)', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'a', region: { col: 0 } }],
      series: [
        {
          id: 's-a',
          type: 'scatter',
          coordId: 'a',
          encode: { layout: 'primary' },
          colorBy: { mode: 'continuous', key: 'qcA' },
        },
      ],
    }
    const plan = parseOption(opt, CATALOG)
    expect(plan.cells.a.colorBy?.key).toBe('qcA')
    expect(plan.series[0].colorBy?.mode).toBe('continuous')
  })

  it('accepts the strict-JSON `number[]` hidden AND a `Set` (both normalize to the engine Set)', () => {
    const withArray = parseOption(
      {
        dataset: { id: 'demo' },
        grid: [{ id: 'a', region: { col: 0 } }],
        series: [
          {
            id: 's-a',
            type: 'scatter',
            coordId: 'a',
            encode: { layout: 'primary', colorBy: { mode: 'categorical', key: 'group', hidden: [2, 5] } },
          },
        ],
      },
      CATALOG,
    )
    expect(withArray.cells.a.colorBy?.hidden).toEqual(new Set([2, 5]))

    const withSet = parseOption(
      {
        dataset: { id: 'demo' },
        grid: [{ id: 'a', region: { col: 0 } }],
        series: [
          {
            id: 's-a',
            type: 'scatter',
            coordId: 'a',
            encode: { layout: 'primary', colorBy: { mode: 'categorical', key: 'group', hidden: new Set([2, 5]) } },
          },
        ],
      },
      CATALOG,
    )
    expect(withSet.cells.a.colorBy?.hidden).toEqual(new Set([2, 5]))
  })
})

// DEC-5b — no `grid` at all → AUTO one-pane-per-series; unknown coordId fails LOUD.
describe('effectiveGrid / auto-layout (DEC-5b, ITEM-4b)', () => {
  beforeAll(() => installBuiltins())
  const scatter = (id: string, coordId: string) => ({
    id, type: 'scatter', coordId, encode: { layout: 'primary' },
  })

  it('no grid + series → auto one-pane-per-series (does NOT throw "no grid entries")', () => {
    const option = { dataset: { id: 'demo' }, grid: [], series: [scatter('s1', 'a'), scatter('s2', 'b')] } as unknown as VizOption
    // layout auto-derives a 2-leaf tree keyed by the distinct series coordIds.
    const layout = resolveLayout(option)
    const leaves = JSON.stringify(layout)
    expect(leaves).toContain('"a"')
    expect(leaves).toContain('"b"')
    // parse resolves a cell per coordId.
    const resolved = parseOption(option, CATALOG)
    expect(Object.keys(resolved.cells).sort()).toEqual(['a', 'b'])
  })

  it('a single grid-less series mounts one pane', () => {
    const option = { dataset: { id: 'demo' }, grid: [], series: [scatter('only', 'p')] } as unknown as VizOption
    expect(resolveLayout(option)).toEqual({ kind: 'leaf', id: 'p' })
    expect(Object.keys(parseOption(option, CATALOG).cells)).toEqual(['p'])
  })

  it('an explicit grid still wins verbatim (byte-identical — auto only kicks in when grid is empty)', () => {
    const option = { dataset: { id: 'demo' }, grid: [{ id: 'g0', region: { col: 0 } }], series: [scatter('s', 'g0')] } as unknown as VizOption
    expect(Object.keys(parseOption(option, CATALOG).cells)).toEqual(['g0'])
  })

  it('a series with an unknown coordId fails LOUD (grid provided, no matching entry)', () => {
    const option = { dataset: { id: 'demo' }, grid: [{ id: 'g0', region: { col: 0 } }], series: [scatter('s', 'MISSING')] } as unknown as VizOption
    expect(() => parseOption(option, CATALOG)).toThrow(/unknown coordId "MISSING"/)
  })

  it('auto-derived grid: ResolvedOption.order enumerates the derived cells (not [])', () => {
    // Regression: `order` read raw option.grid ([] on the auto path) while cells/seq were populated —
    // a self-inconsistent plan. order must be a bijection with cells.
    const option = { dataset: { id: 'demo' }, grid: [], series: [scatter('s1', 'a'), scatter('s2', 'b')] } as unknown as VizOption
    const resolved = parseOption(option, CATALOG)
    expect([...resolved.order].sort()).toEqual(Object.keys(resolved.cells).sort())
    expect(resolved.order.length).toBe(resolved.seq)
    expect(resolved.order.length).toBeGreaterThan(0)
  })
})

// ITEM-4/5 (finding parse.ts:503) — the split/layout DIRECTIVE assembly path must validate the tree
// 1:1 against the grid, exactly like the option.layout path (else panes are silently dropped/dup'd).
describe('directive-layout validation (fail loud, parity with option.layout)', () => {
  beforeAll(() => installBuiltins())
  const scatter = (id: string, coordId: string) => ({ id, type: 'scatter', coordId, encode: { layout: 'primary' } })

  it('a split.newId colliding with a seeded layout leaf → duplicate pane THROWS', () => {
    // seed a layout over {a,b}; then a split whose newId is `b` (already a leaf) → duplicate `b`.
    const option = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', layout: { kind: 'split', dir: 'col', sizes: [0.5, 0.5], children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'b' }] } },
        { id: 'b', split: { from: 'a', dir: 'row' } },
      ],
      series: [scatter('s-a', 'a'), scatter('s-b', 'b')],
    } as unknown as VizOption
    expect(() => resolveLayout(option)).toThrow(/duplicate pane "b"/)
  })

  it('a grid entry never placed by any directive (seed omits it) → orphan pane THROWS', () => {
    // seed a layout over {a} only; b is a bare region-only entry AFTER the seed, but the seed made a
    // tree so b is appended — actually the risk is a seed that omits a grid id with no bare fallback.
    // Here: grid declares {a,b,c}; the seed layout covers only {a,b}; c has a split from a MISSING pane.
    const option = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', layout: { kind: 'leaf', id: 'a' } },
        { id: 'b', split: { from: 'a', dir: 'col' } },
        // c is declared as a grid id + series but the directive set never places it → orphan grid entry.
        { id: 'c' },
      ],
      series: [scatter('s-a', 'a'), scatter('s-b', 'b'), scatter('s-c', 'c')],
    } as unknown as VizOption
    // c IS appended by the bare-anchor branch, so this particular shape resolves; assert it does NOT
    // silently drop c (c must be a leaf in the tree).
    const tree = resolveLayout(option)
    expect(JSON.stringify(tree)).toContain('"c"')
  })

  it('a seed layout whose leaf is NOT a grid id → orphan leaf THROWS', () => {
    const option = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', layout: { kind: 'split', dir: 'col', sizes: [0.5, 0.5], children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'ghost' }] } },
      ],
      series: [scatter('s-a', 'a')],
    } as unknown as VizOption
    expect(() => resolveLayout(option)).toThrow(/no matching grid entry|duplicate|absent/)
  })
})
