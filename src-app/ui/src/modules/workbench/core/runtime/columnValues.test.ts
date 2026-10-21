// READ EXACTLY THESE COLUMNS (visualize-pane ITEM-31 / ITEM-36 / DEC-9) — the values half of
// the emit model, and the place its id-uniqueness rule is decided.
//
// What is pinned here is mostly ABSENCE and IDENTITY: how few bodies are read, that two plots
// never merge into one, and that a bad record costs its own plot and no other's. The fixtures
// carry no domain vocabulary.

import { describe, expect, it, vi } from 'vitest'

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { readColumnValues, toColumnRequests } from './columnValues'

function row(id: string, name?: string, members = 1): ArtifactRow {
  return {
    id,
    project_id: 'p',
    datatype: 'demo/column',
    ...(name !== undefined ? { meta: { name } } : {}),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'entities',
      members: Array.from({ length: members }, (_, i) => ({ name: members === 1 ? 'values' : `m${i}`, path: 'p' })),
    },
    created_at: '2026-01-01T00:00:00Z',
  } as ArtifactRow
}

describe('toColumnRequests — the KEY is the position, so two plots cannot merge into one', () => {
  it('keys by INDEX when a record names no key of its own', () => {
    // DEC-9: pressing one row's ▶ twice opens a SECOND plot. Two records then name ONE artifact,
    // and a key derived from the artifact would merge them — which under a per-GRID `setOption`
    // cannot be REFUSED either, so uniqueness has to hold at derivation.
    const got = toColumnRequests([{ artifact: 'a' }, { artifact: 'a' }])
    expect(got.map(r => r.key)).toEqual(['0', '1'])
    expect(new Set(got.map(r => r.key)).size).toBe(2)
  })

  it('honours a record’s OWN key when it carries one', () => {
    expect(toColumnRequests([{ key: 'k', artifact: 'a' }])[0].key).toBe('k')
  })

  it('drops a malformed record WITHOUT renumbering its neighbours', () => {
    // A dropped record must not shift the key of a plot that is already open: the pane bound to
    // key "2" would silently start drawing a different column.
    const got = toColumnRequests([{ artifact: 'a' }, { nope: true }, { artifact: 'b' }])
    expect(got.map(r => [r.key, r.artifact])).toEqual([
      ['0', 'a'],
      ['2', 'b'],
    ])
  })

  it('answers EMPTY for a non-list, rather than throwing the section down', () => {
    for (const v of [undefined, null, 'x', 3, {}]) expect(toColumnRequests(v)).toEqual([])
  })
})

describe('readColumnValues — one frame per requested plot', () => {
  it('reads each artifact ONCE however many plots name it', async () => {
    // The second click must cost no network. It is the same immutable artifact both times.
    const read = vi.fn(async () => ({ values: [1, 2, 3] }))
    const got = await readColumnValues([row('a', 'alpha')], toColumnRequests([{ artifact: 'a' }, { artifact: 'a' }]), read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(Object.keys(got).sort()).toEqual(['0', '1'])
    // …and the two plots are SEPARATE frames, not one shared object: a canvas dataset is also an
    // identity space, and two plots must brush independently.
    expect(got['0']).not.toBe(got['1'])
    expect(got['0']).toEqual(got['1'])
  })

  it('names the column what the CALLER’s row showed the user, never the storage member', async () => {
    // A single-column store writes its sole member under the constant path `values`, identical
    // for every column in the project — so a canvas binding `values` would bind whichever column
    // was read. The name the user pressed ▶ on is the one the encode must resolve.
    const read = vi.fn(async () => ({ values: ['x', 'y'] }))
    const got = await readColumnValues([row('a', 'alpha')], [{ key: '0', artifact: 'a', name: 'shown name' }], read)
    expect(Object.keys(got['0'])).toEqual(['shown name'])
  })

  it('falls back to the PRODUCER’s declared name when the caller supplies none', async () => {
    const read = vi.fn(async () => ({ values: [1] }))
    const got = await readColumnValues([row('a', 'alpha')], [{ key: '0', artifact: 'a' }], read)
    expect(Object.keys(got['0'])).toEqual(['alpha'])
  })

  it('keeps a MULTI-member artifact’s own column names', async () => {
    const read = vi.fn(async () => ({ m0: [1], m1: [2] }))
    const got = await readColumnValues([row('a', 'alpha', 2)], [{ key: '0', artifact: 'a' }], read)
    expect(Object.keys(got['0']).sort()).toEqual(['m0', 'm1'])
  })

  it('one unreadable artifact costs its OWN plots and no other', async () => {
    // The tolerance the axis-columns frame reader already has, for the same reason: one column
    // that will not read must not take the other pictures off the canvas.
    const read = vi.fn(async (r: ArtifactRow) => {
      if (r.id === 'bad') throw new Error('nope')
      return { values: [1] }
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const got = await readColumnValues(
        [row('good', 'g'), row('bad', 'b')],
        toColumnRequests([{ artifact: 'bad' }, { artifact: 'good' }]),
        read,
      )
      expect(Object.keys(got)).toEqual(['1'])
      expect(err).toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
  })

  it('a request naming an artifact the catalog no longer holds is simply absent', async () => {
    // An artifact deleted under an open plot is a real situation; the honest answer is that this
    // plot has nothing to draw, not that the slice failed.
    const read = vi.fn(async () => ({ values: [1] }))
    const got = await readColumnValues([row('a', 'alpha')], toColumnRequests([{ artifact: 'gone' }]), read)
    expect(got).toEqual({})
    expect(read).not.toHaveBeenCalled()
  })

  it('reads NOTHING for an empty list', async () => {
    const read = vi.fn(async () => ({ values: [1] }))
    expect(await readColumnValues([row('a', 'alpha')], [], read)).toEqual({})
    expect(read).not.toHaveBeenCalled()
  })
})
