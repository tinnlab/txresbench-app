// bindingRefusal.test.ts — the CLASS proof for the first-of-N binding family.
//
// TEST-1 / TEST-2 / TEST-4 / TEST-6 / TEST-19.
//
// ── WHY THIS FILE IS DERIVED AND NOT A LIST ─────────────────────────────────────────────
//
// The family had ~34 sites in this layer, and four of them had already produced visible,
// owner-reported defects. Each was fixed at its own instance and the PREDICATE that produced
// all four was left intact — which is the shape of the problem: a test per site is N tests
// that each let the N+1th through.
//
// So the enumeration here comes from the REGISTRY, not from a hand-written list of chart
// types: `chartTypes()` × each type's own `bindingSchema`. A chart type registered tomorrow
// is inside this test's subject on the day it is registered, with no edit here. To prove that
// is not merely an aspiration, the suite REGISTERS ITS OWN chart type — one nobody had
// written when the resolver was fixed — and requires it to obey the same rule.
//
// The invariants under proof (`docs/design/binding-resolution-refusal.md`):
//   INV-1  a resolver may not take [0]
//   INV-2  a resolver may not name a column the data did not
//   INV-4  `''` (deliberately unbound) and "could not decide" are DIFFERENT answers

import { describe, it, expect } from 'vitest'
import type { DatasetCatalog } from '../data/wire'
import { installBuiltins } from '../charts/installBuiltins'
import type { GridCell } from '../grid/gridModel'
import { chartTypes, getChartType, registerChartType } from './registry'
import { makeChartModel, resolveBindingChannel, resolveBindings, bindingsOf } from './model'
import type { BindingChannel, BindingSource, ChartTypeDescriptor } from './types'

installBuiltins()

function cell(kind: string): GridCell {
  return { id: 'c1', kind, layoutId: 'primary' }
}

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

/**
 * A catalog that is AMBIGUOUS for every source at once: ≥2 candidates of each kind, and not
 * one of them named after any channel any chart declares (the ids are deliberately opaque, so
 * an id-match cannot rescue a chart and mask a positional pick).
 */
const AMBIGUOUS = makeCatalog({
  categoricalColumns: [
    { id: 'zz_cat_alpha', kind: 'categorical', label: 'A' },
    { id: 'zz_cat_beta', kind: 'categorical', label: 'B' },
    { id: 'zz_cat_gamma', kind: 'categorical', label: 'C' },
  ],
  valueColumns: ['zz_val_alpha', 'zz_val_beta', 'zz_val_gamma'],
  continuousColumns: [
    { id: 'zz_cont_alpha', kind: 'continuous', label: 'A' },
    { id: 'zz_cont_beta', kind: 'continuous', label: 'B' },
    { id: 'zz_cont_gamma', kind: 'continuous', label: 'C' },
  ],
})

/** Every column id the catalog carries — what INV-2 says a resolution may never step outside. */
function catalogColumnIds(c: DatasetCatalog): Set<string> {
  return new Set([
    ...c.categoricalColumns.map(x => x.id),
    ...c.valueColumns,
    ...c.continuousColumns.map(x => x.id),
  ])
}

/**
 * A chart type NOBODY had written when the resolver was fixed. Registered here so the derived
 * enumeration below has to cover it — this is the difference between a class proof and ten
 * site proofs, and without it "derived from the registry" is a claim rather than a property.
 */
const FUTURE_SCHEMA: readonly BindingChannel[] = [
  { id: 'someFutureCategory', source: 'categorical', label: 'Future category' },
  { id: 'someFutureValue', source: 'value', label: 'Future value' },
  { id: 'someFutureMeasure', source: 'continuous', label: 'Future measure' },
  { id: 'someFutureList', source: 'valueList', label: 'Future list' },
]
const FUTURE_TYPE = 'zz-future-chart-nobody-wrote'
registerChartType({
  type: FUTURE_TYPE,
  coordinateSystem: 'chart2d',
  bindingSchema: FUTURE_SCHEMA,
  model: (c, ctx) => makeChartModel(c, FUTURE_SCHEMA, ctx.catalog),
  view: (() => null) as unknown as ChartTypeDescriptor['view'],
} as ChartTypeDescriptor)

describe('TEST-1 [acceptance][INV-1] — no registered chart binds a channel it cannot decide', () => {
  it('includes the type registered by this test — the enumeration is derived, not listed', () => {
    expect(chartTypes().map(d => d.type)).toContain(FUTURE_TYPE)
    // and it is not a lone straggler: the built-ins are in the same subject
    expect(chartTypes().length).toBeGreaterThan(5)
  })

  it('every registered type × every declared channel refuses on an ambiguous catalog', () => {
    let checkedSingleColumnChannels = 0
    for (const desc of chartTypes()) {
      const schema = desc.bindingSchema ?? []
      const resolutions = resolveBindings(schema, AMBIGUOUS)
      for (const ch of schema) {
        const r = resolutions[ch.id]
        expect(r, `${desc.type}.${ch.id} produced no resolution`).toBeDefined()
        if (ch.source === 'table') {
          // A `table` channel binds a FIXED constant — not a dataset column, so not a claim
          // about the data. Excluded by KIND, never by naming a chart.
          continue
        }
        if (ch.source === 'valueList') {
          // Inherently multi-column: it binds the whole (capped) set, which asserts nothing
          // about WHICH one — but it must report the true total rather than implying the cap.
          expect(r.status, `${desc.type}.${ch.id}`).toBe('bound-list')
          if (r.status === 'bound-list') expect(r.total).toBe(AMBIGUOUS.valueColumns.length)
          continue
        }
        checkedSingleColumnChannels++
        // THE INVARIANT. Three candidates qualify and nothing chooses between them, so the
        // channel identifies none of them. It used to answer position 0 (or, on a miss, a
        // literal) with total confidence.
        expect(r.status, `${desc.type}.${ch.id} bound a column it could not decide`).not.toBe(
          'bound',
        )
        expect(r.status).toBe('ambiguous')
      }
    }
    // A guard on the guard: if the schemas ever stopped declaring single-column channels this
    // test would pass by checking nothing at all.
    expect(checkedSingleColumnChannels).toBeGreaterThan(5)
  })

  it('binds the SOLE candidate — one option is not a choice (the correct minority)', () => {
    const single = makeCatalog({
      categoricalColumns: [{ id: 'only_cat', kind: 'categorical', label: 'C' }],
      valueColumns: ['only_val'],
      continuousColumns: [{ id: 'only_cont', kind: 'continuous', label: 'M' }],
    })
    // The negative control for the test above: with the SAME schemas and a catalog that CAN
    // decide, every one of those channels binds. Without this leg, "never bound" would also
    // pass on a resolver that refuses unconditionally — which would be a different defect
    // wearing this fix's clothes.
    let bound = 0
    for (const desc of chartTypes()) {
      for (const ch of desc.bindingSchema ?? []) {
        if (ch.source === 'table' || ch.source === 'valueList') continue
        const r = resolveBindingChannel(ch, single)
        expect(r.status, `${desc.type}.${ch.id} refused a sole candidate`).toBe('bound')
        bound++
      }
    }
    expect(bound).toBeGreaterThan(5)
  })
})

describe('TEST-2 [acceptance][INV-2] — a resolution never names a column the catalog lacks', () => {
  for (const [name, catalog] of [
    ['an EMPTY catalog', makeCatalog()],
    ['an ambiguous catalog', AMBIGUOUS],
    [
      'a catalog of unrelated ids',
      makeCatalog({
        categoricalColumns: [{ id: 'q1', kind: 'categorical', label: 'q1' }],
        valueColumns: ['q2'],
        continuousColumns: [{ id: 'q3', kind: 'continuous', label: 'q3' }],
      }),
    ],
  ] as const) {
    it(`names only real columns against ${name}`, () => {
      const ids = catalogColumnIds(catalog)
      for (const desc of chartTypes()) {
        const schema = desc.bindingSchema ?? []
        const bindings = bindingsOf(resolveBindings(schema, catalog))
        for (const ch of schema) {
          if (ch.source === 'table') continue // a fixed constant, not a dataset column
          const v = bindings[ch.id]
          if (v === undefined || v === '') continue
          for (const col of Array.isArray(v) ? v : [v as string]) {
            expect(ids, `${desc.type}.${ch.id} named "${col}", which is not in the catalog`).toContain(
              col,
            )
          }
        }
      }
    })
  }

  it('never produces a conventional column literal, on any catalog that lacks it', () => {
    // The names the family invented, taken from the in-package fixtures' vocabulary and
    // asserted over whatever data a host actually had. Checked against BEHAVIOUR, not bytes: a
    // literal that is never reachable is not a defect, and a reachable one shows up as a
    // resolution naming it.
    //
    // Driven over THREE catalogs, not just the empty one. On an empty catalog every channel is
    // `absent`, so `bindings[ch.id]` is `undefined` and the assertion degenerates to
    // "undefined is not one of these five strings" — true of any implementation, including the
    // guessing one. The populated catalogs are what make it discriminating: they are exactly
    // the shape where the old code REACHED for the literal.
    const forbidden = ['group', 'qcA', 'primary', 'effect', 'signif']
    const catalogs = [
      makeCatalog(),
      AMBIGUOUS,
      // one candidate per kind, none of them named like the literals — the sole-candidate path
      makeCatalog({
        categoricalColumns: [{ id: 'zz_only_cat', kind: 'categorical', label: 'C' }],
        valueColumns: ['zz_only_val'],
        continuousColumns: [{ id: 'zz_only_cont', kind: 'continuous', label: 'M' }],
      }),
    ]
    let asserted = 0
    for (const catalog of catalogs) {
      for (const desc of chartTypes()) {
        const schema = desc.bindingSchema ?? []
        const bindings = bindingsOf(resolveBindings(schema, catalog))
        for (const ch of schema) {
          if (ch.source === 'table') continue
          const v = bindings[ch.id]
          for (const col of v === undefined ? [] : Array.isArray(v) ? v : [v as string]) {
            asserted++
            expect(forbidden, `${desc.type}.${ch.id} invented "${col}"`).not.toContain(col)
          }
        }
      }
    }
    // …and the assertion ran on REAL bound values, not only on absences.
    expect(asserted).toBeGreaterThan(5)
  })
})

describe('TEST-4 [acceptance][INV-4] — `unbound` and `ambiguous` stay two different answers', () => {
  const CH_ID = ''
  it('an EXPLICITLY EMPTY channel is `unbound` and survives to bindings as `""`', () => {
    // `''` is viz's in-band "bind no column". Deleting it is the bug behind *"the violin
    // shows many groups before I choose anything"*: an ABSENT channel gets refilled from the
    // catalog, so "explicitly unset" and "never mentioned" must not be the same wire shape.
    const r = resolveBindingChannel({ id: CH_ID, source: 'categorical', label: 'G' }, AMBIGUOUS)
    expect(r).toEqual({ status: 'unbound' })
    expect(bindingsOf({ g: r })).toEqual({ g: '' })
  })

  it('an UNDECIDABLE channel is `ambiguous` and is ABSENT from bindings — not `""`', () => {
    const r = resolveBindingChannel({ id: 'g', source: 'categorical', label: 'G' }, AMBIGUOUS)
    expect(r.status).toBe('ambiguous')
    // NOT `{ g: '' }`. Spelling a refusal with the token that already means "deliberately
    // nothing" is exactly the collapse INV-4 forbids — and it is the shorter thing to write.
    expect(bindingsOf({ g: r })).toEqual({})
  })

  it('the two produce DIFFERENT bindings shapes (the discrimination, stated as one assertion)', () => {
    const unbound = resolveBindingChannel({ id: '', source: 'value', label: 'V' }, AMBIGUOUS)
    const ambiguous = resolveBindingChannel({ id: 'v', source: 'value', label: 'V' }, AMBIGUOUS)
    expect(Object.keys(bindingsOf({ x: unbound }))).toEqual(['x'])
    expect(Object.keys(bindingsOf({ x: ambiguous }))).toEqual([])
    // If a future change made `ambiguous` also emit `''`, the two key-sets would match and
    // this line is what goes red.
    expect(Object.keys(bindingsOf({ x: unbound }))).not.toEqual(
      Object.keys(bindingsOf({ x: ambiguous })),
    )
  })

  it('`absent` is not `unbound` either — silence about a missing kind is not a decision', () => {
    const r = resolveBindingChannel({ id: 'v', source: 'value', label: 'V' }, makeCatalog())
    expect(r).toEqual({ status: 'absent', source: 'value' })
    expect(bindingsOf({ v: r })).toEqual({})
  })
})

describe('TEST-6 — the four arms of the single-column rule, individually', () => {
  const cat = makeCatalog({
    categoricalColumns: [
      { id: 'first', kind: 'categorical', label: 'F' },
      { id: 'wanted', kind: 'categorical', label: 'W' },
    ],
  })

  it('id-match binds even when the column is NOT first', () => {
    expect(resolveBindingChannel({ id: 'wanted', source: 'categorical', label: 'W' }, cat)).toEqual({
      status: 'bound',
      column: 'wanted',
    })
  })

  it('the sole candidate binds', () => {
    const one = makeCatalog({
      categoricalColumns: [{ id: 'donor', kind: 'categorical', label: 'D' }],
    })
    expect(resolveBindingChannel({ id: 'x', source: 'categorical', label: 'X' }, one)).toEqual({
      status: 'bound',
      column: 'donor',
    })
  })

  it('two candidates with no id-match are `ambiguous`, carrying BOTH ids', () => {
    expect(resolveBindingChannel({ id: 'x', source: 'categorical', label: 'X' }, cat)).toEqual({
      status: 'ambiguous',
      source: 'categorical',
      candidates: ['first', 'wanted'],
    })
  })

  it('zero candidates are `absent`, carrying the source', () => {
    for (const source of ['categorical', 'continuous', 'value'] as BindingSource[]) {
      expect(resolveBindingChannel({ id: 'x', source, label: 'X' }, makeCatalog())).toEqual({
        status: 'absent',
        source,
      })
    }
  })
})

describe('TEST-19 — the reported defects, at the predicate that produced them', () => {
  it('defect 3: a ONE-WAY violin→histogram switch no longer re-picks continuousColumns[0]', () => {
    // Reported live: plot `pct_mito` (a percentage), switch violin → histogram, and the axis
    // reads 0-50K — a DIFFERENT column, with total confidence. The round trip was made
    // lossless by a per-vocabulary memo; the ONE-WAY hop still landed on `continuousColumns[0]`,
    // and `GridWorkspace.store.ts` records that as a KNOWN RESIDUAL naming the render path —
    // this resolver — as "the honest home for it".
    const catalog = makeCatalog({
      valueColumns: ['pct_mito', 'n_counts'],
      continuousColumns: [
        { id: 'n_counts', kind: 'continuous', label: 'Counts' }, // the 0-50K column, FIRST
        { id: 'pct_mito', kind: 'continuous', label: 'Percent mito' },
      ],
    })
    const histogramSchema = getChartType('histogram')?.bindingSchema ?? []
    expect(histogramSchema.length).toBeGreaterThan(0)
    const m = makeChartModel(cell('histogram'), histogramSchema, catalog)
    // Pre-fix this was `{ value: 'n_counts' }` — the first continuous column, silently.
    expect(Object.values(m.bindings)).not.toContain('n_counts')
    expect(m.bindings).toEqual({})
    expect(m.resolutions.value.status).toBe('ambiguous')
    // …and the user's actual pick still binds, because a declaration is evidence.
    const carried = makeChartModel(cell('histogram'), histogramSchema, catalog, {
      value: 'pct_mito',
    })
    expect(carried.bindings.value).toBe('pct_mito')
  })

  it('defect 4: an ABSENT grouping channel is not refilled from the catalog', () => {
    // The synthetic "All"/first-column grouping: an absent channel is how a series says
    // "never mentioned", and the resolver used to answer that by picking one.
    const catalog = makeCatalog({
      categoricalColumns: [
        { id: 'ident', kind: 'categorical', label: 'Ident' },
        { id: 'donor', kind: 'categorical', label: 'Donor' },
      ],
      valueColumns: ['pct_mito'],
    })
    const violinSchema = getChartType('violin')?.bindingSchema ?? []
    const m = makeChartModel(cell('violin'), violinSchema, catalog)
    // Pre-fix: `group: 'ident'` — two violins where one belongs.
    expect(m.bindings.group).toBeUndefined()
    expect(m.resolutions.group).toEqual({
      status: 'ambiguous',
      source: 'categorical',
      candidates: ['ident', 'donor'],
    })
    // The sole value column still binds — the fix does not make everything refuse.
    expect(m.bindings.value).toBe('pct_mito')
  })

  it('defect 2 (the identifier bind), at the resolver: catalog ORDER never decides', () => {
    // The same three categorical columns, declared in two different orders. Whatever the
    // resolver answers, it must answer the SAME thing — which is only possible if it is not
    // reading position. (The canvas-side half of this defect is TEST-11.)
    const a = makeCatalog({
      categoricalColumns: [
        { id: 'ensembl_id', kind: 'categorical', label: 'E' },
        { id: 'donor', kind: 'categorical', label: 'D' },
      ],
    })
    const b = makeCatalog({
      categoricalColumns: [
        { id: 'donor', kind: 'categorical', label: 'D' },
        { id: 'ensembl_id', kind: 'categorical', label: 'E' },
      ],
    })
    const ch: BindingChannel = { id: 'group', source: 'categorical', label: 'Group' }
    const ra = resolveBindingChannel(ch, a)
    const rb = resolveBindingChannel(ch, b)
    expect(ra.status).toBe('ambiguous')
    // Pre-fix these differed: `ensembl_id` vs `donor`, decided purely by declaration order.
    expect(new Set(ra.status === 'ambiguous' ? ra.candidates : [])).toEqual(
      new Set(rb.status === 'ambiguous' ? rb.candidates : []),
    )
    expect(ra.status).toBe(rb.status)
  })

  it('a truncated valueList REPORTS the truncation instead of implying the cap is the set', () => {
    const many = makeCatalog({
      valueColumns: Array.from({ length: 40 }, (_, i) => `v${i}`),
    })
    const r = resolveBindingChannel({ id: 'vs', source: 'valueList', label: 'Vs' }, many)
    expect(r).toEqual({
      status: 'bound-list',
      columns: Array.from({ length: 6 }, (_, i) => `v${i}`),
      total: 40,
    })
  })
})
