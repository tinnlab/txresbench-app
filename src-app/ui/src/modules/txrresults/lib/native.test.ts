/**
 * The methods' own results (B): the wire → view bridge (`nativeValuesOf`,
 * through `buildColumns`), the per-patient lookup, the own-results column
 * set, and the plain-text formatters. Every fixture is synthetic.
 */
import { describe, expect, it } from 'vitest'
import type { TxrPredictionsResponse } from '@/api-client/types'
import type { TxrHeatmapColumn } from '../types'
import { buildColumns, nativeValuesOf } from './heatmap'
import { hasOwnResults, ownResultColumnsOf, ownResultOf, patientIndexOf } from './native'
import { formatOwnCall, formatOwnNotRecordedNote, formatOwnScore } from './format'

/** The generated `number | null[]` array-union artifact. */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

type WireMethod = TxrPredictionsResponse['methods'][number]

function wireMethod(id: string, over: Partial<WireMethod> = {}): WireMethod {
  return {
    method_id: id,
    label: id,
    group: 'static-risk',
    group_label: 'Static risk',
    task: 'pfs',
    prob_source: 'recalibrated',
    coverage: { scored: 3, eligible: 3, fraction: 1 },
    probabilities: wireArray<number>([0.2, 0.5, 0.8]),
    notes: wireArray<string>([null, null, null]),
    ...over,
  }
}

function predictions(methods: WireMethod[]): TxrPredictionsResponse {
  return {
    run_id: 'run-1',
    endpoint: 'pfs',
    horizon: 238,
    patients: ['S0001', 'S0002', 'S0003'],
    methods,
    average: wireArray<number>([0.2, 0.5, 0.8]),
    generated_at: '2026-11-19T00:00:00Z',
  }
}

describe('nativeValuesOf / buildColumns — the own results on each column', () => {
  it('maps recorded scores and calls; a method without calls has calls: null', () => {
    const cols = buildColumns(
      predictions([
        wireMethod('with-calls', {
          native_recorded: true,
          scores: wireArray<number>([2.5, null, -1]),
          calls: wireArray<number>([1, null, 0]),
        }),
        wireMethod('score-only', { native_recorded: true, scores: wireArray<number>([0.1, 0.2, 0.3]) }),
      ]),
      'pfs',
    )
    expect(cols[0].native).toEqual({ scores: [2.5, null, -1], calls: [1, null, 0] })
    expect(cols[1].native).toEqual({ scores: [0.1, 0.2, 0.3], calls: null })
  })

  it('reads "not recorded" (null) for an older run, whatever arrays it carries', () => {
    expect(nativeValuesOf(wireMethod('old'))).toBeNull()
    expect(
      nativeValuesOf(wireMethod('old', { native_recorded: false, scores: wireArray<number>([1, 2, 3]) })),
    ).toBeNull()
  })

  it('keeps only the contract’s two call values and finite scores', () => {
    const native = nativeValuesOf(
      wireMethod('odd', {
        native_recorded: true,
        scores: wireArray<number>([Number.NaN, 4, null]),
        calls: wireArray<number>([2, 1, 0]),
      }),
    )
    expect(native).toEqual({ scores: [null, 4, null], calls: [null, 1, 0] })
  })
})

describe('the own-result lookup and column set', () => {
  const column = (id: string, native: TxrHeatmapColumn['native']): TxrHeatmapColumn => ({
    methodId: id,
    label: id,
    group: 'g',
    groupLabel: 'G',
    task: 'pfs',
    probSource: 'recalibrated',
    flatConversion: false,
    coverage: null,
    values: [0.1, 0.2],
    notes: [null, null],
    constantValue: null,
    native,
  })

  it('looks a patient up by id in the response order (rows are sorted elsewhere)', () => {
    const index = patientIndexOf(['S0001', 'S0002'])
    const col = column('m', { scores: [3, 4], calls: [0, 1] })
    expect(ownResultOf(col, index, 'S0002')).toEqual({ score: 4, call: 1 })
    expect(ownResultOf(col, index, 'S0001')).toEqual({ score: 3, call: 0 })
    expect(ownResultOf(col, index, 'S9999')).toEqual({ score: null, call: null })
    expect(ownResultOf(column('n', { scores: [3, 4], calls: null }), index, 'S0001')).toEqual({
      score: 3,
      call: null,
    })
    expect(ownResultOf(column('old', null), index, 'S0001')).toBeNull()
    expect(hasOwnResults(column('old', null))).toBe(false)
    expect(hasOwnResults(column('m', { scores: [], calls: null }))).toBe(true)
  })

  it('shows the view’s columns and the ones it dropped for no chance, in run order', () => {
    const a = column('a', null)
    const b = column('b', null)
    const c = column('c', null)
    const d = column('d', null)
    expect(ownResultColumnsOf([a, b, c, d], [c, a], [b]).map(x => x.methodId)).toEqual(['a', 'b', 'c'])
  })
})

describe('the own-result formatters', () => {
  it('formats the yes/no answer in plain words', () => {
    expect(formatOwnCall(1)).toBe('Judged failing')
    expect(formatOwnCall(0)).toBe('Not failing')
    expect(formatOwnCall(null)).toBeNull()
  })

  it('formats a score as a plain number, never rounding a tiny or huge one away', () => {
    expect(formatOwnScore(2.5)).toBe('2.5')
    expect(formatOwnScore(-0.125)).toBe('-0.125')
    expect(formatOwnScore(12)).toBe('12')
    expect(formatOwnScore(0.12345)).toBe('0.123')
    expect(formatOwnScore(0)).toBe('0')
    expect(formatOwnScore(0.0000123)).toBe('1.23e-5')
    expect(formatOwnScore(-0.0005)).toBe('-5e-4')
    expect(formatOwnScore(2500000)).toBe('2.5e6')
    expect(formatOwnScore(null)).toBeNull()
    expect(formatOwnScore(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('names the methods whose own results were not recorded', () => {
    expect(formatOwnNotRecordedNote([])).toBeNull()
    expect(formatOwnNotRecordedNote(['kelim'])).toBe('The own results of kelim were not recorded for this run.')
    expect(formatOwnNotRecordedNote(['a', 'b'])).toBe('The own results of a, b were not recorded for this run.')
  })
})
