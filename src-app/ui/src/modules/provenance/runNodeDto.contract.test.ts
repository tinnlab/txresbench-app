// TEST-32 (ITEM-5) — the FE half of the `Option` + `#[serde(default)]` requirement.
// A LEGACY `RunNodeDto` payload lacking BOTH new fields (`params`, `rerun_spec`)
// still satisfies the generated TS type, and every existing consumer accessor reads
// it without throwing. A required field on either side would break both.

import { describe, expect, it } from 'vitest'
import type { RunNodeDto, UsedEdgeDto } from '@/api-client/types'
import { coerceRunParams, reseedFromRun } from '@/modules/workbench/extensions/analysis/rerun'
import { filterRunsByAnalysis, isCompletedRun, runLabel } from '@/modules/workbench/extensions/analysis/runHistory'
import { buildLineageModel } from '@/modules/workbench/extensions/provenance/lineageGraph'
import { sortRunArtifacts } from '@/modules/workbench/extensions/jobs/useRunArtifacts'
import { criteriaText } from './project-extension/components/criteriaPreview'

/** A run node exactly as a PRE-Slice-B server sent it: no `params`, no `rerun_spec`. */
const legacy: RunNodeDto = {
  run_id: '00000000-0000-4000-8000-0000000000d1',
  project_id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'compute',
  status: 'completed',
  generator_id: 'cell.filter',
  generator_version: '0.1.0',
  inputs: [],
  captured_at: '2026-07-15T12:00:00Z',
}

describe('RunNodeDto legacy-payload contract (TEST-32 / ITEM-5)', () => {
  it('type-checks without the two new fields', () => {
    expect(legacy.params).toBeUndefined()
    expect(legacy.rerun_spec).toBeUndefined()
  })

  it('every existing consumer accessor reads it without throwing', () => {
    // rerun.ts (`reseedFromRun` → `coerceRunParams`) — the re-run affordance.
    expect(() => reseedFromRun(legacy)).not.toThrow()
    expect(reseedFromRun(legacy).params).toEqual({})
    expect(coerceRunParams(legacy.params)).toEqual({})

    // runHistory.ts — the run-history list.
    expect(isCompletedRun(legacy)).toBe(true)
    expect(filterRunsByAnalysis([legacy], 'cell.filter')).toHaveLength(1)
    expect(() => runLabel(legacy)).not.toThrow()

    // lineageGraph.ts — the DAG model (MultiRunComparePane shares `coerceRunParams`).
    expect(() =>
      buildLineageModel({ runs: [legacy], roots: [], readiness: null as never }),
    ).not.toThrow()

    // useRunArtifacts.ts — its run-node consumer sorts artifacts, never params.
    expect(sortRunArtifacts([])).toEqual([])

    // …and the NEW consumer degrades to "no filter" rather than throwing.
    expect(criteriaText(legacy)).toBe('')
  })
})

// TEST-30 (ITEM-18 / ITEM-22) — the generated `UsedEdgeDto` carries `bound_by`, and
// carries it as OPTIONAL.
//
// Both halves are load-bearing. Optional, because every edge recorded before this
// change has no origin and absence must stay absence — a required field would force
// every caller to invent one, which is the fabrication DEC-7 forbids. Present,
// because the run trust-view reads `e.bound_by` to state which inputs nobody
// reviewed, and a type without the property makes that read a compile error.
//
// This test is RED until `just openapi-regen` has run (the parent runs it ONCE at
// fan-in). That is the intended signal, not a defect in the test: it is what makes a
// backend field that never reached the generated client impossible to miss.
describe('UsedEdgeDto binding-origin contract (TEST-30 / ITEM-18)', () => {
  it('carries `bound_by` as an optional field', () => {
    // A legacy edge — no origin at all — still satisfies the type.
    const legacyEdge: UsedEdgeDto = {
      slot: 'input',
      kind: 'artifact',
      content_hash: 'sha256:abc',
    }
    expect(legacyEdge.bound_by).toBeUndefined()

    // …and an edge that DOES record one type-checks with either value.
    const auto: UsedEdgeDto = { ...legacyEdge, bound_by: 'auto' }
    const user: UsedEdgeDto = { ...legacyEdge, bound_by: 'user' }
    expect([auto.bound_by, user.bound_by]).toEqual(['auto', 'user'])
  })
})
