// THE PANE'S `axis` IS DERIVED — how it is written, and what may not write it.
//
// ── what this file used to be, and why none of that survives ──────────────────────────────
//
// It was TEST-15 (binding-origin / ITEM-8): *"the pane anchor's ORIGIN"*, site 4 of the four
// that bind. The pane's first block was a control that ASKED which rows the pane was about,
// it auto-bound the sole row space for the user, and the whole point of `axisOrigin` was that
// the one-option radio it then showed was indistinguishable from a choice a person had made.
//
// The owner's ruling (2026-08-13) is that the QUESTION does not exist — there is no such thing
// as a row space, and an axis is never a thing a user picks — so the control is deleted,
// § Coordinates is the pane's first block, and `$scope.axis` is DERIVED from the chosen
// coordinate set by `./coordinateAxis.ts::axisOfCoordinate`. With nobody choosing, there is no
// origin to record: `setAxis`/`axisOrigin` are gone, and every assertion about which of `auto`
// and `user` a value carried is an assertion about a facility that no longer exists.
//
// So the origin block is REPLACED, not deleted, by the contract that took its place. The
// property the old block protected — *a pane value must never be a confident answer nobody
// gave* — survives whole, and is now carried by three assertions instead of an origin tag:
// the derived axis FOLLOWS the coordinate, it does not destroy the choice it was derived from,
// and a view may not write it at all (a section writing `axis` would be asserting rows nothing
// declared, which is the same defect the origin tag existed to make visible).
//
// The last describe is untouched: `PaneScope` IS `$scope` in the declarative expression
// language, so a key added there would appear to every view spec and to every
// `aligned_to`/`axis` source resolution. That separation is asserted rather than promised.

import { describe, it, expect, beforeEach } from 'vitest'

import { paneScopeStore } from './paneScope.store.ts'

const PROJECT = 'p-1'
const OTHER = 'p-2'
const HASH_A = 'hash-a'
const HASH_B = 'hash-b'
const COORD_A = 'artifact-coord-a'

beforeEach(() => {
  paneScopeStore.getState().reset()
  paneScopeStore.getState().bindProject(PROJECT)
})

/** Run `body` with `console.error` captured — the store REPORTS a refused write, and a refusal
 *  nobody can hear is indistinguishable from a write that silently did nothing. */
function captureErrors(body: () => void): unknown[][] {
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    body()
  } finally {
    console.error = original
  }
  return errors
}

describe('the pane axis is DERIVED from the coordinate, not chosen', () => {
  it('setDerivedAxis writes the axis and does NOT destroy the coordinate it was derived from', () => {
    // The one behavioural difference from the deleted `setAxis`, and the reason it is a
    // different method rather than a rename: `setAxis` CLEARED `coordinate` on every change,
    // because an anchor change was a change to a question asked ABOVE the coordinate picker.
    // The dependency now runs the other way — the coordinate is the choice — so clearing it
    // here would destroy the choice in the act of recording its consequence.
    paneScopeStore.getState().setValue('coordinate', COORD_A)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    expect(paneScopeStore.getState().scope).toEqual({ axis: [HASH_A], coordinate: COORD_A })
  })

  it('the derived axis FOLLOWS the coordinate — a re-derivation replaces it', () => {
    // A new coordinate set re-runs the join, and the answer it produces is what the pane
    // carries. The stale-value defect the old origin tag made visible is prevented here by
    // there being no way for the axis to outlive the derivation that produced it.
    paneScopeStore.getState().setValue('coordinate', COORD_A)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    paneScopeStore.getState().setValue('coordinate', 'artifact-coord-b')
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_B])
    expect(paneScopeStore.getState().scope.axis).toEqual([HASH_B])
  })

  it('the EMPTY answer is a real answer and is written as readily as a hash', () => {
    // An unanswerable join (no coordinate, or one whose rows no declaration decides) must
    // CLEAR the axis, not leave the previous one standing. A stale axis outliving the
    // positions it was derived from is the wrong-rows failure the pane exists to prevent, and
    // it is the exact shape a "only write a truthy value" implementation would ship.
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    paneScopeStore.getState().setDerivedAxis(PROJECT, [])
    expect(paneScopeStore.getState().scope.axis).toEqual([])
  })

  it('a view may NOT write the axis — `setValue` refuses it, and says so', () => {
    // `setValue` is the seam a SECTION writes through (a declared action's `set:`). The axis is
    // derived, so a declaration writing it would be asserting rows nothing declared. Loud for
    // the same reason an unknown key is: a control that writes into nothing and reads the
    // derived value back forever LOOKS wired and is not.
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    const errors = captureErrors(() => paneScopeStore.getState().setValue('axis', HASH_B))
    expect(paneScopeStore.getState().scope.axis).toEqual([HASH_A])
    expect(errors.length).toBe(1)
  })

  it('a project change clears the axis AND the coordinate — neither names anything next door', () => {
    // A `content_hash` and an artifact id both belong to the project they were read from. A
    // value that outlives its project is worse than no value: it is a confident answer to a
    // question about a different project.
    paneScopeStore.getState().setValue('coordinate', COORD_A)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    paneScopeStore.getState().bindProject(OTHER)
    expect(paneScopeStore.getState().scope).toEqual({ axis: [], coordinate: null })
  })

  it('a re-derivation to the SAME axis is a no-op that leaves the coordinate alone', () => {
    // The derivation re-runs on every catalog AND coordinate change, so the no-op case is the
    // COMMON one: it must not replace `scope`, or every section reading `$scope` re-renders
    // for a value that did not move.
    paneScopeStore.getState().setValue('coordinate', COORD_A)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    const before = paneScopeStore.getState().scope
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    expect(paneScopeStore.getState().scope).toBe(before)
    expect(paneScopeStore.getState().scope.coordinate).toBe(COORD_A)
  })
})

describe('$scope is byte-unchanged (the concurrent-branch safety property)', () => {
  it('the exported PaneScope object gains NO key', () => {
    // `PaneScope` is what every view spec sees as `$scope` and what the axis-source resolver
    // reads. A key added there would change what every declaration resolves against. Asserted
    // by shape rather than promised in a comment, because a comment cannot fail.
    paneScopeStore.getState().setDerivedAxis(PROJECT, [HASH_A])
    expect(Object.keys(paneScopeStore.getState().scope).sort()).toEqual(['axis', 'coordinate'])
  })
})
