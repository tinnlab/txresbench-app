/**
 * TEST-MOD-20 — the one-table expansion store (`lib/setExpansion.ts`):
 * the module-level open-set state the set-row chevron writes (ONE-TABLE
 * round). Pinned: sets are CLOSED at birth (an empty store), the toggle is
 * the one mutation (flip + the new state), the snapshot is a fresh Set
 * (the builder's contract — a caller mutating it cannot corrupt the
 * store), and `clear` returns the birth state (never called by the app —
 * the store survives unmount on purpose; the tests use it as the reset).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSetExpansion,
  expandedSetSnapshot,
  isSetExpanded,
  toggleSetExpanded,
} from './setExpansion'

describe('setExpansion — the one-table open-set store (TEST-MOD-20)', () => {
  beforeEach(() => clearSetExpansion())

  it('starts closed (no set expanded) and the snapshot is a fresh Set', () => {
    expect(expandedSetSnapshot().size).toBe(0)
    expect(isSetExpanded('set-a')).toBe(false)
    const snapshot = expandedSetSnapshot()
    snapshot.add('set-a')
    // Mutating the snapshot never corrupts the store.
    expect(expandedSetSnapshot().size).toBe(0)
  })

  it('toggles one set and returns the new state (the page reveal reads it)', () => {
    expect(toggleSetExpanded('set-a')).toBe(true)
    expect(isSetExpanded('set-a')).toBe(true)
    expect(expandedSetSnapshot()).toEqual(new Set(['set-a']))
    expect(toggleSetExpanded('set-a')).toBe(false)
    expect(expandedSetSnapshot().size).toBe(0)
    // Independent sets: one toggle never touches the other.
    toggleSetExpanded('set-a')
    toggleSetExpanded('set-b')
    expect(expandedSetSnapshot()).toEqual(new Set(['set-a', 'set-b']))
  })

  it('clear returns the birth state', () => {
    toggleSetExpanded('set-a')
    clearSetExpansion()
    expect(expandedSetSnapshot().size).toBe(0)
    expect(isSetExpanded('set-a')).toBe(false)
  })
})
