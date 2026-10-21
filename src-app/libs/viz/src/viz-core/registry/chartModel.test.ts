// chartModel.test.ts — each registered descriptor's `model()` resolves the expected
// default bindings from a fixture catalog (EXTENSIBILITY_STUDY Part 6 STEP 2). This is the
// contract that the per-kind binding knowledge now lives in each descriptor's own
// `bindingSchema` + `model()` (not the core's switch / the shared `defaultBindings`), and
// that an undecidable channel REFUSES rather than resolving to catalog position N or to a
// conventional column NAME (`docs/design/binding-resolution-refusal.md`).

import { describe, it, expect, vi } from 'vitest'
import type { DatasetCatalog } from '../data/wire'
import { FixtureSource } from '../data/fixtures'
import { installBuiltins } from '../charts/installBuiltins'
import type { GridCell } from '../grid/gridModel'
import { getChartType, chartTypes, registerChartType } from './registry'
import { resolveBindingChannel, bindingValue, bindingList, makeChartModel } from './model'
import type { BindingChannel, ChartTypeDescriptor } from './types'

// The descriptors resolve `cell.kind` against the registry, so install the built-ins first.
// Idempotent.
installBuiltins()

/** A cell config the descriptor's `model()` reads (only `kind` matters for bindings). */
function cell(kind: string): GridCell {
  return { id: 'c1', kind, layoutId: 'primary' }
}

/** Build a minimal catalog with the given columns overriding the empty defaults. */
function makeCatalog(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'test',
    pointCount: 100,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

const CATALOG = makeCatalog({
  categoricalColumns: [
    { id: 'group', kind: 'categorical', label: 'Group' },
    { id: 'type', kind: 'categorical', label: 'Type' },
  ],
  valueColumns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  continuousColumns: [
    { id: 'qcA', kind: 'continuous', label: 'QC A' },
    { id: 'qcB', kind: 'continuous', label: 'QC B' },
  ],
})

/** Resolve a registered kind's model against a catalog (fails loudly if unregistered). */
function modelFor(kind: string, catalog: DatasetCatalog = CATALOG) {
  const desc = getChartType(kind)
  if (!desc) throw new Error(`chart type "${kind}" is not registered`)
  return desc.model(cell(kind), { catalog })
}

// ---------------------------------------------------------------------------
// Per-kind binding schema — each descriptor owns its own channels.
// ---------------------------------------------------------------------------

describe('descriptor.model() — resolves each chart type\'s OWN binding schema', () => {
  it('violin / box bind a value column + a grouping', () => {
    for (const kind of ['violin', 'box']) {
      const m = modelFor(kind)
      expect(m.kind).toBe(kind)
      // `group` binds by ID-MATCH — the catalog HAS a `group` categorical column, which is
      // evidence, so it binds however many other categoricals exist.
      expect(bindingValue(m.bindings, 'group')).toBe('group')
      // `value` REFUSES: eight value columns qualify (A..H), none is named `value`, and
      // nothing chooses between them. It used to answer `'A'` — `valueColumns[0]` — with
      // total confidence. A refused channel is ABSENT from `bindings` (never `''`, which
      // already means "deliberately unbound").
      expect(m.resolutions.value).toEqual({
        status: 'ambiguous',
        source: 'value',
        candidates: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      })
      expect(Object.keys(m.bindings)).toEqual(['group'])
      // both declared channels are accounted for in the RESOLUTIONS — nothing leaks in.
      expect(Object.keys(m.resolutions).sort()).toEqual(['group', 'value'])
    }
  })

  it('bar binds ONLY a grouping', () => {
    const m = modelFor('bar')
    expect(bindingValue(m.bindings, 'group')).toBe('group')
    expect(Object.keys(m.bindings)).toEqual(['group'])
  })

  it('histogram binds a CONTINUOUS column as its value', () => {
    const m = modelFor('histogram')
    // Two continuous columns (qcA, qcB) and no channel-named match: the old code answered
    // `continuousColumns[0]` = 'qcA'. That is the one-way violin->histogram column swap, at
    // its source. It refuses now.
    expect(m.resolutions.value).toEqual({
      status: 'ambiguous',
      source: 'continuous',
      candidates: ['qcA', 'qcB'],
    })
    expect(Object.keys(m.bindings)).toEqual([])
    expect(Object.keys(m.resolutions)).toEqual(['value'])
  })

  it('dotplot / heatmap bind the first ≤6 value columns + a grouping', () => {
    for (const kind of ['dotplot', 'heatmap']) {
      const m = modelFor(kind)
      expect(bindingList(m.bindings, 'valueKeys')).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
      expect(bindingValue(m.bindings, 'group')).toBe('group')
      expect(Object.keys(m.bindings).sort()).toEqual(['group', 'valueKeys'])
      // A `valueList` is inherently multi-column and the cap is a RENDER BUDGET, so it binds
      // — but it REPORTS that it truncated, instead of implying six is all there is.
      expect(m.resolutions.valueKeys).toEqual({
        status: 'bound-list',
        columns: ['A', 'B', 'C', 'D', 'E', 'F'],
        total: 8,
      })
    }
  })

  it('volcano binds the fixed DE table name', () => {
    const m = modelFor('volcano')
    expect(bindingValue(m.bindings, 'table')).toBe('de')
    expect(Object.keys(m.bindings)).toEqual(['table'])
  })

  it('the dense + nested kinds (scatter / image / grid) declare NO bindings', () => {
    for (const kind of ['scatter', 'image', 'grid']) {
      const m = modelFor(kind)
      expect(m.bindings).toEqual({})
      expect(m.cell.kind).toBe(kind)
    }
  })
})

// ---------------------------------------------------------------------------
// Behaviour on catalogs the resolver cannot decide.
//
// This block used to be "byte-identical to the legacy defaultBindings", asserting that
// `model()` reproduced `gridModel.defaultBindings(catalog)` exactly. That oracle is gone
// with the duplicate it named: `defaultBindings` WAS the same four guesses at ordinal 0 in a
// second file, so "the two agree" only ever proved the guess was copied faithfully. What
// replaces it is what those cases should DO.
// ---------------------------------------------------------------------------

describe('descriptor.model() — an undecidable catalog refuses, it does not invent', () => {
  it('names no column on an EMPTY catalog — the `group` / `qcA` literals are gone', () => {
    const empty = makeCatalog()
    // Previously: violin `group` -> 'group', histogram `value` -> 'qcA'. Neither column
    // existed; both names came from the in-package fixtures' vocabulary, asserted over
    // whatever data a host actually had (INV-2).
    const violin = modelFor('violin', empty)
    expect(violin.resolutions.group).toEqual({ status: 'absent', source: 'categorical' })
    expect(violin.resolutions.value).toEqual({ status: 'absent', source: 'value' })
    expect(violin.bindings).toEqual({})

    const histogram = modelFor('histogram', empty)
    expect(histogram.resolutions.value).toEqual({ status: 'absent', source: 'continuous' })
    expect(histogram.bindings).toEqual({})

    expect(bindingList(modelFor('heatmap', empty).bindings, 'valueKeys')).toEqual([])
    // A `table` channel binds a FIXED constant, which is not a claim about the dataset's
    // columns at all — so it still binds.
    expect(bindingValue(modelFor('volcano', empty).bindings, 'table')).toBe('de')
  })

  it('binds the SOLE candidate — one column of a kind is not a choice at all', () => {
    const single = makeCatalog({
      categoricalColumns: [{ id: 'donor', kind: 'categorical', label: 'Donor' }],
      valueColumns: ['counts'],
      continuousColumns: [{ id: 'depth', kind: 'continuous', label: 'Depth' }],
    })
    const violin = modelFor('violin', single)
    expect(bindingValue(violin.bindings, 'group')).toBe('donor')
    expect(bindingValue(violin.bindings, 'value')).toBe('counts')
    expect(bindingValue(modelFor('histogram', single).bindings, 'value')).toBe('depth')
  })

  it('derives real bindings from the fixture catalog', async () => {
    const catalog = await new FixtureSource({ seed: 7, pointCount: 1000 }).catalog()
    const violin = modelFor('violin', catalog)
    const catIds = catalog.categoricalColumns.map(c => c.id)
    // ASSERT THE STATUS FIRST. Written as `if (bindingValue(...)) expect(...)` this whole test
    // passes asserting NOTHING exactly when the resolver refuses everything — which is the new
    // failure mode, so the guard has to be unconditional.
    expect(['bound', 'ambiguous', 'absent']).toContain(violin.resolutions.group.status)
    if (violin.resolutions.group.status === 'bound') {
      expect(catIds).toContain(violin.resolutions.group.column)
    }
    expect(['bound', 'ambiguous', 'absent']).toContain(violin.resolutions.value.status)
    if (violin.resolutions.value.status === 'bound') {
      expect(catalog.valueColumns).toContain(violin.resolutions.value.column)
    }
    // the matrix channel is multi-column and this fixture DOES carry value columns, so it must
    // actually bind — an unconditional assertion, not a guarded one.
    const keys = bindingList(modelFor('heatmap', catalog).bindings, 'valueKeys')
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(catalog.valueColumns).toContain(k)
  })

  it('makeChartModel honors an override per-channel and falls back for the rest', () => {
    // The render-time hook the declarative controller uses (via CellView) so a DECLARED
    // encode (`valueKeys: [...]`) wins over the catalog default while unspecified channels
    // (`group`) still fall back — the "encode reaches render" fix.
    const desc = getChartType('heatmap')
    if (!desc) throw new Error('heatmap not registered')
    const schema = desc.bindingSchema ?? []
    const dflt = makeChartModel(cell('heatmap'), schema, CATALOG).bindings
    const overridden = makeChartModel(cell('heatmap'), schema, CATALOG, {
      valueKeys: ['A', 'B'],
    }).bindings
    // override channel wins…
    expect(overridden.valueKeys).toEqual(['A', 'B'])
    // …and the catalog default (first-6 of A..H) differs, so this is a real override
    expect(dflt.valueKeys).not.toEqual(['A', 'B'])
    // …while the omitted `group` channel falls back to the catalog default
    expect(overridden.group).toEqual(dflt.group)
    // no-override path stays byte-identical
    expect(makeChartModel(cell('heatmap'), schema, CATALOG).bindings).toEqual(dflt)
  })
})

// ---------------------------------------------------------------------------
// Registry coverage + the single-channel resolver.
// ---------------------------------------------------------------------------

describe('binding-schema registry coverage', () => {
  it('every registered descriptor exposes a model() and a bindingSchema', () => {
    for (const desc of chartTypes()) {
      expect(typeof desc.model).toBe('function')
      expect(Array.isArray(desc.bindingSchema)).toBe(true)
    }
  })

  it('resolveBindingChannel answers each source with a RESOLUTION, never an invented name', () => {
    // `g` names no column; two categoricals qualify (group, type) -> ambiguous.
    const cat: BindingChannel = { id: 'g', source: 'categorical', label: 'G' }
    // …but a channel whose id IS a column binds by id-match, wherever it sits.
    const named: BindingChannel = { id: 'type', source: 'categorical', label: 'Type' }
    const val: BindingChannel = { id: 'v', source: 'value', label: 'V' }
    const list: BindingChannel = { id: 'vs', source: 'valueList', label: 'Vs' }
    const cont: BindingChannel = { id: 'c', source: 'continuous', label: 'C' }
    const tbl: BindingChannel = { id: 't', source: 'table', label: 'T', constant: 'de' }
    expect(resolveBindingChannel(cat, CATALOG)).toEqual({
      status: 'ambiguous',
      source: 'categorical',
      candidates: ['group', 'type'],
    })
    expect(resolveBindingChannel(named, CATALOG)).toEqual({ status: 'bound', column: 'type' })
    expect(resolveBindingChannel(val, CATALOG).status).toBe('ambiguous')
    expect(resolveBindingChannel(list, CATALOG)).toEqual({
      status: 'bound-list',
      columns: ['A', 'B', 'C', 'D', 'E', 'F'],
      total: 8,
    })
    expect(resolveBindingChannel(cont, CATALOG)).toEqual({
      status: 'ambiguous',
      source: 'continuous',
      candidates: ['qcA', 'qcB'],
    })
    expect(resolveBindingChannel(tbl, CATALOG)).toEqual({ status: 'bound', column: 'de' })
  })

  it('a valueList channel honors a custom limit and still reports the true total', () => {
    const list3: BindingChannel = { id: 'vs', source: 'valueList', label: 'Vs', limit: 3 }
    expect(resolveBindingChannel(list3, CATALOG)).toEqual({
      status: 'bound-list',
      columns: ['A', 'B', 'C'],
      total: 8,
    })
  })
})

// ---------------------------------------------------------------------------
// Multi-channel single-column source — the candlestick capability. Several `continuous`
// channels must resolve to DISTINCT columns, and they do it by ID-MATCH.
//
// This block used to also assert the ORDINAL rule: "binds each channel to the ORDINAL-th
// continuous column when none are like-named", with `index: 'c0', open: 'c1', high: 'c2', …`.
// That test certified the defect in its purest form — it asserted that `high` should bind
// whatever the catalog happened to list third. The ordinal is gone (see `resolveBindingChannel`);
// a channel with no id-match now refuses, and those cases are re-asserted below as refusals.
// ---------------------------------------------------------------------------

describe('resolveBindings — multiple channels of one single-column source', () => {
  // The candlestick schema: 5 `continuous` channels (index + open/high/low/close).
  const CANDLE_SCHEMA: readonly BindingChannel[] = [
    { id: 'index', source: 'continuous', label: 'Bar' },
    { id: 'open', source: 'continuous', label: 'Open' },
    { id: 'high', source: 'continuous', label: 'High' },
    { id: 'low', source: 'continuous', label: 'Low' },
    { id: 'close', source: 'continuous', label: 'Close' },
  ]

  it('binds each channel to its LIKE-NAMED continuous column (id-match)', () => {
    const ohlc = makeCatalog({
      continuousColumns: [
        { id: 'index', kind: 'continuous', label: 'Bar' },
        { id: 'open', kind: 'continuous', label: 'Open' },
        { id: 'high', kind: 'continuous', label: 'High' },
        { id: 'low', kind: 'continuous', label: 'Low' },
        { id: 'close', kind: 'continuous', label: 'Close' },
      ],
    })
    const m = makeChartModel(cell('candlestick'), CANDLE_SCHEMA, ohlc)
    expect(m.bindings).toEqual({
      index: 'index',
      open: 'open',
      high: 'high',
      low: 'low',
      close: 'close',
    })
    // all four PRICE channels are distinct — which is what the ordinal existed to achieve,
    // and the id-match achieves it from evidence instead of from list position.
    expect(new Set(['open', 'high', 'low', 'close'].map(id => m.bindings[id])).size).toBe(4)
  })

  it('REFUSES every channel when none is like-named — it does not deal out columns in order', () => {
    // The exact fixture the ordinal test used. Previously: index->c0, open->c1, high->c2,
    // low->c3, close->c4 — five confident bindings from zero evidence.
    const positional = makeCatalog({
      continuousColumns: [
        { id: 'c0', kind: 'continuous', label: 'C0' },
        { id: 'c1', kind: 'continuous', label: 'C1' },
        { id: 'c2', kind: 'continuous', label: 'C2' },
        { id: 'c3', kind: 'continuous', label: 'C3' },
        { id: 'c4', kind: 'continuous', label: 'C4' },
      ],
    })
    const m = makeChartModel(cell('candlestick'), CANDLE_SCHEMA, positional)
    expect(m.bindings).toEqual({})
    for (const id of ['index', 'open', 'high', 'low', 'close']) {
      expect(m.resolutions[id]).toEqual({
        status: 'ambiguous',
        source: 'continuous',
        candidates: ['c0', 'c1', 'c2', 'c3', 'c4'],
      })
    }
  })

  it('binds the id-matched channels and refuses only the rest', () => {
    // cols: 0:a  1:open  2:b  3:c  4:close. `open`/`close` are evidence; the other three
    // channels have no like-named column, and USED to take positions 0, 2 and 3.
    const mixed = makeCatalog({
      continuousColumns: [
        { id: 'a', kind: 'continuous', label: 'A' },
        { id: 'open', kind: 'continuous', label: 'Open' },
        { id: 'b', kind: 'continuous', label: 'B' },
        { id: 'c', kind: 'continuous', label: 'C' },
        { id: 'close', kind: 'continuous', label: 'Close' },
      ],
    })
    const m = makeChartModel(cell('candlestick'), CANDLE_SCHEMA, mixed)
    expect(m.bindings).toEqual({ open: 'open', close: 'close' })
    for (const id of ['index', 'high', 'low']) {
      expect(m.resolutions[id].status).toBe('ambiguous')
    }
  })

  it('a SOLE continuous column binds the histogram — one candidate is not a choice', () => {
    const single: readonly BindingChannel[] = [{ id: 'value', source: 'continuous', label: 'V' }]
    const one = makeCatalog({
      continuousColumns: [{ id: 'depth', kind: 'continuous', label: 'Depth' }],
    })
    expect(makeChartModel(cell('histogram'), single, one).bindings).toEqual({ value: 'depth' })
    expect(resolveBindingChannel(single[0], one)).toEqual({ status: 'bound', column: 'depth' })
    // …and with TWO it refuses rather than taking the first.
    expect(resolveBindingChannel(single[0], CATALOG).status).toBe('ambiguous')
  })
})

// ---------------------------------------------------------------------------
// registerChartType — warn-and-replace / last-wins on a duplicate type id.
// ---------------------------------------------------------------------------

describe('registerChartType — re-registering the same type warns and replaces', () => {
  /** A minimal descriptor whose only distinguishing trait is object identity. */
  function makeDesc(type: string): ChartTypeDescriptor {
    return {
      type,
      coordinateSystem: 'chart2d',
      view: (() => null) as unknown as ChartTypeDescriptor['view'],
      model: (c: GridCell) => ({ kind: c.kind, bindings: {}, resolutions: {}, cell: c }),
    }
  }

  it('emits console.warn and last registration wins (getChartType returns the second)', () => {
    // A unique type id so the FIRST registration is a genuine first (no warn) and this
    // test never disturbs a real built-in descriptor.
    const type = 'tc-warn-replace-fixture'
    const first = makeDesc(type)
    const second = makeDesc(type)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerChartType(first)
      expect(warn).not.toHaveBeenCalled() // first-ever registration: no warn
      expect(getChartType(type)).toBe(first)

      registerChartType(second) // duplicate id → warn + replace
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"${type}"`))
      // last-wins: the SECOND descriptor is what resolves now.
      expect(getChartType(type)).toBe(second)
      expect(getChartType(type)).not.toBe(first)
    } finally {
      warn.mockRestore()
    }
  })
})
