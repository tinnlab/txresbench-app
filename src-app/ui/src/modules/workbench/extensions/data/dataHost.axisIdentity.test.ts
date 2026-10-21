// The wire → `data` capability hop is the ONE place a project's axes cross into the
// workbench, and it is where the axis IDENTITY was being dropped: the wire carried
// `content_hash` (INV-3) and `toProjectCatalog` projected it away to `{name, length}`,
// so every consumer downstream had nothing but a label to key on.
//
// The discriminating fixture is again TWO AXES SHARING A LABEL: with the identity
// carried they arrive as two distinguishable axes; without it they are two rows a
// consumer can only tell apart by list position.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axesByHash } from './contract'

const getCatalog = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Workstore: {
      getCatalog: (...a: unknown[]) => getCatalog(...a),
      listArtifacts: async () => [],
      getArtifact: async () => ({}),
    },
  },
}))

const { createDataHost } = await import('./dataHost')

beforeEach(() => {
  getCatalog.mockReset()
})

describe('createDataHost().catalog — the axis identity survives the wire hop (INV-3)', () => {
  it('carries content_hash through, so two same-label axes stay TWO axes', async () => {
    getCatalog.mockResolvedValue({
      project_id: 'p1',
      axes: [
        { content_hash: 'hash-a', name: 'entries', length: 10 },
        { content_hash: 'hash-b', name: 'entries', length: 20 },
      ],
      artifacts: [],
    })

    const cat = await createDataHost().catalog('p1')

    expect(getCatalog).toHaveBeenCalledWith({ project_id: 'p1' })
    // Both axes present, each with ITS OWN identity and ITS OWN declared length — no
    // fold, no max, no "the first one called `entries`".
    expect(cat.axes).toEqual([
      { content_hash: 'hash-a', name: 'entries', length: 10 },
      { content_hash: 'hash-b', name: 'entries', length: 20 },
    ])
    // …and they are DISTINGUISHABLE downstream. This is the assertion a `{name,length}`
    // projection cannot satisfy: with the hash stripped, both key to `undefined` and the
    // map holds one entry whose length is whichever axis happened to be written last.
    const byHash = axesByHash(cat)
    expect(byHash.size).toBe(2)
    expect(byHash.get('hash-a')?.length).toBe(10)
    expect(byHash.get('hash-b')?.length).toBe(20)
  })

  it('tolerates a catalog with no axes at all (absence, not a crash)', async () => {
    getCatalog.mockResolvedValue({ project_id: 'p1', artifacts: [] })
    expect((await createDataHost().catalog('p1')).axes).toEqual([])
  })
})
