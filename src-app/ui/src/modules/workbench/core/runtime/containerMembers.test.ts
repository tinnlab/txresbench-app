// The DECLARED MEMBER GROUPS of a manifest container (issue #361) — unit tests for the pure
// resolver `resolveContainerMembers`.
//
// The fixtures carry NO domain vocabulary: every group and member name here is neutral. A
// fixture that spelled a real name would let an implementation that recognised that name
// pass, which is the tautology these specs exist to avoid.

import { describe, expect, it } from 'vitest'

import type { InputRequirements } from '@/core/datatypes/types'
import { resolveContainerMembers } from './containerMembers'

/** A manifest declaration over the given member paths. */
function manifest(members: string[]): InputRequirements {
  return { requires: 'manifest', members, allow_archive: true }
}

describe('resolveContainerMembers — the declared groups of a manifest container', () => {
  it('offers the distinct leading segments of a three-group member list, ordered by their embedded integer', () => {
    // The SHAPE the source exists for: several members under each of several groups, the
    // group name carrying the integer a picker binds. The names are neutral on purpose.
    const got = resolveContainerMembers(
      manifest([
        'group_002/one.csv',
        'group_002/two.csv',
        'group_002/three.csv',
        'group_002/four.csv',
        'group_008/one.csv',
        'group_008/two.csv',
        'group_008/three.csv',
        'group_008/four.csv',
        'group_016/one.csv',
        'group_016/two.csv',
        'group_016/three.csv',
        'group_016/four.csv',
      ]),
    )
    // NUMERIC order — 2, 8, 16 — never lexicographic ("group_016" < "group_002").
    expect(got).toEqual([
      { value: 2, label: 'group_002' },
      { value: 8, label: 'group_008' },
      { value: 16, label: 'group_016' },
    ])
  })

  it('a `requires: single` datatype offers nothing', () => {
    expect(resolveContainerMembers({ requires: 'single' })).toEqual([])
  })

  it('an absent declaration offers nothing', () => {
    expect(resolveContainerMembers(undefined)).toEqual([])
    expect(resolveContainerMembers(null)).toEqual([])
  })

  it('an empty member list offers nothing', () => {
    expect(resolveContainerMembers(manifest([]))).toEqual([])
  })

  it('a segment with NO digits falls back to the segment string and sorts lexicographically', () => {
    const got = resolveContainerMembers(manifest(['zeta/file.csv', 'alpha/file.csv', 'mid/file.csv']))
    expect(got).toEqual([
      { value: 'alpha', label: 'alpha' },
      { value: 'mid', label: 'mid' },
      { value: 'zeta', label: 'zeta' },
    ])
  })

  it('a segment with TWO digit runs falls back to the segment string', () => {
    const got = resolveContainerMembers(manifest(['part_2_of_8/file.csv']))
    expect(got).toEqual([{ value: 'part_2_of_8', label: 'part_2_of_8' }])
  })

  it('a MIXED set (numeric and non-numeric segments) sorts lexicographically by label', () => {
    // `group_002` and `group_008` embed integers; `plain` does not — so the whole offer
    // takes the label sort, and `group_002`'s value is still its integer.
    const got = resolveContainerMembers(manifest(['group_008/a.csv', 'plain/b.csv', 'group_002/c.csv']))
    expect(got).toEqual([
      { value: 2, label: 'group_002' },
      { value: 8, label: 'group_008' },
      { value: 'plain', label: 'plain' },
    ])
  })

  it('duplicate members collapse to one option', () => {
    const got = resolveContainerMembers(manifest(['group_008/a.csv', 'group_008/b.csv', 'group_008/c.csv']))
    expect(got).toEqual([{ value: 8, label: 'group_008' }])
  })

  it('members with deeper paths still group on the leading segment only', () => {
    const got = resolveContainerMembers(
      manifest(['group_008/a/b/c.h5', 'group_008/x/y.h5', 'group_016/a/b/c.h5']),
    )
    expect(got).toEqual([
      { value: 8, label: 'group_008' },
      { value: 16, label: 'group_016' },
    ])
  })

  it('a member with NO slash is not a group — root-level members are ignored entirely', () => {
    // A member that sits at the container's ROOT (no `/`) has no leading path segment,
    // so it is not a group. One root member embeds a digit run and one does not —
    // either would mint a bogus option if the whole filename were treated as a group —
    // and both must be ignored, leaving only the grouped members, in numeric order,
    // with numeric values.
    const got = resolveContainerMembers(
      manifest([
        'group_008/a.csv',
        'plain.csv', // root-level, no digit run
        'part_5.h5', // root-level, exactly one digit run
        'group_002/b.csv',
      ]),
    )
    expect(got).toEqual([
      { value: 2, label: 'group_002' },
      { value: 8, label: 'group_008' },
    ])
  })

  it('two segments mapping to the SAME integer are de-duplicated by value — an ambiguous offer is not emitted', () => {
    // `group_008` and `group_8` both embed 8. The renderer stringifies option values
    // (`String(rec.value)`), so both rows would become `"8"` and the widget's label
    // lookup would `find` the FIRST — a user picking the second row would see the
    // first row's label. Two options indistinguishable to the widget are an ambiguous
    // offer, so the resolver keeps the FIRST declared segment and drops the collision.
    const got = resolveContainerMembers(manifest(['group_008/a.csv', 'group_8/b.csv']))
    expect(got).toEqual([{ value: 8, label: 'group_008' }])
  })

  it('a segment that is entirely one digit run yields that integer', () => {
    expect(resolveContainerMembers(manifest(['8/file.csv']))).toEqual([{ value: 8, label: '8' }])
  })

  it('a leading zero in the run does not survive into the integer value', () => {
    expect(resolveContainerMembers(manifest(['group_008/file.csv']))).toEqual([
      { value: 8, label: 'group_008' },
    ])
  })
})
