import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { FOR_EACH_MAX, expandForEach } from '@/modules/workbench/core/runtime/expr'
import { columns_of } from '@/modules/workbench/core/runtime/primitives'
import {
  DECLARATIVE_FIXTURES,
  DOCK_VARIANTS,
  FIXTURE_FRAME,
  FIXTURE_VARIANTS,
  FOREACH_STRESS_COUNT,
  LONG_LABEL,
  RUN_FEEDBACK_ROW_COUNT,
  RUN_FEEDBACK_RUN_COUNT,
  VARIANT_WIDTH_PX,
  allFixtureSlugs,
  fixtureSlug,
  freshFormSpec,
  malformedWidgetSpec,
  variantsOf,
} from './fixtureSpecs'
import {
  DEFAULT_REGION_PREFS,
  SIDE_REGION_WIDTH_MIN,
} from '@/modules/workbench/core/shell/regions/regionsPersistence'

// TEST-12 + TEST-18 (ITEM-11 / ITEM-13) — the gallery fixtures are DATA, and they are
// validated by the SAME `parseViewSpec` a real processor's `ui/<p>.yaml` goes through. That
// is what stops a fixture drifting into a shape the engine never actually sees (which would
// make the whole Slice-3 coverage meaningless).

describe('declarative gallery fixtures parse through the shipped validator', () => {
  for (const f of DECLARATIVE_FIXTURES) {
    it(`${f.key} parses LOUD-clean`, () => {
      const res = parseViewSpec(f.spec())
      expect(res.ok, res.ok ? '' : JSON.stringify(res.errors, null, 2)).toBe(true)
    })
  }

  it('the audit-named fixtures are all present', () => {
    expect(DECLARATIVE_FIXTURES.map(f => f.key)).toEqual([
      'loaded',
      'empty-data',
      'error-data',
      'foreach-stress',
      'long-label',
      'malformed-widget',
      'criteria-table',
      'widget-kit',
      'fresh-form',
      'run-feedback',
    ])
  })

  it('loaded / empty-data / error-data differ ONLY in what the HOST does (the F3 distinction)', () => {
    const byKey = Object.fromEntries(DECLARATIVE_FIXTURES.map(f => [f.key, f]))
    expect(byKey['loaded'].host).toBe('data')
    expect(byKey['empty-data'].host).toBe('empty')
    expect(byKey['error-data'].host).toBe('reject')
    // The three specs are BYTE-IDENTICAL apart from their id + title, so any visible
    // difference between the three surfaces is the resolved STATUS, never a different spec.
    const shape = (k: string) => {
      const spec = byKey[k].spec() as unknown as Record<string, unknown>
      const { id: _id, title: _title, ...rest } = spec
      return JSON.stringify(rest)
    }
    expect(shape('empty-data')).toBe(shape('loaded'))
    expect(shape('error-data')).toBe(shape('loaded'))
  })
})

describe('the fixtures actually exercise what they claim', () => {
  it('the stress fixture declares 50 for_each rows — under FOR_EACH_MAX (DEC-12)', () => {
    const spec = DECLARATIVE_FIXTURES.find(f => f.key === 'foreach-stress')!.spec()
    const criteria = (spec.state as Record<string, { default?: unknown[] }>).criteria.default ?? []
    expect(criteria.length).toBe(FOREACH_STRESS_COUNT)
    expect(FOREACH_STRESS_COUNT).toBe(50)
    expect(FOREACH_STRESS_COUNT).toBeLessThan(FOR_EACH_MAX)
  })

  it('the long-label fixture carries a >150-char label on a real control', () => {
    const spec = DECLARATIVE_FIXTURES.find(f => f.key === 'long-label')!.spec()
    const labels = (spec.widgets ?? []).map(w => (w as { label?: unknown }).label)
    expect(labels).toContain(LONG_LABEL)
    expect(LONG_LABEL.length).toBeGreaterThan(150)
  })

  it('the malformed fixture keeps a HEALTHY criteria row alongside the broken widget', () => {
    const spec = malformedWidgetSpec()
    const ids = (spec.widgets ?? []).map(w => (w as { id?: string }).id)
    expect(ids).toContain('criterionRow')
    expect(ids).toContain('brokenRow')
    const healthy = (spec.widgets ?? []).find(w => (w as { id?: string }).id === 'criterionRow')!
    // The healthy row must still expand, so a test can drive Add-criterion and SEE a new row
    // while the broken widget stays latched.
    expect(() =>
      expandForEach(healthy as { for_each?: string }, {
        params: {},
        state: { criteria: [{ column: 'count_a' }] },
        derived: {},
        const: {},
        data: {},
      }),
    ).not.toThrow()
  })

  it('the malformed fixture THROWS at render-time expansion (that is the degrade path)', () => {
    const spec = malformedWidgetSpec()
    const row = (spec.widgets ?? []).find(w => (w as { id?: string }).id === 'brokenRow')!
    // It parses clean (asserted above) but the clause is invalid, so the host's expansion —
    // the very first thing `WidgetHost` does — throws, and the boundary must catch it.
    expect(() =>
      expandForEach(row as { for_each?: string }, {
        params: {},
        state: { criteria: [{ column: 'count_a' }] },
        derived: {},
        const: {},
        data: {},
      }),
    ).toThrow(/invalid for_each clause/)
  })
})

describe('the criteria-table fixture measures what it claims to measure', () => {
  const fixture = DECLARATIVE_FIXTURES.find(f => f.key === 'criteria-table')!

  it('mounts at the SIDE-PANE band, read from the store that clamps it — not at typed numbers', () => {
    expect(variantsOf(fixture)).toEqual(DOCK_VARIANTS)
    expect(VARIANT_WIDTH_PX['dock-min']).toBe(SIDE_REGION_WIDTH_MIN)
    expect(VARIANT_WIDTH_PX['dock-default']).toBe(DEFAULT_REGION_PREFS.rightWidth)
    // The two frames must actually DIFFER, or "at both widths" is one measurement told twice.
    expect(VARIANT_WIDTH_PX['dock-min']).toBeLessThan(VARIANT_WIDTH_PX['dock-default']!)
  })

  it('seeds a MIXED row set — both branches of the per-row gate are drawn', () => {
    const spec = fixture.spec() as unknown as {
      state: { criteria: { default: Array<{ column: string }> } }
      derived: Record<string, unknown>
    }
    const rows = spec.state.criteria.default
    // Classify each row's column the way the RENDERER will: through `columns_of`'s keyed map
    // over the same frame the fixture binds, so the fixture cannot claim a mix its own gate
    // would not agree with.
    const control = columns_of(FIXTURE_FRAME as Record<string, readonly unknown[]>, {
      keyed: true,
    }) as Record<string, string>
    const kinds = new Set(rows.map(r => control[r.column]))
    expect(rows.length).toBeGreaterThan(1)
    expect([...kinds].sort()).toEqual(['multiselect', 'range'])
  })

  it('every seeded row picks a column the picker actually offers', () => {
    const spec = fixture.spec() as unknown as {
      state: { criteria: { default: Array<{ column: string }> } }
    }
    const offered = new Set(Object.keys(FIXTURE_FRAME))
    for (const row of spec.state.criteria.default) expect(offered.has(row.column)).toBe(true)
  })
})

describe('the run-feedback fixture stays the case it exists to be', () => {
  // Both numbers are the surface's whole premise. A fixture whose list quietly emptied, or whose
  // band quietly stopped being seeded, still RENDERS — and the Layer-A geometry it carries would
  // then measure a short form with no runs in it and report success.
  it('declares a GROWN list and runs behind it', () => {
    const f = DECLARATIVE_FIXTURES.find(x => x.key === 'run-feedback')!
    expect(f.runs).toBe(RUN_FEEDBACK_RUN_COUNT)
    expect(RUN_FEEDBACK_RUN_COUNT).toBeGreaterThan(0)
    const spec = f.spec() as unknown as { state: { rows: { default: unknown[] } } }
    expect(spec.state.rows.default).toHaveLength(RUN_FEEDBACK_ROW_COUNT)
    // Grown relative to the fixture it is derived from, which starts EMPTY — that difference is
    // the whole point, and equality would mean the derivation stopped applying.
    const fresh = freshFormSpec() as unknown as { state: { rows: { default: unknown[] } } }
    expect(RUN_FEEDBACK_ROW_COUNT).toBeGreaterThan(fresh.state.rows.default.length)
  })
})

describe('the gallery slug registry (TEST-18)', () => {
  it('enumerates every fixture × the variants IT declares, all unique + declarative-prefixed', () => {
    const slugs = allFixtureSlugs()
    const expected = DECLARATIVE_FIXTURES.reduce((n, f) => n + variantsOf(f).length, 0)
    expect(slugs.length).toBe(expected)
    expect(slugs.length).toBe(21)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(s.startsWith('declarative-')).toBe(true)
  })

  it('a fixture that declares no variants keeps the ORIGINAL narrow/wide pair', () => {
    for (const f of DECLARATIVE_FIXTURES) {
      if (f.variants) continue
      expect(variantsOf(f)).toEqual(FIXTURE_VARIANTS)
    }
  })

  it('the slug shape is stable (the Layer-A spec + the e2e address surfaces through it)', () => {
    expect(fixtureSlug('loaded', 'narrow')).toBe('declarative-loaded-narrow')
    expect(fixtureSlug('malformed-widget', 'wide')).toBe('declarative-malformed-widget-wide')
  })
})

// The runtime-health BASELINE (`src/dev/gallery/runtime-baseline.js`) hardcodes the slugs of
// the two deliberate-failure fixtures. It is a plain `.js` consumed by Node outside Vite, so
// it cannot import this registry — this test is what stops a fixture rename from silently
// de-baselining it (gate goes red for a designed failure) or, worse, leaving a baseline
// pointing at a surface that no longer exists (a real failure silently subtracted).
describe('the runtime-health baseline stays pinned to real fixture slugs', () => {
  const BASELINE = fileURLToPath(new URL('../../../../dev/gallery/runtime-baseline.js', import.meta.url))
  const src = readFileSync(BASELINE, 'utf8')
  const declared = [...src.matchAll(/'(declarative-[a-z-]+)'/g)].map(m => m[1])

  it('every baselined slug is a real, registered fixture surface', () => {
    expect(declared.length).toBeGreaterThan(0)
    for (const slug of declared) expect(allFixtureSlugs()).toContain(slug)
  })

  it('baselines exactly the two DELIBERATE-failure fixtures, both variants', () => {
    expect([...declared].sort()).toEqual([
      'declarative-error-data-narrow',
      'declarative-error-data-wide',
      'declarative-malformed-widget-narrow',
      'declarative-malformed-widget-wide',
    ])
  })

  it('never baselines an uncaught page error or an ErrorBoundary crash', () => {
    // Those are the exact signals a BROKEN WidgetErrorBoundary would emit; subtracting them
    // would blind the malformed-widget fixture to its own regression.
    expect(src).toContain("new Set(['console-error'])")
    expect(src).not.toContain("'page-error'")
  })
})
