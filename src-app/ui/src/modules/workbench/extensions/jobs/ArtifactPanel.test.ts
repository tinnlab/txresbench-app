// TEST-307 (ITEM-24) + TEST-414 (ITEM-39) + TEST-523 (ITEM-58/ITEM-35) — the artifact-view
// dispatch seam + the deterministic multi-output ordering. These are the PURE cores
// the components render from (the runner is node-env, so component rendering is not
// exercised here; the render wiring is covered by the e2e specs).
//
// ITEM-35 deleted the `resultRenderers` CONTRIBUTION half of the dispatch (zero
// production contributors) and, with it, TEST-412's named-component resolver — whose only
// registered name was ITEM-31's `ui/StandardResultTable`. What survives is the pure
// `defaultForKind` classifier, which is what carries the "ALWAYS renders something"
// guarantee: every kind, known or not, maps to one of the three host renderers.

import { afterEach, describe, expect, it } from 'vitest'
import type { Artifact } from '@/api-client/types'
import { sortRunArtifacts } from './useRunArtifacts'
import {
  __resetArtifactRegistry,
  defaultForKind,
  dispatchCompare,
  registerArtifactCompareComponent,
  registerArtifactListRenderer,
  resolveArtifactListRenderer,
  type ArtifactCompareComponent,
} from '../../core/contributions/artifactRegistry'

afterEach(() => __resetArtifactRegistry())

describe('ArtifactPanel pure classifier — no kind-regex, no contribution branch (TEST-523 / ITEM-58 / ITEM-35)', () => {
  it('an UNKNOWN datatype still renders: it classifies to the universal GenericResult fallback', () => {
    expect(defaultForKind('whatever')).toBe('generic')
    expect(defaultForKind('')).toBe('generic')
    expect(defaultForKind('some.brand.new/datatype')).toBe('generic')
  })

  it('StatCard stays reachable via defaultForKind (stat/metric), as does ProvenanceView', () => {
    expect(defaultForKind('qc-metric')).toBe('stat')
    expect(defaultForKind('cluster-stat')).toBe('stat')
    expect(defaultForKind('methods')).toBe('provenance')
    expect(defaultForKind('provenance')).toBe('provenance')
  })

  it('EVERY kind classifies to exactly one of the three host renderers (total function)', () => {
    const kinds = ['de-table', 'marker-table', 'clustering', 'embedding', 'qc-metric', 'methods', '']
    for (const k of kinds) {
      expect(['stat', 'provenance', 'generic']).toContain(defaultForKind(k))
    }
  })

  it('the DE `de|marker|table` regex is GONE — de-table → generic (datatype-agnostic)', () => {
    expect(defaultForKind('de-table')).toBe('generic')
    expect(defaultForKind('marker-table')).toBe('generic')
  })
})

// A node-safe stand-in "component" (the registry stores + resolves by identity).
const FakeCompare = (() => null) as unknown as ArtifactCompareComponent

describe('N-way compare dispatch (TEST-414 / ITEM-39)', () => {
  it('a registered compare renderer receives ALL N ids in one dispatch', () => {
    registerArtifactCompareComponent('de-table', FakeCompare)
    const d = dispatchCompare('de-table', ['a', 'b', 'c'])
    expect(d.mode).toBe('named')
    if (d.mode === 'named') {
      expect(d.component).toBe(FakeCompare)
      expect(d.artifactIds).toEqual(['a', 'b', 'c'])
    }
  })

  it('no compare renderer → tiled dispatch (the pane model tiles N single panes)', () => {
    const d = dispatchCompare('clustering', ['x', 'y'])
    expect(d).toEqual({ mode: 'tiled', artifactIds: ['x', 'y'] })
  })

  it('artifactListRenderers resolves a module\'s bespoke columns else falls back', () => {
    expect(resolveArtifactListRenderer('de-table')).toBeUndefined() // → the generic history spine
    const cols = { columns: [{ key: 'method', title: 'Method', render: () => null }] }
    registerArtifactListRenderer('de-table', cols)
    expect(resolveArtifactListRenderer('de-table')).toBe(cols)
  })
})

describe('sortRunArtifacts — deterministic multi-output (TEST-307 / ITEM-24)', () => {
  function artifact(over: Partial<Artifact> & Pick<Artifact, 'id' | 'output_id'>): Artifact {
    return {
      content_hash: 'h',
      created_at: '2026-07-15T00:00:00Z',
      datatype: 'de-table',
      is_multifile: false,
      meta: null,
      object_key: 'k',
      role: 'artifact',
      run_id: 'run-1',
      logical_bytes: 0,
      status: 'ready',
      structure: { encoding: 'opaque', media_type: 'application/octet-stream' },
      updated_at: '2026-07-15T00:00:00Z',
      ...over,
    } as Artifact
  }

  it('orders a run\'s outputs by output_id then id (stable, not by created_at)', () => {
    const rows = [
      artifact({ id: 'z', output_id: 'summary' }),
      artifact({ id: 'a', output_id: 'de' }),
      artifact({ id: 'b', output_id: 'de' }),
    ]
    expect(sortRunArtifacts(rows).map(a => a.id)).toEqual(['a', 'b', 'z'])
  })

  it('is a pure copy (does not mutate the input)', () => {
    const rows = [artifact({ id: 'b', output_id: 'x' }), artifact({ id: 'a', output_id: 'x' })]
    const sorted = sortRunArtifacts(rows)
    expect(rows.map(r => r.id)).toEqual(['b', 'a']) // input untouched
    expect(sorted.map(r => r.id)).toEqual(['a', 'b'])
  })
})
