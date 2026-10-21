// TEST-310 (ITEM-26) — the run-history pane's paging idiom. Pages
// `Provenance.runs({project_id, page, per_page})` and renders the "N of M" RunsList
// idiom with correct page boundaries; ITEM-39 filters that same list by producing
// analysis (the per-analysis results list).

import { describe, expect, it } from 'vitest'
import type { RunNodeDto } from '@/api-client/types'
import {
  filterRunsByAnalysis,
  isCompletedRun,
  pageBounds,
  runsCountLabel,
} from './runHistory'

function run(over: Partial<RunNodeDto> & Pick<RunNodeDto, 'run_id' | 'generator_id'>): RunNodeDto {
  return {
    captured_at: '2026-07-15T00:00:00Z',
    generator_version: '1',
    inputs: [],
    kind: 'compute',
    params: {},
    project_id: 'p1',
    status: 'completed',
    ...over,
  } as RunNodeDto
}

describe('pageBounds + runsCountLabel (TEST-310)', () => {
  it('computes the boundaries of the first page', () => {
    expect(pageBounds(1, 20, 47)).toEqual({ from: 1, to: 20, totalPages: 3 })
  })

  it('computes the boundaries of a middle page', () => {
    expect(pageBounds(2, 20, 47)).toEqual({ from: 21, to: 40, totalPages: 3 })
  })

  it('computes the boundaries of the last (partial) page', () => {
    expect(pageBounds(3, 20, 47)).toEqual({ from: 41, to: 47, totalPages: 3 })
  })

  it('handles an empty result set', () => {
    expect(pageBounds(1, 20, 0)).toEqual({ from: 0, to: 0, totalPages: 1 })
  })

  it('renders the N-of-M label', () => {
    expect(runsCountLabel(2, 20, 47)).toBe('Showing 21–40 of 47')
  })
})

describe('filterRunsByAnalysis + isCompletedRun (ITEM-26 / ITEM-39)', () => {
  const runs = [
    run({ run_id: 'r1', generator_id: 'de.wilcoxon' }),
    run({ run_id: 'r2', generator_id: 'cluster.leiden' }),
    run({ run_id: 'r3', generator_id: 'de.wilcoxon', status: 'failed' }),
  ]

  it('returns all runs with no filter (generic history)', () => {
    expect(filterRunsByAnalysis(runs).map(r => r.run_id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('filters to a single producing analysis (per-analysis list)', () => {
    expect(filterRunsByAnalysis(runs, 'de.wilcoxon').map(r => r.run_id)).toEqual(['r1', 'r3'])
  })

  it('recognizes a completed run', () => {
    expect(isCompletedRun(runs[0])).toBe(true)
    expect(isCompletedRun(runs[2])).toBe(false)
  })
})
