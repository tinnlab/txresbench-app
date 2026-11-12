// TEST-532 (ITEM-63) — the before/after diff builder over two runs' outputs computes
// added/removed/changed rows + identical-output detection, and the observable
// extraction pulls HONEST scalars (the artifact's DECLARED dimensions, per-kind output
// count) from the artifact records only (no blob read).
//
// artifact-model ITEM-7: the dimensions come from the producer's `structure`, not the
// dropped `shape` column, so the fixtures below DECLARE what they are — a table declares
// the entries on its shared axis, a CSC matrix declares `[rows, columns]`.

import { describe, expect, it } from 'vitest'
import type { Artifact } from '@/api-client/types'
import { artifactDims, buildRunDiff, runObservables } from './runDiff'

/** A `zarr_v3` table over `n` entries of one axis, with TWO members — no single member
 *  shape describes it, so its extent is the shared axis (`txr_zarr.Table.close()`). */
function table(n: number): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'table',
    axis: 'entries',
    n,
    columns: [
      { path: 'key', kind: 'string', shape: [n] },
      { path: 'values', kind: 'numeric', shape: [n] },
    ],
  }
}

/** A single-member table holding one `(n × dims)` array — the form a 2-D layout takes
 *  (`txr_zarr.Table` with one N-D member). */
function layout(n: number, dims: number): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'table',
    axis: 'entries',
    n,
    arrays: [{ path: 'coords', kind: 'numeric', shape: [n, dims] }],
  }
}

/** A `zarr_v3` CSC matrix declaring its logical extent (`txr_csc.write_csc_zarr`). */
function csc(shape: number[]): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'sparse_csc',
    shape,
    nnz: 0,
    indptr: { path: 'indptr' },
    indices: { path: 'indices' },
    data: { path: 'data' },
  }
}

function artifact(over: Partial<Artifact> & Pick<Artifact, 'id' | 'datatype'>): Artifact {
  return {
    content_hash: 'h',
    created_at: '2026-07-15T00:00:00Z',
    is_multifile: false,
    meta: null,
    object_key: 'k',
    output_id: 'o',
    role: 'artifact',
    run_id: 'run-1',
    logical_bytes: 0,
    status: 'ready',
    structure: { encoding: 'opaque', media_type: 'application/octet-stream' },
    updated_at: '2026-07-15T00:00:00Z',
    ...over,
  } as Artifact
}

describe('artifactDims — the DECLARED dimensions (TEST-532 / ITEM-7)', () => {
  it('reads a multi-member table as its shared-axis entry count and a CSC as its declared extent', () => {
    expect(artifactDims({ id: 'a', structure: table(4800) })).toEqual([4800])
    expect(artifactDims({ id: 'b', structure: csc([4800, 20000]) })).toEqual([4800, 20000])
  })

  it("reads a SINGLE-member table as that member's own declared shape", () => {
    // A 2-D layout is one `(n × dims)` array; `[5000, 2]` is what the artifact IS, and
    // reporting only the shared axis would drop a dimension the producer stated.
    expect(artifactDims({ id: 'lay', structure: layout(5000, 2) })).toEqual([5000, 2])
  })

  it('never truncates the declared list to two dims (E3)', () => {
    // The E3 defect was a reader that only ever reported dim0/dim1. The dimension list is
    // the PRODUCER's — however many it declares is how many are reported.
    expect(artifactDims({ id: 'c', structure: csc([512, 512, 3]) })).toEqual([512, 512, 3])
  })

  it('yields no dimensions for an opaque blob — it declares an extent nowhere', () => {
    expect(
      artifactDims({ id: 'd', structure: { encoding: 'opaque', media_type: 'application/json' } }),
    ).toEqual([])
  })

  it('yields no dimensions — never an invented 0 — when the declaration cannot be read', () => {
    // A display surface omits the segment; it does NOT render `dim0: 0`, which would
    // assert a fact the producer never stated (INV-2).
    expect(artifactDims({ id: 'e', structure: null })).toEqual([])
    expect(artifactDims({ id: 'f', structure: { encoding: 'parquet' } })).toEqual([])
    expect(artifactDims({ id: 'g', structure: { encoding: 'zarr_v3' } })).toEqual([])
  })
})

describe('runObservables — honest declaration-derived scalars (TEST-532)', () => {
  it('extracts per-kind output count + EVERY declared dimension, keyed by position (E3)', () => {
    const obs = runObservables([
      artifact({ id: 'a', datatype: 'clustering', structure: table(4800) }),
      artifact({ id: 'b', datatype: 'anndata', structure: csc([4800, 20000]) }),
      // E3: a 3-D artifact used to lose everything past dim1.
      artifact({ id: 'c', datatype: 'raster', structure: csc([512, 512, 3]) }),
    ])
    expect(obs).toEqual({
      outputs: 3,
      'clustering · outputs': 1,
      'clustering · dim0': 4800,
      'anndata · outputs': 1,
      'anndata · dim0': 4800,
      'anndata · dim1': 20000,
      'raster · outputs': 1,
      'raster · dim0': 512,
      'raster · dim1': 512,
      'raster · dim2': 3,
    })
  })

  it('omits every dimension row when the artifact declares no extent', () => {
    const obs = runObservables([
      artifact({
        id: 'a',
        datatype: 'report',
        structure: { encoding: 'opaque', media_type: 'application/json' },
      }),
    ])
    expect(obs).toEqual({ outputs: 1, 'report · outputs': 1 })
  })
})

describe('buildRunDiff — added/removed/changed + identical (TEST-532)', () => {
  it('classifies each observable and computes deltas', () => {
    const before = runObservables([
      artifact({ id: 'a', datatype: 'anndata', structure: csc([5000, 20000]) }),
    ])
    const after = runObservables([
      artifact({ id: 'b', datatype: 'anndata', structure: csc([4200, 20000]) }),
      artifact({ id: 'c', datatype: 'clustering', structure: table(4200) }),
    ])
    const diff = buildRunDiff(before, after)
    // dim0 fell 5000 → 4200 (a changed row with a negative delta).
    const dim0 = diff.rows.find(r => r.key === 'anndata · dim0')!
    expect(dim0).toMatchObject({ status: 'changed', before: 5000, after: 4200, delta: -800 })
    // the clustering kind is NEW in the after run (added rows).
    expect(diff.added).toContain('clustering · dim0')
    expect(diff.changed).toContain('outputs') // 1 → 2
    expect(diff.removed).toEqual([])
    expect(diff.identical).toBe(false)
  })

  it('detects two runs with identical outputs (a no-op tweak)', () => {
    const obs = runObservables([
      artifact({ id: 'a', datatype: 'anndata', structure: csc([5000, 20000]) }),
    ])
    const diff = buildRunDiff(
      obs,
      runObservables([artifact({ id: 'z', datatype: 'anndata', structure: csc([5000, 20000]) })]),
    )
    expect(diff.identical).toBe(true)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.rows.every(r => r.status === 'same')).toBe(true)
  })

  it('marks a removed observable when a kind disappears', () => {
    const before = runObservables([
      artifact({ id: 'a', datatype: 'clustering', structure: table(5000) }),
    ])
    const after = runObservables([
      artifact({ id: 'b', datatype: 'anndata', structure: csc([5000, 100]) }),
    ])
    const diff = buildRunDiff(before, after)
    expect(diff.removed).toContain('clustering · dim0')
    expect(diff.added).toContain('anndata · dim1')
  })
})
