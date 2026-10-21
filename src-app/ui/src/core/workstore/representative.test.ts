// The representative rule — the ONE choice of which group member's declarations ship.
//
// Every test here is written against a property the OLD rule (`size_bytes DESC, id`)
// did not have, so passing means the rule actually changed rather than the assertions
// having been rewritten around whatever the code does. The two that carry the most
// weight are `sizeDoesNotDecide` (the negative control for the whole change: the losing
// row is deliberately the biggest by an order of magnitude) and `reproducible` (the
// property `gen_random_uuid()` tiebreaking never had — the old rule could not pass it
// even in principle).

import { describe, expect, it } from 'vitest'

import type { DatasetArtifactGroup, ListedArtifact } from '@/api-client/types'
import { declaresSomething, preferredGroup, representativeOf } from './representative'

let seq = 0
function row(partial: Partial<ListedArtifact> = {}): ListedArtifact {
  seq += 1
  return {
    id: `id-${seq}`,
    content_hash: `sha256:${seq}`,
    created_at: '2026-07-15T00:00:00Z',
    datatype: 'probe/alpha',
    hidden: false,
    is_multifile: false,
    meta: {},
    object_key: `key-${seq}`,
    output_id: `out-${seq}`,
    role: 'artifact',
    logical_bytes: 1,
    source_dataset_ids: [],
    source_dataset_names: [],
    status: 'ready',
    structure: {},
    updated_at: '2026-07-15T00:00:00Z',
    ...partial,
  } as ListedArtifact
}

function group(partial: Partial<DatasetArtifactGroup> = {}): DatasetArtifactGroup {
  return {
    datatype: 'probe/alpha',
    count: 1,
    logical_bytes: 1,
    representative_output_id: 'out',
    representative_meta: {},
    representative_structure: {},
    ...partial,
  }
}

describe('declaresSomething', () => {
  it('treats ONLY the empty object as silence — the server\'s `<> \'{}\'::jsonb`', () => {
    expect(declaresSomething({})).toBe(false)
    expect(declaresSomething({ dims: [3, 4] })).toBe(true)
    // jsonb `null`, `[]` and scalars are all `<> '{}'` server-side, so they are
    // statements here too. Getting this wrong would make the TS rule disagree with the
    // SQL one on rows the server can genuinely store.
    expect(declaresSomething(null)).toBe(true)
    expect(declaresSomething([])).toBe(true)
    expect(declaresSomething(0)).toBe(true)
  })
})

describe('representativeOf', () => {
  it('prefers the member that DECLARES a structure', () => {
    const bare = row({ output_id: 'bare', structure: {} })
    const declared = row({ output_id: 'declared', structure: { dims: [3460, 32738] } })
    expect(representativeOf([bare, declared]).output_id).toBe('declared')
    expect(representativeOf([declared, bare]).output_id).toBe('declared')
  })

  // THE NEGATIVE CONTROL for the whole change. Under the old rule the 9 000-byte row
  // won on size and shipped an empty declaration; under the new one it loses to a
  // 1-byte row that actually says something. A rule still keyed on size fails here.
  it('does NOT let size decide — the biggest row loses when it declares nothing', () => {
    const huge = row({ output_id: 'huge', logical_bytes: 9_000, structure: {}, meta: {} })
    const tiny = row({ output_id: 'tiny', logical_bytes: 1, structure: { dims: [2] } })
    const chosen = representativeOf([huge, tiny])
    expect(chosen.output_id).toBe('tiny')
    expect(chosen.structure).toEqual({ dims: [2] })
  })

  it('falls to meta when neither declares a structure', () => {
    const bare = row({ output_id: 'bare', logical_bytes: 9_000 })
    const withMeta = row({ output_id: 'meta', logical_bytes: 1, meta: { label: 'x' } })
    expect(representativeOf([bare, withMeta]).output_id).toBe('meta')
  })

  it('prefers the MOST RECENT among members that declare equally well', () => {
    const older = row({
      output_id: 'older',
      created_at: '2026-01-01T00:00:00Z',
      structure: { dims: [1] },
    })
    const newer = row({
      output_id: 'newer',
      created_at: '2026-09-01T00:00:00Z',
      structure: { dims: [2] },
    })
    expect(representativeOf([older, newer]).output_id).toBe('newer')
    expect(representativeOf([newer, older]).output_id).toBe('newer')
  })

  it('breaks a full tie by output_id, then id', () => {
    const z = row({ id: 'id-aaa', output_id: 'zzz' })
    const a = row({ id: 'id-zzz', output_id: 'aaa' })
    expect(representativeOf([z, a]).output_id).toBe('aaa')

    const first = row({ id: 'id-aaa', output_id: 'same' })
    const second = row({ id: 'id-bbb', output_id: 'same' })
    expect(representativeOf([second, first]).id).toBe('id-aaa')
  })

  // The property the old rule could not have: `id` was `gen_random_uuid()`, so two
  // ingests of identical data picked different representatives. Here the ONLY thing that
  // varies between the two calls is input order and the ids, which is exactly what a
  // re-ingest varies.
  it('is reproducible: identical data in any order yields the identical representative', () => {
    const make = (ids: string[]) =>
      ids.map((id, i) =>
        row({
          id,
          output_id: `slot-${i}`,
          logical_bytes: 100,
          created_at: '2026-07-15T00:00:00Z',
          structure: { dims: [i] },
        }),
      )
    const runA = representativeOf(make(['id-fff', 'id-aaa', 'id-mmm']))
    const runB = representativeOf(make(['id-zzz', 'id-bbb', 'id-ccc']).reverse())
    expect(runA.output_id).toBe('slot-0')
    expect(runB.output_id).toBe('slot-0')
  })

  it('returns the single member of a one-row group', () => {
    const only = row({ output_id: 'only' })
    expect(representativeOf([only]).output_id).toBe('only')
  })
})

describe('preferredGroup', () => {
  it('prefers the group whose representative declares a structure', () => {
    const bare = group({ representative_output_id: 'bare', logical_bytes: 9_000, count: 9 })
    const declared = group({
      representative_output_id: 'declared',
      logical_bytes: 1,
      count: 1,
      representative_structure: { dims: [4] },
    })
    expect(preferredGroup(bare, declared).representative_output_id).toBe('declared')
    expect(preferredGroup(declared, bare).representative_output_id).toBe('declared')
  })

  // The rollup's negative control: bytes used to decide here too.
  it('does NOT let size decide — the count stands in for recency', () => {
    const many = group({ representative_output_id: 'many', count: 12, logical_bytes: 1 })
    const heavy = group({ representative_output_id: 'heavy', count: 2, logical_bytes: 9_000 })
    expect(preferredGroup(heavy, many).representative_output_id).toBe('many')
    expect(preferredGroup(many, heavy).representative_output_id).toBe('many')
  })

  it('is order-independent on a full tie, breaking by representative_output_id', () => {
    const a = group({ representative_output_id: 'aaa' })
    const b = group({ representative_output_id: 'bbb' })
    expect(preferredGroup(a, b).representative_output_id).toBe('aaa')
    expect(preferredGroup(b, a).representative_output_id).toBe('aaa')
  })
})
