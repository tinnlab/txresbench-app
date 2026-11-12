import { describe, it, expect } from 'vitest'
import { hashRows, buildFigureManifest, manifestToJSON, type FigureManifestInput } from './manifest'

const base: FigureManifestInput = {
  cellId: 'violin-1', kind: 'violin', datasetId: 'ds-42',
  sourceRows: [['A', 1], ['A', 2], ['B', 3]],
  colorBy: { mode: 'categorical', key: 'group', colormap: 'viridis' },
  valueRange: [0, 10], hiddenGroups: ['C'],
  linkValueFilters: [{ column: 'qc', range: [0, 5] }],
  seed: 12345, toolVersion: 'txresbench-1.0.0', vizVersion: 'viz-0.9',
}

describe('hashRows (ITEM-6)', () => {
  it('is stable for the same rows', () => {
    expect(hashRows([['A', 1], ['B', 2]])).toBe(hashRows([['A', 1], ['B', 2]]))
  })
  it('changes when the data changes', () => {
    expect(hashRows([['A', 1]])).not.toBe(hashRows([['A', 2]]))
  })
  it('is a 16-hex content hash', () => {
    expect(hashRows([['A', 1]])).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('buildFigureManifest (ITEM-6 / ITEM-7)', () => {
  const m = buildFigureManifest(base, () => '2026-07-24T00:00:00.000Z')
  it('captures cell, dataset id + content hash', () => {
    expect(m.cell).toEqual({ id: 'violin-1', kind: 'violin' })
    expect(m.data.datasetId).toBe('ds-42')
    expect(m.data.contentHash).toBe(hashRows(base.sourceRows!))
  })
  it('captures encoding + the full filter chain', () => {
    expect(m.encoding.colorBy?.colormap).toBe('viridis')
    expect(m.filters.valueRange).toEqual([0, 10])
    expect(m.filters.hiddenGroups).toEqual(['C'])
    expect(m.filters.link).toEqual([{ column: 'qc', range: [0, 5] }])
  })
  it('records the RNG seed + versions (reproducibility)', () => {
    expect(m.reproducibility).toEqual({ seed: 12345, toolVersion: 'txresbench-1.0.0', vizVersion: 'viz-0.9' })
  })
  it('injectable clock makes it deterministic', () => {
    expect(m.createdAt).toBe('2026-07-24T00:00:00.000Z')
  })
  it('no source rows ⇒ null content hash (still valid)', () => {
    const m2 = buildFigureManifest({ ...base, sourceRows: undefined })
    expect(m2.data.contentHash).toBeNull()
  })
  it('serializes to pretty JSON', () => {
    expect(JSON.parse(manifestToJSON(m)).schema).toBe('txresbench-viz-figure/1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ITEM-17 / CONV-7 — the manifest's `selection` field. CONV-7 fixed the per-cell manifest to
// record only its OWN identity space's ops (a multi-dataset grid would otherwise ship ops from a
// space that cannot explain the exported cell's points), but shipped with NO test: `manifest.ts`'s
// selection field had zero coverage and `buildFigureManifest` was untested for it, so the filter
// was unpinned and a future edit reverted it silently. CONV-12 closes that.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('buildFigureManifest — selection provenance (ITEM-17 / CONV-7)', () => {
  const opIn = (space: string) =>
    ({ tool: 'rect', op: 'add', pane: 'cell-1', space, region: [0, 0, 1, 1] }) as never

  it('omits `selection` entirely when the figure had none — schema unchanged', () => {
    const m = buildFigureManifest(base)
    expect('selection' in m).toBe(false)
    expect(m.schema).toBe('txresbench-viz-figure/1')
  })

  it('omits `selection` when the op list is empty rather than emitting an empty recipe', () => {
    const m = buildFigureManifest({ ...base, selection: { ops: [] } })
    expect('selection' in m).toBe(false)
  })

  it('records the ops + context when the figure was exported with a selection', () => {
    const context = { filters: { qc: [0, 5] } } as never
    const m = buildFigureManifest({ ...base, selection: { ops: [opIn('default')], context } })
    expect(m.selection?.ops).toHaveLength(1)
    expect(m.selection?.context).toEqual(context)
  })

  it('carries ONLY the ops handed to it — the caller filters by the cell\'s own space', () => {
    // The per-cell filter lives at the GridWorkspace call site (`wsProv.ops.filter(o => o.space
    // === cellSpace)`); the manifest must not silently widen what it was given back out again.
    const m = buildFigureManifest({ ...base, selection: { ops: [opIn('spaceB')] } })
    expect(m.selection?.ops.map(o => (o as { space: string }).space)).toEqual(['spaceB'])
  })

  it('copies the op list — a later mutation of the input cannot rewrite an exported manifest', () => {
    const ops = [opIn('default')]
    const m = buildFigureManifest({ ...base, selection: { ops } })
    ops.push(opIn('spaceB'))
    expect(m.selection?.ops).toHaveLength(1)
  })
})
