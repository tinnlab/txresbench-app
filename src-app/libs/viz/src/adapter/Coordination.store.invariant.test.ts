// Coordination.store.invariant.test.ts — THE PROTECTION (CONV-19).
//
// The "recipe outlived its ids" defect recurred FOUR times across SIX sites and defeated FOUR
// guards. Fix round 4's guard scanned the SOURCE of `Coordination.store.ts` for actions writing a
// selection field; convergence-4 injected six plausible "site six" shapes and FIVE escaped it,
// because a source scan must anticipate syntax. Worse, its predicate saw only 4 of the 7
// selection-mutating actions — `setSelectionInSpace` and `clearSelectionInSpace` (sites #4 and #5
// of this defect's own history) passed by being SKIPPED, not checked.
//
// The runtime assertion in `assertSelectionInvariants` does not read source and does not care how a
// mutation was spelled — only what the state looks like after it commits. This file is its
// acceptance test: it re-injects ALL SIX shapes convergence-4 used and proves every one now trips.
// A shape that escapes here is a real hole, not a stylistic quibble.

import { describe, expect, it } from 'vitest'
import { __assertionRunCount, createCoordinationStore, DEFAULT_SELECTION_SPACE } from './Coordination.store'

type Store = ReturnType<typeof createCoordinationStore>

/** A store holding a live default-space selection WITH a recipe — the state every shape below
 *  corrupts by emptying the ids while leaving the recipe attached. */
function liveWithRecipe(): Store {
  const store = createCoordinationStore()
  store.getState().setSelection('originA', Uint32Array.from([1, 2, 3]))
  store.getState().setSelectionProvenance({
    ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
  })
  expect(store.getState().selectionProvenance).not.toBeNull()
  expect(store.getState().pointSelection).not.toBeNull()
  return store
}

/** Reach into the store's raw setter the way a future action author would.
 *
 *  CONV-27 — this used to claim "`setState` is the same entry point every action's `set` resolves
 *  to". That is FALSE, and it is the sentence that produced the blind spot convergence-5 found:
 *  `createCoordinationStore` REPLACES `store.setState` with an OUTER wrapper, while the actions
 *  close over a SEPARATE inner wrapper (`assertingSet(rawSet, get)`) installed inside
 *  `createCoordinationStoreInner`. Two independent doors — deleting the inner one removed the
 *  protection from 100% of production commits and still left every test in this file green.
 *  `setState` is the OUTER door; the inner one is covered by the CONV-23 block below. */
function rawCommit(store: Store, recipe: (s: never) => void): () => void {
  return () => (store as unknown as { setState: (r: unknown) => void }).setState(recipe)
}

describe('CONV-19 — the runtime invariant assertion catches ALL SIX site-six shapes', () => {
  // V1 — the bare multi-line `set(s => {...})`. The ONLY shape fix round 4's source scan caught.
  it('V1 bare multi-line set() — CAUGHT', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { pointSelection: unknown; selectionByOrigin: unknown; selectionBySpace: Record<string, unknown> }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })

  // V2 — a helper one level down. ESCAPED the source scan, and this shape is already used twice in
  // the store file, so it is the shape a sixth author would most naturally copy.
  it('V2 helper one level down — CAUGHT', () => {
    const store = liveWithRecipe()
    const writeSpace = (d: { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }) => {
      d.pointSelection = null
      d.selectionByOrigin = {}
      delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
    }
    expect(rawCommit(store, (s: never) => writeSpace(s as never))).toThrow(
      /selection invariant A violated/,
    )
  })

  // V3 — the draft parameter renamed. ESCAPED: the scan matched only the literal `s.<field>`.
  it('V3 renamed draft parameter — CAUGHT', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (draft: never) => {
        const d = draft as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })

  // V4 — `set(` on the SAME line as `=>`. ESCAPED: the scan's regex required a newline, so the
  // action was never even scanned. A runtime check cannot be evaded by formatting.
  it('V4 single-line set() — CAUGHT', () => {
    const store = liveWithRecipe()
    expect(rawCommit(store, (s: never) => { const d = s as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }; d.pointSelection = null; d.selectionByOrigin = {}; delete d.selectionBySpace[DEFAULT_SELECTION_SPACE] })).toThrow(/selection invariant A violated/)
  })

  // V5 — deferred/async. ESCAPED the scan entirely; the assertion runs on the commit whenever it
  // lands, because it hangs off `set` rather than off the action's source.
  it('V5 async deferred set() — CAUGHT', async () => {
    const store = liveWithRecipe()
    const commit = rawCommit(store, (s: never) => {
      const d = s as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }
      d.pointSelection = null
      d.selectionByOrigin = {}
      delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
    })
    await expect(Promise.resolve().then(commit)).rejects.toThrow(/selection invariant A violated/)
  })

  // V6 — a computed field name. ESCAPED: no literal `s.pointSelection` to match.
  it('V6 computed field name — CAUGHT', () => {
    const store = liveWithRecipe()
    const field = 'pointSelection'
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as Record<string, unknown> & { selectionBySpace: Record<string, unknown> }
        d[field] = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })

  // The strongest case from convergence-4: unwrapping an EXISTING action left the source scan
  // silent (exit 0). Here the same shape — a space write with no normalisation — is caught.
  it('an EXISTING action unwrapped (the case the source scan passed silently) — CAUGHT', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { selectionBySpace: Record<string, unknown>; pointSelection: unknown; selectionByOrigin: unknown }
        // exactly `writeSelectionSpace(s, DEFAULT, null, null)`'s effect, minus `selectionMutation`
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
        d.pointSelection = null
        d.selectionByOrigin = {}
      }),
    ).toThrow(/selection invariant A violated/)
  })
})

describe('CONV-19 — the assertion is not vacuous and does not cry wolf', () => {
  it('every legitimate wrapped action commits cleanly', () => {
    const store = createCoordinationStore()
    const a = store.getState()
    expect(() => a.setSelection('o', Uint32Array.from([1, 2]))).not.toThrow()
    expect(() => store.getState().setPointSelection(Uint32Array.from([3]))).not.toThrow()
    expect(() => store.getState().setSelectionInSpace('spaceB', null, Uint32Array.from([9]))).not.toThrow()
    expect(() => store.getState().clearSelectionInSpace('spaceB')).not.toThrow()
    expect(() => store.getState().clearSelection()).not.toThrow()
    expect(store.getState().selectionProvenance).toBeNull()
  })

  it('an unrelated (non-selection) mutation is never flagged', () => {
    const store = liveWithRecipe()
    expect(() => store.getState().setViewState('scope', { target: [0, 0], zoom: 1 })).not.toThrow()
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('INVARIANT B — a present-but-empty space entry is caught', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { selectionBySpace: Record<string, unknown> }
        d.selectionBySpace.spaceB = { ids: Uint32Array.from([]), origin: null }
      }),
    ).toThrow(/selection invariant B violated/)
  })

  it('INVARIANT C — a DEFAULT entry disagreeing with pointSelection is caught', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { pointSelection: unknown }
        d.pointSelection = null // leaves the DEFAULT space entry behind
      }),
    ).toThrow(/selection invariant C violated/)
  })
})

// CONV-26 — THE MISSING HALF OF THE VERIFICATION.
//
// Every acceptance test on this branch proved a guard FIRES ON VIOLATION; not one proved it STAYS
// QUIET ON A LEGITIMATE PATH. That omission was convergence-6's HIGH: round 6 turned the assertion
// on in browsers, and because the exemption was per-COMMIT while the state it excused PERSISTS,
// every unrelated coordination commit made during an INV-7 ops-only window threw — `setColorScale`
// (what `useSharedColorDomain.ts:38` calls) hard-crashed the dev app. The suite could not see it:
// its one "does not cry wolf" control builds a store with a LIVE selection, where A cannot apply,
// and the sibling exemption test deliberately CLOSED the window before its unwrapped commit.
//
// These tests hold the window OPEN and commit through it. Recasting A as a transition is what makes
// them pass; they are red on the round-6 per-commit-exemption code.
describe('CONV-26 — the assertion STAYS QUIET across the whole INV-7 ops-only window', () => {
  /** The window: a recipe legitimately present with no ids (DEC-9 — ops hydrate before the pane
   *  buffers exist). It persists until the panes resolve, and for `[add A, subtract A]` forever. */
  function opsOnlyWindow(): Store {
    const store = createCoordinationStore()
    store.getState().setSelectionProvenance({
      ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
    })
    expect(store.getState().selectionProvenance).not.toBeNull()
    expect(store.getState().pointSelection).toBeNull()
    return store
  }

  it('opening the window does not throw (INV-7 ops-only restore)', () => {
    expect(() => opsOnlyWindow()).not.toThrow()
  })

  it('an UNRELATED coordination commit DURING the window does not throw (the convergence-6 HIGH)', () => {
    const store = opsOnlyWindow()
    // `setColorScale` is literally what `useSharedColorDomain.ts:38` calls. Under the round-6
    // per-commit exemption this threw invariant A and crashed the dev app.
    expect(() => store.getState().setColorScale('probe', { domain: [0, 1] } as never)).not.toThrow()
    expect(() => store.getState().setViewState('scopeA', { target: [1, 2], zoom: 3 })).not.toThrow()
    expect(() => store.getState().setHighlight(7)).not.toThrow()
    // The window is still open — the recipe survived every one of them.
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('the window survives MANY commits — it is a resting state, not a one-commit transient', () => {
    const store = opsOnlyWindow()
    expect(() => {
      for (let i = 0; i < 25; i++) store.getState().setViewState(`s${i}`, { target: [i, i], zoom: i })
    }).not.toThrow()
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('a synchronous nested commit during the window does not throw AT ANY DEPTH', () => {
    // Round 6's inheritance was not transitive, so this threw at depth >= 2. A transition has no
    // depth: each nested commit samples its own before-state, which is unchanged.
    const store = createCoordinationStore()
    let depth = 0
    const unsub = store.subscribe(() => {
      if (depth >= 3) return
      depth++
      store.getState().setViewState(`nested${depth}`, { target: [0, 0], zoom: 1 })
    })
    expect(() =>
      store.getState().setSelectionProvenance({
        ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
      }),
    ).not.toThrow()
    expect(depth).toBeGreaterThanOrEqual(3)
    expect(store.getState().selectionProvenance).not.toBeNull()
    unsub()
  })

  it('a THROWING subscriber cannot disarm the assertion for later commits (no sticky exemption)', () => {
    // Round 6's save/restore left the flag raised if anything threw in the notify pass, disarming A
    // process-wide, permanently. There is no flag now, so a throw cannot leave residue.
    const store = createCoordinationStore()
    let armed = true
    const unsub = store.subscribe(() => {
      if (!armed) return
      armed = false
      throw new Error('host callback blew up')
    })
    expect(() =>
      store.getState().setSelectionProvenance({
        ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
      }),
    ).toThrow(/host callback blew up/)
    unsub()
    // A must still be armed: build a live selection, then destroy it with an unwrapped write.
    store.getState().setSelection('o', Uint32Array.from([1, 2, 3]))
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })

  it('a FRESH store is not disarmed by an earlier throw in another store', () => {
    const fresh = createCoordinationStore()
    fresh.getState().setSelection('o', Uint32Array.from([9]))
    fresh.getState().setSelectionProvenance({
      ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
    })
    expect(
      rawCommit(fresh, (s: never) => {
        const d = s as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })

  it('B and C stay enforced during the window — the reformulation relaxed A only', () => {
    const store = opsOnlyWindow()
    expect(
      rawCommit(store, (s: never) => {
        ;(s as unknown as { selectionBySpace: Record<string, unknown> }).selectionBySpace.ghost = {
          ids: new Uint32Array(0),
          origin: null,
        }
      }),
    ).toThrow(/selection invariant B violated/)
  })
})

describe('CONV-26 — A still fires once ids have actually been derived', () => {
  it('after the window closes, an unwrapped write that empties the ids is CAUGHT', () => {
    const store = createCoordinationStore()
    store.getState().setSelectionProvenance({
      ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
    })
    // The panes resolved and the recipe derived its ids — the window is closed.
    store.getState().setSelection('o', Uint32Array.from([1]))
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as { pointSelection: unknown; selectionBySpace: Record<string, unknown>; selectionByOrigin: unknown }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })
})

// CONV-23 — every test above drives `store.setState`, which `createCoordinationStore` replaces with
// an OUTER wrapper. The actions closed over a SEPARATE inner wrapper, `assertingSet(rawSet, get)`,
// installed inside `createCoordinationStoreInner`. Two independent doors, and the suite covered only
// one: deleting `assertingSet` — removing the protection from 100% of production commits — left all
// 13 tests green. That is round 4's falsification failure one level up, so these tests assert the
// protection is INSTALLED at the door real actions use, not merely that the shared assertion body
// works when something reaches it.
describe('CONV-23 — the assertion is installed at the door every real ACTION uses', () => {
  it('a real action commit is CHECKED (deleting `assertingSet` turns this red)', () => {
    const store = createCoordinationStore()
    const before = __assertionRunCount()
    // A plain, entirely legitimate action. It must not throw — but it MUST be checked.
    store.getState().setSelection('originA', Uint32Array.from([1, 2, 3]))
    expect(__assertionRunCount()).toBeGreaterThan(before)
  })

  it('an action touching NO selection field is still checked (the wrapper is on `set`, not a field list)', () => {
    // Guards against a future "optimisation" that only wraps selection-looking actions — the very
    // predicate-based narrowing that let sites #4 and #5 through the source scan.
    const store = createCoordinationStore()
    const before = __assertionRunCount()
    store.getState().setViewState('scopeA', { target: [1, 2], zoom: 3 })
    expect(__assertionRunCount()).toBeGreaterThan(before)
  })

  it('the two doors are genuinely distinct — a `setState` commit is checked too', () => {
    // Positive control for the OUTER door, so this file covers both installation sites rather than
    // trading one blind spot for the other.
    const store = createCoordinationStore()
    const before = __assertionRunCount()
    ;(store as unknown as { setState: (r: unknown) => void }).setState((s: never) => {
      ;(s as unknown as { exclusiveSelectionOrigin: string | null }).exclusiveSelectionOrigin = null
    })
    expect(__assertionRunCount()).toBeGreaterThan(before)
  })
})

describe('CONV-24/26 — a synchronous nested commit is judged on its own transition', () => {
  it('an INV-7 ops-only restore survives a subscriber that commits synchronously', () => {
    const store = createCoordinationStore()
    let bounce = false
    // A listener that commits an UNRELATED mutation, synchronously, inside the notify pass.
    const unsub = store.subscribe(() => {
      if (bounce) return
      bounce = true
      store.getState().setViewState('nested', { target: [0, 0], zoom: 1 })
      bounce = false
    })
    // The ops-only restore: a recipe legitimately precedes its ids (INV-7/DEC-9). Before the
    // save/restore fix the nested commit cleared the exemption flag and this threw invariant A.
    expect(() =>
      store.getState().setSelectionProvenance({
        ops: [{ tool: 'rect', op: 'add', pane: 'cellA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 1, 1] }],
      }),
    ).not.toThrow()
    expect(store.getState().selectionProvenance).not.toBeNull()
    unsub()
  })
})

describe('CONV-25 — invariant C compares the origin it documents', () => {
  it('a raw commit that desyncs ONLY the origin is CAUGHT', () => {
    const store = createCoordinationStore()
    store.getState().setSelection('originA', Uint32Array.from([1, 2, 3]))
    expect(
      rawCommit(store, (s: never) => {
        ;(s as unknown as { selectionOrigin: string | null }).selectionOrigin = null
      }),
    ).toThrow(/selection invariant C violated: the DEFAULT space entry holds a different origin/)
  })

  it('a matching origin passes (the assertion is not merely always-throwing)', () => {
    const store = createCoordinationStore()
    store.getState().setSelection('originA', Uint32Array.from([1, 2, 3]))
    expect(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]?.origin).toBe('originA')
    expect(() => store.getState().setSelection('originB', Uint32Array.from([4]))).not.toThrow()
  })
})

// CONV-29 — THE ACKNOWLEDGED GAP in invariant A's identity clause.
//
// A fires on a live→empty transition ONLY while the recipe object is reference-unchanged. A commit
// that empties the ids AND rewrites the recipe is read as a deliberate `hydrate`-shaped write and
// is not judged. That is a HEURISTIC, and until CONV-29 the header called it "the precise
// statement" of the defect — telling the next author they were covered when they were not.
//
// These tests pin the gap as it actually is. They are DOCUMENTATION OF A LIMIT, not an endorsement:
// each shape leaves a recipe describing ids that no longer exist (the DEC-5 lie). If a future
// change makes A catch them, these tests SHOULD fail — replace them with the caught-shape
// assertions and delete the caveat from the header.
describe('CONV-29 — the acknowledged gap: a commit that ALSO rewrites the recipe escapes A', () => {
  it('shallow-cloning the recipe while emptying the ids is NOT caught (known limit)', () => {
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as {
          pointSelection: unknown
          selectionByOrigin: unknown
          selectionBySpace: Record<string, unknown>
          selectionProvenance: Record<string, unknown>
        }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
        d.selectionProvenance = { ...d.selectionProvenance }
      }),
    ).not.toThrow()
    // The lie the gap permits: ids gone, recipe still describing them.
    expect(store.getState().pointSelection).toBeNull()
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('an in-place CONTEXT STAMP while emptying the ids is NOT caught (the forward hazard shape)', () => {
    // This is the shape a "keep the ids and the recorded context symmetric" refactor of
    // `revalidateSelectionIn`'s write-back would produce: immer marks the branch modified, so the
    // recipe comes out a NEW object and the identity clause reads it as a deliberate write.
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as {
          pointSelection: unknown
          selectionByOrigin: unknown
          selectionBySpace: Record<string, unknown>
          selectionProvenance: { context?: unknown }
        }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
        d.selectionProvenance.context = { filters: {} }
      }),
    ).not.toThrow()
    expect(store.getState().pointSelection).toBeNull()
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('CONTROL — the same commit WITHOUT touching the recipe is still CAUGHT', () => {
    // Proves the two tests above isolate the identity clause specifically, and that A has not been
    // weakened generally: drop the recipe write and the identical mutation throws.
    const store = liveWithRecipe()
    expect(
      rawCommit(store, (s: never) => {
        const d = s as unknown as {
          pointSelection: unknown
          selectionByOrigin: unknown
          selectionBySpace: Record<string, unknown>
        }
        d.pointSelection = null
        d.selectionByOrigin = {}
        delete d.selectionBySpace[DEFAULT_SELECTION_SPACE]
      }),
    ).toThrow(/selection invariant A violated/)
  })
})
