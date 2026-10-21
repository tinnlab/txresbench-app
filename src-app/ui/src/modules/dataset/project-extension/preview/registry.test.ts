// The preview CONTRIBUTION registry: resolution up the lattice, and containment.
//
// Every fixture id here is neutral (`probe/*`). That is the point of the seam under
// test: the resolver must work purely off the lattice it is handed, so a fixture
// naming a real datatype would be testing nothing the code knows about.

import { describe, expect, it, vi } from 'vitest'
import type { DatasetArtifactGroup } from '@/api-client/types'
import { DatasetPreviewRegistry } from './registry'
import type { PreviewLattice } from './types'

/** `probe/leaf` is-a `probe/mid` is-a `probe/root`; `probe/lone` has no parent. */
const lattice: PreviewLattice = {
  ancestors: (id: string) =>
    ({
      'probe/leaf': ['probe/mid', 'probe/root'],
      'probe/mid': ['probe/root'],
      'probe/root': [],
      'probe/lone': [],
    })[id] ?? [],
}

const group = (datatype: string, count = 1): DatasetArtifactGroup => ({
  datatype,
  count,
  logical_bytes: 10,
  representative_output_id: 'primary',
  representative_meta: {},
  representative_structure: {},
})

/** The title the app resolves for the group under test — neutral, like every id
 *  here. The registry only CARRIES it; what a contribution does with it is
 *  `declared.ts`'s business. */
const TITLE = 'Probe thing'

const says = (datatype: string, text: string, order = 1) => ({
  datatype,
  order,
  phrase: () => text,
})

describe('DatasetPreviewRegistry', () => {
  it('resolves an EXACT registration over a registered ancestor', () => {
    const r = new DatasetPreviewRegistry()
    r.register(says('probe/root', 'root'))
    r.register(says('probe/leaf', 'leaf'))
    expect(r.phraseFor(group('probe/leaf'), lattice, TITLE)?.text).toBe('leaf')
  })

  it('falls back UP the lattice, nearest ancestor first', () => {
    const r = new DatasetPreviewRegistry()
    r.register(says('probe/root', 'root'))
    r.register(says('probe/mid', 'mid'))
    // No exact registration for the leaf → the NEAREST registered ancestor wins.
    expect(r.phraseFor(group('probe/leaf'), lattice, TITLE)?.text).toBe('mid')
    // With only the far one registered, that one applies.
    const far = new DatasetPreviewRegistry()
    far.register(says('probe/root', 'root'))
    expect(far.phraseFor(group('probe/leaf'), lattice, TITLE)?.text).toBe('root')
  })

  it('carries the ORDER the matching contribution declared', () => {
    const r = new DatasetPreviewRegistry()
    r.register(says('probe/root', 'root', 42))
    // Inherited down the lattice too — position is part of what a supertype's
    // contribution decides on behalf of its subtypes.
    expect(r.phraseFor(group('probe/leaf'), lattice, TITLE)?.order).toBe(42)
  })

  it('answers null for a datatype nothing along the chain contributes for', () => {
    const r = new DatasetPreviewRegistry()
    r.register(says('probe/root', 'root'))
    // NEGATIVE CONTROL: `probe/lone` is outside that chain entirely. A resolver that
    // ignored the lattice and answered with "any registration" would fail here.
    expect(r.phraseFor(group('probe/lone'), lattice, TITLE)).toBeNull()
    // …and the positive control proves the registry is not simply always empty.
    expect(r.phraseFor(group('probe/root'), lattice, TITLE)?.text).toBe('root')
  })

  it('CONTAINS a contribution that throws — the picker must not be takeable down', () => {
    const r = new DatasetPreviewRegistry()
    r.register({
      datatype: 'probe/root',
      order: 7,
      phrase: () => {
        throw new Error('contribution blew up')
      },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => r.phraseFor(group('probe/leaf'), lattice, TITLE)).not.toThrow()
    // A throw is a DECLINE, not an absence: the position it declared survives, so a
    // broken contribution cannot silently re-order the rest of the line.
    expect(r.phraseFor(group('probe/leaf'), lattice, TITLE)).toEqual({ order: 7, text: null })
    expect(spy).toHaveBeenCalled() // contained, but not invisible
    spy.mockRestore()
  })

  it('treats a contribution that returns nothing at all as a decline', () => {
    const r = new DatasetPreviewRegistry()
    r.register({
      datatype: 'probe/root',
      order: 3,
      phrase: () => undefined as unknown as string,
    })
    expect(r.phraseFor(group('probe/root'), lattice, TITLE)).toEqual({ order: 3, text: null })
  })

  it("hands the contribution THIS group's title — the one the caller resolved", () => {
    // The registry resolves a contribution up the lattice but must not resolve the
    // NAME up it: a supertype's contribution answering for a subtype has to be told
    // the SUBTYPE's word, or one declaration silently mislabels a whole branch.
    const seen: Array<[string, string]> = []
    const r = new DatasetPreviewRegistry()
    r.register({
      datatype: 'probe/root',
      order: 1,
      phrase: (g, title) => {
        seen.push([g.datatype, title])
        return title
      },
    })
    expect(r.phraseFor(group('probe/leaf'), lattice, 'Leaf title')?.text).toBe('Leaf title')
    expect(r.phraseFor(group('probe/root'), lattice, 'Root title')?.text).toBe('Root title')
    expect(seen).toEqual([
      ['probe/leaf', 'Leaf title'],
      ['probe/root', 'Root title'],
    ])
  })

  it('replaces a registration for the same datatype, and clears', () => {
    const r = new DatasetPreviewRegistry()
    r.register(says('probe/root', 'first'))
    r.register(says('probe/root', 'second'))
    expect(r.size).toBe(1)
    expect(r.phraseFor(group('probe/root'), lattice, TITLE)?.text).toBe('second')
    r.clear()
    expect(r.size).toBe(0)
    expect(r.phraseFor(group('probe/root'), lattice, TITLE)).toBeNull()
  })
})
