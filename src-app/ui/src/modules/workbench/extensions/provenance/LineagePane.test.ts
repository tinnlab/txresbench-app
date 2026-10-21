// TEST-529 (ITEM-61) — the GraphDto → DAG transform + dagre layout. `buildLineageModel`
// maps a provenance `GraphDto` (roots + runs + `inputs` UsedEdges) into artifact + run
// nodes and directed produced-by / consumed-by edges, preserving EVERY node id and edge
// endpoint (no dangling edges); `layoutLineage` positions them (finite coords). Node-env
// pure test (dagre runs headless; no React / xyflow), mirroring runHistory.test.ts.

import { describe, expect, it } from 'vitest'
import type { GraphDto } from '@/api-client/types'
import { buildLineageModel, layoutLineage } from './lineageGraph'

/** A minimal closure: a1 (source) → run r1 → a2 (produced). */
const GRAPH = {
  roots: [
    { id: 'a1', datatype: 'anndata', output_id: 'o1', content_hash: 'h1' },
    { id: 'a2', datatype: 'embedding', output_id: 'o2', content_hash: 'h2', run_id: 'r1' },
  ],
  runs: [
    {
      run_id: 'r1',
      kind: 'analysis',
      generator_id: 'demo.leiden',
      generator_version: '1',
      status: 'completed',
      params: {},
      project_id: 'p',
      captured_at: '2026-07-19T00:00:00Z',
      inputs: [{ content_hash: 'h1', kind: 'artifact', ref_id: 'a1', slot: 'input' }],
    },
  ],
} as unknown as GraphDto

describe('buildLineageModel', () => {
  it('maps every artifact + run to a node (ids prefixed, none dropped)', () => {
    const { nodes } = buildLineageModel(GRAPH)
    const ids = nodes.map(n => n.id).sort()
    expect(ids).toEqual(['art:a1', 'art:a2', 'run:r1'])
    expect(nodes.find(n => n.id === 'art:a2')?.type).toBe('artifact')
    expect(nodes.find(n => n.id === 'run:r1')?.type).toBe('run')
    // The action target is the raw artifact/run id (open-artifact + export-from-here).
    expect(nodes.find(n => n.id === 'art:a1')?.target).toBe('a1')
    expect(nodes.find(n => n.id === 'run:r1')?.target).toBe('r1')
  })

  // TEST-15 (ITEM-9) — a run node carries its PREDICATE as `detail`, so the live
  // lineage surface answers "what was filtered on?" without opening anything. A run
  // with no scientific params carries no detail (no empty chrome).
  it('carries a run node’s predicate as its detail (and none when there is none)', () => {
    const withPredicate = {
      roots: [],
      runs: [
        {
          run_id: 'rf',
          kind: 'compute',
          generator_id: 'cell.filter',
          generator_version: '0.1.0',
          status: 'completed',
          project_id: 'p',
          captured_at: '2026-07-19T00:00:00Z',
          inputs: [],
          params: { criteria: [{ column: 'pct_counts_mito', max: 10 }], label: 'lowqc', seed: 7 },
        },
      ],
    } as unknown as GraphDto
    const node = buildLineageModel(withPredicate).nodes.find(n => n.id === 'run:rf')
    expect(node?.detail).toBe('pct_counts_mito ≤ 10')

    // The base fixture's run has `params: {}` → no predicate, no detail chrome.
    expect(buildLineageModel(GRAPH).nodes.find(n => n.id === 'run:r1')?.detail).toBeUndefined()
  })

  it('builds produced-by (run→artifact) + consumed-by (artifact→run) edges', () => {
    const { edges } = buildLineageModel(GRAPH)
    const pairs = edges.map(e => `${e.relation}:${e.source}->${e.target}`).sort()
    expect(pairs).toEqual(['consumed:art:a1->run:r1', 'produced:run:r1->art:a2'])
  })

  it('every edge endpoint references an existing node id (no dangling edges)', () => {
    const { nodes, edges } = buildLineageModel(GRAPH)
    const ids = new Set(nodes.map(n => n.id))
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
  })

  it('synthesizes an intermediate node for an input artifact absent from roots', () => {
    const g = {
      roots: [{ id: 'a1', datatype: 'anndata', output_id: 'o1', content_hash: 'h1' }],
      runs: [
        {
          run_id: 'r9',
          kind: 'analysis',
          generator_id: 'g',
          generator_version: '1',
          status: 'completed',
          params: {},
          project_id: 'p',
          captured_at: '2026-07-19T00:00:00Z',
          inputs: [{ content_hash: 'hx', kind: 'artifact', ref_id: 'missing-art', slot: 'input' }],
        },
      ],
    } as unknown as GraphDto
    const { nodes, edges } = buildLineageModel(g)
    expect(nodes.map(n => n.id)).toContain('art:missing-art')
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'art:missing-art', target: 'run:r9', relation: 'consumed' }),
    )
  })

  it('returns an empty model for an absent / malformed graph', () => {
    expect(buildLineageModel(null)).toEqual({ nodes: [], edges: [] })
    expect(buildLineageModel(undefined)).toEqual({ nodes: [], edges: [] })
    expect(buildLineageModel({} as unknown as GraphDto)).toEqual({ nodes: [], edges: [] })
  })
})

describe('layoutLineage (dagre)', () => {
  it('positions every node with finite coordinates + a size', () => {
    const model = buildLineageModel(GRAPH)
    const positioned = layoutLineage(model)
    expect(positioned).toHaveLength(model.nodes.length)
    for (const n of positioned) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(n.width).toBeGreaterThan(0)
      expect(n.height).toBeGreaterThan(0)
    }
    // Preserves node identity through the layout pass.
    expect(positioned.map(n => n.id).sort()).toEqual(['art:a1', 'art:a2', 'run:r1'])
  })

  it('lays out left-to-right: the source artifact precedes its consuming run', () => {
    const positioned = layoutLineage(buildLineageModel(GRAPH))
    const a1 = positioned.find(n => n.id === 'art:a1')!
    const r1 = positioned.find(n => n.id === 'run:r1')!
    expect(a1.x).toBeLessThan(r1.x)
  })
})
