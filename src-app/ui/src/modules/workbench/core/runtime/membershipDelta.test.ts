// Unit coverage for the DOMAIN-FREE membership-diff (INV-7 / DEC-11). Proves the generic
// set/member delta a lineage view renders — added/removed whole sets, per-set member changes,
// order preservation, and total behaviour on malformed input. No domain noun: the value field
// name rides in as a param (here a neutral `values`).

import { describe, expect, it } from 'vitest'
import { computeMembershipDelta, isEmptyDelta } from './membershipDelta'

const OPTS = { valuesField: 'values' }

describe('computeMembershipDelta', () => {
  it('reports per-set added and removed members between two versions', () => {
    const parent = [{ name: 'T', values: ['A', 'B', 'C'] }]
    const current = [{ name: 'T', values: ['A', 'C', 'D'] }]
    const d = computeMembershipDelta(parent, current, OPTS)
    expect(d.changed).toEqual([{ name: 'T', added: ['D'], removed: ['B'] }])
    expect(d.addedSets).toEqual([])
    expect(d.removedSets).toEqual([])
  })

  it('detects whole-set additions and removals', () => {
    const parent = [{ name: 'T', values: ['A'] }, { name: 'B', values: ['X'] }]
    const current = [{ name: 'T', values: ['A'] }, { name: 'NK', values: ['Y'] }]
    const d = computeMembershipDelta(parent, current, OPTS)
    expect(d.addedSets).toEqual(['NK'])
    expect(d.removedSets).toEqual(['B'])
    // T is unchanged → omitted from `changed`.
    expect(d.changed).toEqual([])
  })

  it('preserves each version\'s own member order in the delta lists', () => {
    const parent = [{ name: 'S', values: ['a', 'b'] }]
    const current = [{ name: 'S', values: ['b', 'c', 'a'] }]
    const d = computeMembershipDelta(parent, current, OPTS)
    // `c` is the only addition; nothing removed (a is retained, b retained).
    expect(d.changed).toEqual([{ name: 'S', added: ['c'], removed: [] }])
  })

  it('an identical structure yields an empty (no-change) delta', () => {
    const sets = [{ name: 'S', values: ['a', 'b'] }]
    const d = computeMembershipDelta(sets, sets, OPTS)
    expect(isEmptyDelta(d)).toBe(true)
  })

  it('a first version (no parent) is all-additions, never a throw', () => {
    const current = [{ name: 'S', values: ['a'] }]
    const d = computeMembershipDelta(undefined, current, OPTS)
    expect(d.addedSets).toEqual(['S'])
    expect(isEmptyDelta(d)).toBe(false)
  })

  it('is total on malformed input (non-array structures degrade to empty sides)', () => {
    expect(isEmptyDelta(computeMembershipDelta(null, null, OPTS))).toBe(true)
    expect(isEmptyDelta(computeMembershipDelta({ not: 'an array' }, 42, OPTS))).toBe(true)
  })

  it('honours a custom nameField/valuesField (the domain names ride in as params)', () => {
    const parent = [{ label: 'S', items: ['a'] }]
    const current = [{ label: 'S', items: ['a', 'b'] }]
    const d = computeMembershipDelta(parent, current, { nameField: 'label', valuesField: 'items' })
    expect(d.changed).toEqual([{ name: 'S', added: ['b'], removed: [] }])
  })
})
