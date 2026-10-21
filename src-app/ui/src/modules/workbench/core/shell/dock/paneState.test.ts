import { describe, it, expect, beforeEach } from 'vitest'
import { setPaneState, getPaneState, clearPaneState, __resetPaneState } from './paneState'

// TEST-228 (ITEM-19, Arch A) — per-pane content state is keyed by PANE ID (never by slot /
// container), so a movePane / pop-out / return (the pane id is stable through every move) leaves
// the state entry intact + reattached to the same id.
//
// The pane→entity BINDING assertions that used to live here went with the registry they covered:
// a pane's entity is derived from its `ref` now, and `entityLifecycle.test.ts` asserts the
// property that registry was there to serve (a bound pane self-closes when its artifact goes).
describe('paneState (ITEM-19)', () => {
  beforeEach(() => __resetPaneState())

  it('keys content state by pane id — a move (same id) leaves it intact; unrelated panes untouched', () => {
    setPaneState('pane-1', { scroll: 42 })
    setPaneState('pane-2', { value: 'x' })
    // A movePane / pop-out / return does NOT change the pane id, so the entry is still there.
    expect(getPaneState('pane-1')).toEqual({ scroll: 42 })
    setPaneState('pane-1', { entered: 7 }) // merge, not replace
    expect(getPaneState('pane-1')).toEqual({ scroll: 42, entered: 7 })
    clearPaneState('pane-2') // closing an unrelated pane
    expect(getPaneState('pane-1')).toEqual({ scroll: 42, entered: 7 })
    expect(getPaneState('pane-2')).toBeUndefined()
  })

  it('clearPaneState drops the closed pane state and leaves the others alone', () => {
    setPaneState('pane-1', { scroll: 1 })
    setPaneState('pane-9', { scroll: 9 })
    clearPaneState('pane-1')
    expect(getPaneState('pane-1')).toBeUndefined()
    expect(getPaneState('pane-9')).toEqual({ scroll: 9 })
  })
})
