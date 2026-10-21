// TEST-536 (ITEM-65) — the multi-run compare builder aligns N runs' params→outcomes
// into columns (one column per run) and flags per-metric deltas + a `varies` marker on
// the swept metrics. This is the clustree-style multi-resolution compare's data core.

import { describe, expect, it } from 'vitest'
import type { RunObservablesEntry } from './runDiff'
import { buildMultiRunCompare, coerceCell } from './multiRunCompare'

function entry(runId: string, resolution: number, clusters: number, cells: number): RunObservablesEntry {
  return {
    runId,
    label: `res ${resolution}`,
    params: { resolution },
    observables: { outputs: 1, 'clustering · outputs': clusters, 'clustering · cells': cells },
  }
}

describe('coerceCell — comparable projection', () => {
  it('keeps primitives, stabilizes objects, nulls the rest', () => {
    expect(coerceCell(0.6)).toBe(0.6)
    expect(coerceCell('wilcoxon')).toBe('wilcoxon')
    expect(coerceCell(true)).toBe('true')
    expect(coerceCell(null)).toBeNull()
    expect(coerceCell(undefined)).toBeNull()
    expect(coerceCell(Infinity)).toBeNull()
    expect(coerceCell({ a: 1 })).toBe('{"a":1}')
  })
})

describe('buildMultiRunCompare — align N runs (TEST-536)', () => {
  const cmp = buildMultiRunCompare([entry('r1', 0.4, 6, 5000), entry('r2', 0.6, 9, 5000), entry('r3', 0.8, 14, 5000)])

  it('one column per run, params rows before observable rows', () => {
    expect(cmp.runs.map(r => r.runId)).toEqual(['r1', 'r2', 'r3'])
    const kinds = cmp.rows.map(r => r.kind)
    expect(kinds.indexOf('param')).toBeLessThan(kinds.indexOf('observable'))
  })

  it('aligns the swept resolution across the three run columns', () => {
    const res = cmp.rows.find(r => r.key === 'resolution')!
    expect(res.values).toEqual([0.4, 0.6, 0.8])
    expect(res.varies).toBe(true)
    expect(res.numeric).toBe(true)
    // deltas vs the baseline (first) run — float-tolerant (0.6 − 0.4 is not exact).
    expect(res.deltas[0]).toBe(0)
    expect(res.deltas[1]!).toBeCloseTo(0.2, 10)
    expect(res.deltas[2]!).toBeCloseTo(0.4, 10)
  })

  it('flags per-metric deltas against the baseline run', () => {
    const clusters = cmp.rows.find(r => r.key === 'clustering · outputs')!
    expect(clusters.values).toEqual([6, 9, 14])
    expect(clusters.deltas).toEqual([0, 3, 8])
    expect(clusters.varies).toBe(true)
  })

  it('marks a constant metric as not varying (delta 0 across runs)', () => {
    const cells = cmp.rows.find(r => r.key === 'clustering · cells')!
    expect(cells.values).toEqual([5000, 5000, 5000])
    expect(cells.varies).toBe(false)
    expect(cells.deltas).toEqual([0, 0, 0])
  })

  it('treats a metric absent from one run as present-vs-absent (varies) with a null cell', () => {
    const cmp2 = buildMultiRunCompare([
      { runId: 'a', label: 'A', params: { method: 'wilcoxon' }, observables: { outputs: 1 } },
      { runId: 'b', label: 'B', params: {}, observables: { outputs: 1, 'de · outputs': 2 } },
    ])
    const method = cmp2.rows.find(r => r.key === 'method')!
    expect(method.values).toEqual(['wilcoxon', null])
    expect(method.varies).toBe(true)
    expect(method.numeric).toBe(false)
    expect(method.deltas).toEqual([null, null])
    const de = cmp2.rows.find(r => r.key === 'de · outputs')!
    expect(de.values).toEqual([null, 2])
    expect(de.varies).toBe(true)
  })
})
