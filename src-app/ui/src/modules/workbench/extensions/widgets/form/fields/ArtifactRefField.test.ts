// TEST-404 (ITEM-35) — the artifact-ref picker's enriched option-label formatter.
// Written in VITEST style (`describe/it/expect`) — the app's `npm run vitest` pass
// only GATES on vitest-registered tests (a `node:test` file reports "no tests" under
// vitest), so the enrichment logic is asserted by the runner the verify step uses.
import { describe, it, expect } from 'vitest'
import type { ArtifactRow } from '@/modules/workbench/extensions/data'
import {
  formatArtifactOption,
  formatArtifactOptionWithDataset,
  formatDims,
  formatRelativeTime,
  groupRowsByDataset,
  shouldGroupByDataset,
  NO_SOURCE_DATASET_GROUP,
} from './artifactLabel'

const NOW = Date.parse('2026-07-19T12:00:00Z')

/** A single-member `(n × dims)` table — the form a 2-D layout artifact declares.
 *  ITEM-7: the label's dimensions come off `structure`, not the dropped `shape`. The
 *  axis is named neutrally on purpose: the formatter must never depend on the NAME. */
const LAYOUT_STRUCTURE = {
  encoding: 'zarr_v3',
  kind: 'table',
  axis: 'entries',
  n: 5000,
  arrays: [{ path: 'coords', kind: 'numeric', shape: [5000, 2] }],
}

function row(partial: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: '00000000-0000-4000-8000-0000000000e2',
    project_id: 'p1',
    datatype: 'embedding',
    structure: LAYOUT_STRUCTURE,
    created_at: '2026-07-16T12:00:00Z', // 3 days before NOW
    ...partial,
  }
}

describe('formatDims', () => {
  it('renders a dimension list as a ×-joined string', () => {
    expect(formatDims([5000, 2])).toBe('5000×2')
    expect(formatDims([5000])).toBe('5000')
  })
  it('degrades to null when the artifact declared no dimensions', () => {
    expect(formatDims([])).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  it('buckets into just-now / m / h / d / mo / y', () => {
    expect(formatRelativeTime('2026-07-19T11:59:30Z', NOW)).toBe('just now')
    expect(formatRelativeTime('2026-07-19T11:30:00Z', NOW)).toBe('30m ago')
    expect(formatRelativeTime('2026-07-19T09:00:00Z', NOW)).toBe('3h ago')
    expect(formatRelativeTime('2026-07-16T12:00:00Z', NOW)).toBe('3d ago')
    expect(formatRelativeTime('2026-05-19T12:00:00Z', NOW)).toBe('2mo ago')
    expect(formatRelativeTime('2024-07-19T12:00:00Z', NOW)).toBe('2y ago')
  })
  it('degrades to null for an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBeNull()
  })
})

describe('formatArtifactOption', () => {
  it('builds `datatype · dimensions · relative-date` from an ArtifactRow', () => {
    expect(formatArtifactOption(row({}), NOW)).toBe('embedding · 5000×2 · 3d ago')
  })
  // THE FLOOR MOVED, ON PURPOSE — the last line used to assert the datatype ALONE.
  //
  // The formatter is now the SHARED one (`@/core/workstore/artifactLabel`), converged with the
  // rival in `provenance/lineageGraph.ts` that spelled the same fact `datatype · id8`. Its rule
  // appends the short id when NOTHING else distinguishes the row — which is what makes the
  // lineage DAG's label byte-identical to what it drew before, and what stops a picker of six
  // undated, structureless artifacts of ONE datatype rendering six identical strings.
  it('degrades when the artifact declares no extent, keeping the datatype floor', () => {
    // An `opaque` blob declares a media type and nothing else.
    const opaque = { encoding: 'opaque', media_type: 'application/json' }
    expect(formatArtifactOption(row({ structure: opaque }), NOW)).toBe('embedding · 3d ago')
    expect(formatArtifactOption(row({ structure: opaque, created_at: 'bogus' }), NOW)).toBe('embedding · 00000000')
  })
})

// ITEM-22 — group/label candidates by their DERIVED source dataset.
describe('shouldGroupByDataset', () => {
  it('is true iff ≥1 candidate carries a source dataset (else FLAT, back-compat)', () => {
    expect(shouldGroupByDataset([row({}), row({})])).toBe(false)
    expect(shouldGroupByDataset([row({}), row({ source_dataset_name: 'PBMC' })])).toBe(true)
  })
  it('counts a dataset whose NAME did not travel — the id alone is still a dataset', () => {
    // `source_dataset_id` and `source_dataset_name` are independently nullable. Reading
    // only the name made such a row invisible to grouping AND dropped it into the
    // no-source bucket, which the shared wording would state falsely.
    expect(shouldGroupByDataset([row({ source_dataset_id: 'dsA' })])).toBe(true)
  })
})

describe('groupRowsByDataset', () => {
  it('partitions candidates into named groups (alpha), with a trailing no-source group', () => {
    const a1 = row({ id: 'a1', source_dataset_id: 'dsB', source_dataset_name: 'Brain' })
    const a2 = row({ id: 'a2', source_dataset_id: 'dsA', source_dataset_name: 'Aorta' })
    const a3 = row({ id: 'a3', source_dataset_id: 'dsA', source_dataset_name: 'Aorta' })
    const orphan = row({ id: 'o1' }) // no provenance → no source dataset
    const groups = groupRowsByDataset([a1, a2, a3, orphan])
    // Named groups sorted alpha (Aorta before Brain), no-source last.
    expect(groups.map(g => g.label)).toEqual(['Aorta', 'Brain', NO_SOURCE_DATASET_GROUP])
    expect(groups[0]!.rows.map(r => r.id)).toEqual(['a2', 'a3']) // both Aorta candidates
    expect(groups[1]!.rows.map(r => r.id)).toEqual(['a1'])
    expect(groups[2]!.rows.map(r => r.id)).toEqual(['o1'])
  })
  it('omits the no-source group when every candidate has a source dataset', () => {
    const groups = groupRowsByDataset([row({ source_dataset_name: 'PBMC' })])
    expect(groups.map(g => g.label)).toEqual(['PBMC'])
  })
  it('titles a dataset whose NAME did not travel by its id, not as no-source', () => {
    const groups = groupRowsByDataset([
      row({ id: 'n1', source_dataset_id: 'dsA', source_dataset_name: 'Aorta' }),
      row({ id: 'u1', source_dataset_id: 'dsZ' }),
      row({ id: 'o1' }),
    ])
    expect(groups.map(g => g.label)).toEqual(['Aorta', 'dsZ', NO_SOURCE_DATASET_GROUP])
    expect(groups[1]!.rows.map(r => r.id)).toEqual(['u1'])
    expect(groups[2]!.rows.map(r => r.id)).toEqual(['o1'])
  })
})

describe('formatArtifactOptionWithDataset (flat MultiSelect label)', () => {
  it('prefixes the enriched label with the source-dataset name', () => {
    expect(formatArtifactOptionWithDataset(row({ source_dataset_name: 'PBMC' }), NOW)).toBe(
      'PBMC · embedding · 5000×2 · 3d ago',
    )
  })
  it('degrades to the plain label when there is no source dataset', () => {
    expect(formatArtifactOptionWithDataset(row({}), NOW)).toBe('embedding · 5000×2 · 3d ago')
  })
  it('prefixes the id when the dataset name did not travel — same rule as the heading', () => {
    // Composed from the plain label rather than restating it: what is under test is the
    // PREFIX rule, and spelling the base out again would pin the base formatter twice.
    expect(formatArtifactOptionWithDataset(row({ source_dataset_id: 'dsZ' }), NOW)).toBe(
      `dsZ · ${formatArtifactOption(row({}), NOW)}`,
    )
  })
})
