// TEST-W8-rerun (ITEM-63) — the params-reseed extraction: from a completed run's
// provenance node (`RunNodeDto`), recover the producing analysis id + the exact params
// it ran with (the pre-seed for "Re-run with tweaked params"). Defensive coercion of
// the opaque `params` guards a malformed node.

import { describe, expect, it } from 'vitest'
import type { RunNodeDto } from '@/api-client/types'
import { coerceRunParams, reseedFromRun } from './rerun'

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

describe('coerceRunParams — defensive opaque→record', () => {
  it('keeps a record (copied, not aliased)', () => {
    const src = { resolution: 0.8 }
    const out = coerceRunParams(src)
    expect(out).toEqual({ resolution: 0.8 })
    out.resolution = 1
    expect(src.resolution).toBe(0.8) // copy, not alias
  })

  it('coerces a non-object to an empty record', () => {
    expect(coerceRunParams(null)).toEqual({})
    expect(coerceRunParams(undefined)).toEqual({})
    expect(coerceRunParams([1, 2])).toEqual({}) // an array is not a params record
    expect(coerceRunParams(42)).toEqual({})
  })
})

describe('reseedFromRun (ITEM-63)', () => {
  it('extracts the analysis id + params for a pre-seeded re-run', () => {
    const seed = reseedFromRun(run({ run_id: 'r1', generator_id: 'demo.leiden', params: { resolution: 0.8, gate: null } }))
    expect(seed).toEqual({ analysisId: 'demo.leiden', params: { resolution: 0.8, gate: null } })
  })

  it('falls back to empty params (→ analysis defaults) for a malformed node', () => {
    const seed = reseedFromRun(run({ run_id: 'r2', generator_id: 'qc.filter', params: 'oops' as unknown }))
    expect(seed).toEqual({ analysisId: 'qc.filter', params: {} })
  })
})
