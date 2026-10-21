// TEST-540 (ITEM-62) — the per-node "Export from here" scope rule. `defaultExportScope`
// is the single source the DAG node action + `ProvenanceExport.openFor` share: a concrete
// run/artifact target defaults to the tightest `run` scope (this run + its lineage), a null
// target (the whole-project export affordance) defaults to `project`. `exportScopeToWire`
// then maps to the backend vocabulary. Pure → the node runner (no store/React).

import { describe, expect, it } from 'vitest'
import { defaultExportScope, exportScopeToWire } from './types'

describe('defaultExportScope (TEST-540 / ITEM-62)', () => {
  it('a concrete node target → the tightest `run` scope', () => {
    expect(defaultExportScope('run-abc')).toBe('run')
    expect(defaultExportScope('artifact-42')).toBe('run')
  })

  it('a null/absent target (whole-project export) → `project` scope', () => {
    expect(defaultExportScope(null)).toBe('project')
    expect(defaultExportScope(undefined)).toBe('project')
    // An empty string is not a real node id → project, never a run scoped to "".
    expect(defaultExportScope('')).toBe('project')
  })

  it('maps each scope to the backend `ExportRequest.scope` wire vocabulary', () => {
    expect(exportScopeToWire(defaultExportScope('run-abc'))).toBe('single')
    expect(exportScopeToWire(defaultExportScope(null))).toBe('project')
  })
})
