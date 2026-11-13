/**
 * TEST-UR-2 — txrresults heatmap view model (ITEM-4; PROV-UR-4, DEC-4/5/6/7).
 *
 * The pure derivation from the engine's predictions response: `normalizeTask`
 * (the per-method task → outcome key, CONS-UR-8), `buildColumns` (the ONE
 * wire bridge; values/notes/coverage bound verbatim, `prob_source: 'none'` →
 * null), `buildAvg`/`spreadOf` (the per-patient numbers, ×100 to percentage
 * points), `viewOf` (the three sorts, the filters, the window, `averageBy`),
 * `compareReport` (the ≤-3 shared top-5 names, ≤-3 divergences, the divergent
 * count), `divergentPatients` and `sortByFirstMethod`.
 *
 * Every fixture is synthetic (patient ids `S00xx`, non-board values) — the
 * boards' example facts are never expectations (INV-5). Row values are the
 * provider's 0–1 fractions; average/spread/report numbers are percentage
 * points.
 */
import { describe, expect, it } from 'vitest'
import type { TxrPredictionsResponse } from '@/api-client/types'
import {
  COMPARE_DIFFER_CAP,
  COMPARE_SHARED_CAP,
  COMPARE_TOP_N,
  buildAvg,
  buildColumns,
  compareReport,
  divergentPatients,
  normalizeTask,
  sortByFirstMethod,
  spreadOf,
  viewOf,
} from './heatmap'
import type { TxrHeatmapColumn, TxrHeatmapRow } from '../types'
import { DIVERGENCE_PP } from './format'

/** The generated `number | null[]` / `string | null[]` array-union artifact (DRIFT-1 ITEM-2 #3). */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

/**
 * A two-method pfs run (both methods finished; one abstain per method) —
 * the default (unfiltered endpoint-tab) view is the provider-average case.
 */
function uniformPredictions(): TxrPredictionsResponse {
  return {
    run_id: 'run-uniform',
    endpoint: 'pfs',
    horizon: 90,
    generated_at: '2026-11-05T00:00:00Z',
    patients: ['S0001', 'S0002', 'S0003', 'S0004', 'S0005', 'S0006', 'S0007'],
    methods: [
      {
        method_id: 'landmark-cox-current',
        label: 'landmark-cox-current',
        group: 'dynamic_risk',
        group_label: 'Dynamic risk',
        task: 'pfs',
        prob_source: 'native',
        coverage: { scored: 7, eligible: 7, fraction: 1 },
        probabilities: wireArray<number>([0.9, 0.7, 0.55, 0.4, null, 0.2, 0.1]),
        notes: wireArray<string>([null, null, null, null, 'sparse draws', null, null]),
      },
      {
        method_id: 'cox-cutpoint-risk',
        label: 'cox-cutpoint-risk',
        group: 'static_risk',
        group_label: 'Static risk',
        task: 'pfs',
        prob_source: 'recalibrated',
        coverage: { scored: 6, eligible: 7, fraction: 0.857 },
        probabilities: wireArray<number>([0.3, 0.5, 0.75, 0.6, 0.45, null, 0.8]),
        notes: wireArray<string>([null, null, null, null, null, 'not assayed', null]),
      },
    ],
    average: wireArray<number>([0.6, 0.6, 0.65, 0.5, 0.45, 0.2, 0.45]),
  }
}

/**
 * The same run plus a response method (a mixed run): the endpoint tab then
 * excludes a column, so even the "default" view recomputes the Average.
 */
function mixedPredictions(): TxrPredictionsResponse {
  const base = uniformPredictions()
  return {
    ...base,
    run_id: 'run-mixed',
    methods: [
      ...base.methods,
      {
        method_id: 'responder-rule',
        label: 'responder-rule',
        group: 'response_risk',
        group_label: 'Response risk',
        task: 'response',
        prob_source: 'none',
        coverage: { scored: 7, eligible: 7, fraction: 1 },
        probabilities: wireArray<number>([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
        notes: wireArray<string>([null, null, null, null, null, null, null]),
      },
    ],
    average: wireArray<number>([0.5666666667, 0.5666666667, 0.6, 0.5, 0.475, 0.35, 0.4666666667]),
  }
}

/** The minimal column for the direct-row report tests (only ids matter there). */
function columnOf(methodId: string): TxrHeatmapColumn {
  return {
    methodId,
    label: methodId,
    group: 'g',
    groupLabel: 'G',
    task: 'pfs',
    probSource: 'native',
    coverage: { scored: 7, eligible: 7, fraction: 1 },
    values: [],
    notes: [],
    constantValue: null,
    flatConversion: false,
  }
}

function rowOf(patientId: string, cells: Array<number | null>, average: number | null): TxrHeatmapRow {
  return {
    patientId,
    cells,
    notes: cells.map(() => null),
    average,
    spread: spreadOf({ patientId, cells, average, spread: null, notes: [] }),
  }
}

describe('normalizeTask (the per-method task → outcome key, DEC-4)', () => {
  it('passes the three generated keys through', () => {
    expect(normalizeTask('pfs', 'pfs')).toBe('pfs')
    expect(normalizeTask('os', 'pfs')).toBe('os')
    expect(normalizeTask('response', 'pfs')).toBe('response')
  })

  it('maps the catalogue/engine aliases (progression-family → pfs)', () => {
    expect(normalizeTask('progression', 'os')).toBe('pfs')
    expect(normalizeTask('progression_or_death', 'os')).toBe('pfs')
  })

  it('maps the death-family aliases → os', () => {
    expect(normalizeTask('death', 'pfs')).toBe('os')
    expect(normalizeTask('death_only', 'pfs')).toBe('os')
  })

  it('maps the response-family aliases → response', () => {
    expect(normalizeTask('no_response', 'os')).toBe('response')
    expect(normalizeTask('responder', 'os')).toBe('response')
    expect(normalizeTask('p_fail', 'os')).toBe('response')
  })

  it('falls back to the run endpoint for null, undefined, empty or unknown tasks', () => {
    expect(normalizeTask(null, 'pfs')).toBe('pfs')
    expect(normalizeTask(undefined, 'os')).toBe('os')
    expect(normalizeTask('', 'pfs')).toBe('pfs')
    expect(normalizeTask('   ', 'os')).toBe('os')
    expect(normalizeTask('some_future_task', 'pfs')).toBe('pfs')
  })

  it('normalizes case and whitespace before the map', () => {
    expect(normalizeTask(' PFS ', 'os')).toBe('pfs')
    expect(normalizeTask('Death', 'pfs')).toBe('os')
  })
})

describe('buildColumns (the one wire bridge, PROV-UR-4)', () => {
  it('maps one column per provider row and drops nothing, preserving order', () => {
    const cols = buildColumns(uniformPredictions(), 'pfs')
    expect(cols.map(c => c.methodId)).toEqual(['landmark-cox-current', 'cox-cutpoint-risk'])
    expect(cols.length).toBe(2)
  })

  it('binds the header facts verbatim (label = the wire label, group, task)', () => {
    const [a, b] = buildColumns(uniformPredictions(), 'pfs')
    expect(a).toMatchObject({
      methodId: 'landmark-cox-current',
      label: 'landmark-cox-current',
      group: 'dynamic_risk',
      groupLabel: 'Dynamic risk',
      task: 'pfs',
      probSource: 'native',
      coverage: { scored: 7, eligible: 7, fraction: 1 },
    })
    expect(b.probSource).toBe('recalibrated')
  })

  it('heads a column with the provider label — a reuse run\u2019s saved-model name (RES-05)', () => {
    const p = uniformPredictions()
    const cols = buildColumns(
      {
        ...p,
        methods: [
          { ...p.methods[0], method_id: '57519b29-fc69-4797-b38f-5822ae9dea91', label: 'cfmedip-ctdna-clearance-three-group' },
          p.methods[1],
        ],
      },
      'pfs',
    )
    expect(cols[0].methodId).toBe('57519b29-fc69-4797-b38f-5822ae9dea91')
    expect(cols[0].label).toBe('cfmedip-ctdna-clearance-three-group')
    // The uuid-shaped method id never leaks into a column header.
    expect(cols[0].label).not.toContain('57519b29')
  })

  it('flags a column that gives every patient the same value (RES-03)', () => {
    const cols = buildColumns(mixedPredictions(), 'pfs')
    // responder-rule is constant 0.5; the two varied columns are not.
    expect(cols[2].constantValue).toBe(0.5)
    expect(cols[0].constantValue).toBeNull()
    expect(cols[1].constantValue).toBeNull()
  })

  it('flags an all-zero column as the 0 constant for every scored patient', () => {
    const p = uniformPredictions()
    const cols = buildColumns(
      {
        ...p,
        methods: [
          { ...p.methods[0], probabilities: wireArray([0, 0, 0, null, 0, 0, 0]) },
          p.methods[1],
        ],
      },
      'pfs',
    )
    expect(cols[0].constantValue).toBe(0)
    // A column with NO value at all is not a constant (nothing was scored).
    const empty = buildColumns(
      { ...p, methods: [{ ...p.methods[0], probabilities: wireArray<number>([null, null]) }] },
      'pfs',
    )
    expect(empty[0].constantValue).toBeNull()
  })

  it('binds probabilities and notes verbatim (0–1 fractions, abstain + aligned note)', () => {
    const [a] = buildColumns(uniformPredictions(), 'pfs')
    expect(a.values).toEqual([0.9, 0.7, 0.55, 0.4, null, 0.2, 0.1])
    expect(a.notes).toEqual([null, null, null, null, 'sparse draws', null, null])
  })

  it("maps prob_source 'none' to null (the never-mixed-silently provenance, INV-3)", () => {
    const cols = buildColumns(mixedPredictions(), 'pfs')
    const c = cols[2]
    expect(c.probSource).toBeNull()
  })

  it("carries 'converted' and the engine's flat-conversion fact (absent = not flat)", () => {
    const p = uniformPredictions()
    p.methods[1] = { ...p.methods[1], prob_source: 'converted', flat_conversion: true }
    const [a, b] = buildColumns(p, 'pfs')
    expect(b.probSource).toBe('converted')
    expect(b.flatConversion).toBe(true)
    // An older response without the field: not flat.
    expect(a.flatConversion).toBe(false)
  })

  it('normalizes a null task through the run endpoint fallback', () => {
    const p = uniformPredictions()
    const cols = buildColumns(
      {
        ...p,
        methods: [
          { ...p.methods[0], task: null as unknown as 'pfs' },
          { ...p.methods[1], task: 'death' as unknown as 'pfs' },
        ],
      },
      'pfs',
    )
    expect(cols[0].task).toBe('pfs')
    expect(cols[1].task).toBe('os')
  })
})

describe('buildAvg (the per-patient Average, DEC-5)', () => {
  const cols = buildColumns(uniformPredictions(), 'pfs')

  it('is the mean of the non-null cells × 100, rounded to a whole point', () => {
    expect(buildAvg({ patientId: 'S0001', cells: [0.9, 0.3], average: null, spread: null, notes: [] }, cols)).toBe(60)
    expect(buildAvg({ patientId: 'S0005', cells: [null, 0.45], average: null, spread: null, notes: [] }, cols)).toBe(45)
  })

  it('excludes abstains (a null value never drags the average down) and rounds up at the half', () => {
    expect(buildAvg({ patientId: 'S01', cells: [0.333, 0.334], average: null, spread: null, notes: [] }, cols)).toBe(33)
    expect(buildAvg({ patientId: 'S01', cells: [0.335], average: null, spread: null, notes: [] }, cols)).toBe(34)
    expect(buildAvg({ patientId: 'S01', cells: [0.9, null], average: null, spread: null, notes: [] }, cols)).toBe(90)
  })

  it('returns null when nothing is visible (the row renders empty, never 0%)', () => {
    expect(buildAvg({ patientId: 'S01', cells: [null, null], average: null, spread: null, notes: [] }, cols)).toBeNull()
    expect(buildAvg({ patientId: 'S01', cells: [], average: null, spread: null, notes: [] }, cols)).toBeNull()
  })

  it('treats `cols` as the alignment authority (values outside the view are not averaged)', () => {
    const row = { patientId: 'S01', cells: [0.5, 0.9, 0.2], average: null, spread: null, notes: [] }
    expect(buildAvg(row, cols)).toBe(70) // mean of [0.5, 0.9] — the third value is outside the view
  })
})

describe('spreadOf (the disagreement spread, DEC-6)', () => {
  it('is max − min of the non-null cells × 100 (percentage points)', () => {
    expect(spreadOf({ patientId: 'S01', cells: [0.75, 0.25], average: null, spread: null, notes: [] })).toBe(50)
    expect(spreadOf({ patientId: 'S01', cells: [0.1, 0.8, 0.4], average: null, spread: null, notes: [] })).toBeCloseTo(70, 8)
  })

  it('is 0 for a row with one non-null value (a single chance cannot disagree)', () => {
    expect(spreadOf({ patientId: 'S01', cells: [null, 0.45], average: null, spread: null, notes: [] })).toBe(0)
    expect(spreadOf({ patientId: 'S01', cells: [0.45, 0.45], average: null, spread: null, notes: [] })).toBe(0)
  })

  it('returns null for a row with no non-null value', () => {
    expect(spreadOf({ patientId: 'S01', cells: [null, null], average: null, spread: null, notes: [] })).toBeNull()
    expect(spreadOf({ patientId: 'S01', cells: [], average: null, spread: null, notes: [] })).toBeNull()
  })
})

describe('viewOf (the sorted/filtered/windowed projection, DEC-5/6/12)', () => {
  const uniform = uniformPredictions()
  const twoMethodCols = buildColumns(uniform, 'pfs')
  const view = (opts: Partial<Parameters<typeof viewOf>[2]> = {}) =>
    viewOf(twoMethodCols, uniform, {
      outcome: 'pfs',
      groups: null,
      methodIds: null,
      search: '',
      sort: 'patient',
      limit: -1,
      ...opts,
    })

  it('defaults to the average-desc sort with the provider average (unfiltered default view)', () => {
    const v = view({ sort: 'average-desc' })
    expect(v.averageBy).toBe('provider')
    expect(v.columns.map(c => c.methodId)).toEqual(['landmark-cox-current', 'cox-cutpoint-risk'])
    expect(v.rows.map(r => r.patientId)).toEqual([
      'S0003',
      'S0001',
      'S0002',
      'S0004',
      'S0005',
      'S0007',
      'S0006',
    ])
    // The provider numbers, whole-point averages in the sorted row order.
    expect(v.rows.map(r => r.average)).toEqual([65, 60, 60, 50, 45, 45, 20])
    expect(v.shownCount).toBe(7)
    expect(v.totalCount).toBe(7)
  })

  it('recomputing over the visible cells in the unfiltered default view is identical to the provider average', () => {
    const v = view()
    for (const row of v.rows) {
      expect(row.average).toBe(buildAvg(row, v.columns))
    }
    expect(v.rows.map(r => r.average)).toEqual([60, 60, 65, 50, 45, 20, 45])
  })

  it('sorts by spread desc ("Methods disagree most"), nulls last, ties id asc', () => {
    const v = view({ sort: 'disagree' })
    expect(v.rows.map(r => r.patientId)).toEqual([
      'S0007',
      'S0001',
      'S0002',
      'S0003',
      'S0004',
      'S0005',
      'S0006',
    ])
    expect(v.rows.map(r => r.spread)).toEqual([
      (0.8 - 0.1) * 100,
      (0.9 - 0.3) * 100,
      (0.7 - 0.5) * 100,
      (0.75 - 0.55) * 100,
      (0.6 - 0.4) * 100,
      0,
      0,
    ])
  })

  it('sorts by patient id asc', () => {
    const v = view({ sort: 'patient' })
    expect(v.rows.map(r => r.patientId)).toEqual([
      'S0001',
      'S0002',
      'S0003',
      'S0004',
      'S0005',
      'S0006',
      'S0007',
    ])
  })

  it('filters rows by a case-insensitive patient-id substring', () => {
    expect(view({ search: '0005' }).rows.map(r => r.patientId)).toEqual(['S0005'])
    expect(view({ search: 's0005' }).rows.map(r => r.patientId)).toEqual(['S0005'])
    expect(view({ search: 'S000' }).rows).toHaveLength(7)
    expect(view({ search: '   ' }).rows).toHaveLength(7)
    expect(view({ search: 'nope' }).rows).toHaveLength(0)
  })

  it('narrows columns by group and recomputes the average (averageBy flips)', () => {
    const v = view({ groups: ['dynamic_risk'] })
    expect(v.columns.map(c => c.methodId)).toEqual(['landmark-cox-current'])
    expect(v.averageBy).toBe('recomputed')
    expect(v.rows.map(r => r.average)).toEqual([90, 70, 55, 40, null, 20, 10])
  })

  it('narrows columns by method ids and keeps the response method order (a membership test, not a reorder)', () => {
    const v = view({ methodIds: ['cox-cutpoint-risk', 'landmark-cox-current'] })
    expect(v.columns.map(c => c.methodId)).toEqual(['landmark-cox-current', 'cox-cutpoint-risk'])
    expect(v.averageBy).toBe('recomputed')
    expect(v.rows.map(r => r.average)).toEqual([60, 60, 65, 50, 45, 20, 45])
  })

  it('treats an empty group/method selection as no restriction (the picker All state)', () => {
    const v = view({ groups: [], methodIds: [] })
    expect(v.columns).toHaveLength(2)
    expect(v.averageBy).toBe('provider')
  })

  it('applies a group and a method-id filter together (intersection)', () => {
    const v = view({ groups: ['dynamic_risk'], methodIds: ['cox-cutpoint-risk'] })
    expect(v.columns).toEqual([])
    expect(v.rows.map(r => r.average)).toEqual([null, null, null, null, null, null, null])
  })

  it('flips to recomputed when the outcome tab excludes a column (a mixed run)', () => {
    const mixed = mixedPredictions()
    const allCols = buildColumns(mixed, 'pfs')
    const opts = { groups: null, methodIds: null, search: '', sort: 'patient' as const, limit: -1 }
    const endpointTab = viewOf(allCols, mixed, { ...opts, outcome: 'pfs' })
    expect(endpointTab.averageBy).toBe('recomputed')
    expect(endpointTab.columns.map(c => c.methodId)).toEqual([
      'landmark-cox-current',
      'cox-cutpoint-risk',
    ])
    const responseTab = viewOf(allCols, mixed, { ...opts, outcome: 'response' })
    expect(responseTab.averageBy).toBe('recomputed')
    expect(responseTab.columns.map(c => c.methodId)).toEqual(['responder-rule'])
    expect(responseTab.rows.map(r => r.average)).toEqual([50, 50, 50, 50, 50, 50, 50])
  })

  it('windows rows AFTER the sort and reports shown/total (the "Showing N of M" footer)', () => {
    const v = view({ sort: 'average-desc', limit: 4 })
    expect(v.rows.map(r => r.patientId)).toEqual(['S0003', 'S0001', 'S0002', 'S0004'])
    expect(v.shownCount).toBe(4)
    expect(v.totalCount).toBe(7)
    expect(view({ sort: 'average-desc', limit: 0 }).shownCount).toBe(7)
  })

  it('applies the window after the search filter', () => {
    const v = view({ search: 'S000', sort: 'patient', limit: 3 })
    expect(v.shownCount).toBe(3)
    expect(v.totalCount).toBe(7)
    expect(v.rows.map(r => r.patientId)).toEqual(['S0001', 'S0002', 'S0003'])
  })
})

describe('compareReport (the card numbers, DEC-7)', () => {
  const mixed = mixedPredictions()
  const cols = buildColumns(mixed, 'pfs').slice(0, 2)
  const rows = viewOf(cols, mixed, {
    outcome: 'pfs',
    groups: null,
    methodIds: ['landmark-cox-current', 'cox-cutpoint-risk'],
    search: '',
    sort: 'patient',
    limit: -1,
  }).rows

  it('names the shared top-5 intersection (≤ 3, average desc, id asc; value = the average)', () => {
    const report = compareReport(cols, rows)
    expect(report.sharedTop).toEqual([
      { patientId: 'S0003', value: 65 },
      { patientId: 'S0002', value: 60 },
      { patientId: 'S0004', value: 50 },
    ])
  })

  it('names the biggest divergences with both chances and the difference (≤ 3)', () => {
    const report = compareReport(cols, rows)
    expect(report.mostDiffering).toEqual([
      { patientId: 'S0007', a: 10, b: 80, diffPercent: 70 },
      { patientId: 'S0001', a: 90, b: 30, diffPercent: 60 },
      { patientId: 'S0002', a: 70, b: 50, diffPercent: 20 },
    ])
  })

  it('counts the divergent rows on the exact values (never the rounded difference)', () => {
    const report = compareReport(cols, rows)
    expect(report.divergentCount).toBe(5)
    expect(DIVERGENCE_PP).toBe(10)
  })

  it('excludes an abstain pair from the divergences (no numeric %-point difference)', () => {
    const report = compareReport(cols, rows)
    expect(report.mostDiffering.some(d => d.patientId === 'S0005' || d.patientId === 'S0006')).toBe(false)
  })

  it('never names a zero difference: an everywhere-equal pair reads the none-case sentence (RES-10)', () => {
    const same = [
      rowOf('P1', [0.5, 0.5], 50),
      rowOf('P2', [0.5, 0.5], 50),
      rowOf('P3', [0.4, 0.4], 40),
    ]
    const report = compareReport([columnOf('m-a'), columnOf('m-b')], same)
    expect(report.mostDiffering).toEqual([])
    expect(report.divergentCount).toBe(0)
    // The shared-top intersection is NOT empty — with every value equal the
    // two top-5 sets are the same three patients (that sentence stays true);
    // only the "differ most" sentence must never show (X% and X%).
    expect(report.sharedTop).toEqual([
      { patientId: 'P1', value: 50 },
      { patientId: 'P2', value: 50 },
      { patientId: 'P3', value: 40 },
    ])
  })

  it('keeps a real divergence ahead of an everywhere-zero wall (0% vs 0% is never an example)', () => {
    // The report's actual wall: both methods 0 for every patient — the
    // "differ most" list must stay empty, not name (0% and 0%) rows.
    const zeros = Array.from({ length: 6 }, (_, i) =>
      rowOf(`S00${i + 1}`, [0, 0], 0),
    )
    const report = compareReport([columnOf('m-a'), columnOf('m-b')], zeros)
    expect(report.mostDiffering).toEqual([])
    expect(report.divergentCount).toBe(0)
  })

  it('caps a larger intersection at the named constant (deterministic order)', () => {
    const reportCols = [columnOf('m-a'), columnOf('m-b')]
    const reportRows = [
      rowOf('P1', [0.9, 0.1], 50),
      rowOf('P2', [0.8, 0.8], 80),
      rowOf('P3', [0.7, 0.7], 70),
      rowOf('P4', [0.6, 0.6], 60),
      rowOf('P5', [0.5, 0.5], 50),
      rowOf('P6', [0.4, 0.9], 65),
      rowOf('P7', [0.3, 0.1], 20),
    ]
    const report = compareReport(reportCols, reportRows)
    expect(report.sharedTop).toHaveLength(COMPARE_SHARED_CAP)
    expect(report.sharedTop).toEqual([
      { patientId: 'P2', value: 80 },
      { patientId: 'P3', value: 70 },
      { patientId: 'P4', value: 60 },
    ])
    expect(report.mostDiffering).toHaveLength(COMPARE_DIFFER_CAP)
    expect(report.mostDiffering[0]).toEqual({ patientId: 'P1', a: 90, b: 10, diffPercent: 80 })
  })

  it('returns an empty report for a view with fewer than two columns', () => {
    expect(compareReport([columnOf('m-a')], rows)).toEqual({
      sharedTop: [],
      mostDiffering: [],
      divergentCount: 0,
    })
    expect(compareReport([], rows)).toEqual({ sharedTop: [], mostDiffering: [], divergentCount: 0 })
  })

  it('uses a 5-patient window per method (the "five highest chances" copy)', () => {
    const reportCols = [columnOf('m-a'), columnOf('m-b')]
    const many = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1
      const a = (10 - n) / 10 // 0.9, 0.8, … — descending patient order
      const b = n / 10 // 0.1, 0.2, … — ascending patient order
      return rowOf(`S${String(n).padStart(3, '0')}`, [a, b], Math.round(((a + b) / 2) * 100))
    })
    const report = compareReport(reportCols, many)
    // m-a's top 5 = S001..S005; m-b's top 5 = S010..S006 — no intersection.
    expect(report.sharedTop).toEqual([])
    expect(COMPARE_TOP_N).toBe(5)
  })
})

describe('divergentPatients (the divergent-only filter, DEC-7)', () => {
  const mixed = mixedPredictions()
  const cols = buildColumns(mixed, 'pfs').slice(0, 2)
  const rows = viewOf(cols, mixed, {
    outcome: 'pfs',
    groups: null,
    methodIds: ['landmark-cox-current', 'cox-cutpoint-risk'],
    search: '',
    sort: 'patient',
    limit: -1,
  }).rows
  const a = 'landmark-cox-current'
  const b = 'cox-cutpoint-risk'

  it('filters |a − b| ≥ 10 percentage points (the named default) in row order', () => {
    expect(divergentPatients(cols, rows, a, b)).toEqual(['S0001', 'S0002', 'S0003', 'S0004', 'S0007'])
  })

  it('honours a caller-supplied threshold (exact values, never rounded)', () => {
    expect(divergentPatients(cols, rows, a, b, 25)).toEqual(['S0001', 'S0007'])
    expect(divergentPatients(cols, rows, a, b, 70)).toEqual(['S0007'])
    expect(divergentPatients(cols, rows, a, b, 71)).toEqual([])
  })

  it('excludes an abstain in either method and an unknown method id', () => {
    expect(divergentPatients(cols, rows, a, b)).not.toContain('S0005')
    expect(divergentPatients(cols, rows, a, b)).not.toContain('S0006')
    expect(divergentPatients(cols, rows, 'no-such-method', b)).toEqual([])
    expect(divergentPatients(cols, rows, a, a)).toEqual([])
  })

  it('matches nothing for a non-finite or negative threshold', () => {
    expect(divergentPatients(cols, rows, a, b, Number.NaN)).toEqual([])
    expect(divergentPatients(cols, rows, a, b, -1)).toEqual([])
  })
})

describe('sortByFirstMethod (the H table row order, DEC-6)', () => {
  const mixed = mixedPredictions()
  const cols = buildColumns(mixed, 'pfs').slice(0, 2)
  const patients = ['S0001', 'S0002', 'S0003', 'S0004', 'S0005', 'S0006', 'S0007']
  const rows = viewOf(cols, mixed, {
    outcome: 'pfs',
    groups: null,
    methodIds: ['landmark-cox-current', 'cox-cutpoint-risk'],
    search: '',
    sort: 'patient',
    limit: -1,
  }).rows

  it('orders by the first method\u2019s chance desc, nulls last, ties id asc', () => {
    const byA = sortByFirstMethod(cols, rows, 'landmark-cox-current')
    expect(byA.map(r => r.patientId)).toEqual(['S0001', 'S0002', 'S0003', 'S0004', 'S0006', 'S0007', 'S0005'])
    const byB = sortByFirstMethod(cols, rows, 'cox-cutpoint-risk')
    expect(byB.map(r => r.patientId)).toEqual(['S0007', 'S0003', 'S0004', 'S0002', 'S0005', 'S0001', 'S0006'])
  })

  it('never mutates the input and falls back to id asc for an unknown column', () => {
    expect(rows.map(r => r.patientId)).toEqual(patients)
    expect(sortByFirstMethod(cols, rows, 'no-such-method').map(r => r.patientId)).toEqual(patients)
  })
})
