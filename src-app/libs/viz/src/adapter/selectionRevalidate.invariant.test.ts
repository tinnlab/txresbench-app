// TEST-28 [acceptance] [INV-8] — the context/data split must hold on EVERY path.
//
// The blind audit found INV-8 DEFEATABLE through the `liveIsEmpty` carve-out, in two ways that a
// value assertion cannot see (the ids are correct either way — the defect is the WORK done):
//   (1) a selection living only in a NON-DEFAULT space (every multi-dataset selection) looked
//       permanently "empty", so every idle tick re-ran the full geometry;
//   (2) a legitimately EMPTY selection (`[add A, subtract A]`) never converged and re-derived
//       forever.
// Both are asserted here by COUNTING containment passes, not by comparing ids.
import { describe, it, expect } from 'vitest'
import { createVizStores } from './vizStores'
import { revalidateSelectionIn } from './selectionRevalidate'
import { containmentPassCount } from '../viz-core/selection/SelectionController'
import { DEFAULT_SELECTION_SPACE, __assertionRunCount } from './Coordination.store'

/** 10x10 lattice at integer coords. */
const lattice = (space: string) => {
  const side = 10
  const n = side * side
  const positions = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    positions[i * 2] = i % side
    positions[i * 2 + 1] = Math.floor(i / side)
  }
  return { positions, nPoints: n, pointIds: null, space }
}

const rect = (region: [number, number, number, number], op: 'add' | 'subtract' = 'add') =>
  ({ tool: 'rect' as const, op, pane: 'p1', space: 'default', region })

describe('INV-8 holds on the empty and non-default-space paths (TEST-28)', () => {
  it('a legitimately EMPTY selection CONVERGES instead of re-deriving forever', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice(DEFAULT_SELECTION_SPACE)
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)
    const live = () => ({})

    // add a box then subtract the SAME box ⇒ the answer really is the empty set.
    coord().setSelectionProvenance({ ops: [rect([2, 2, 5, 5]), rect([2, 2, 5, 5], 'subtract')], context: undefined })

    const first = revalidateSelectionIn(coord(), resolve, live)
    expect(first).toBe('data') // it must actually derive once
    expect(coord().pointSelection?.length ?? 0).toBe(0) // …and the answer is empty

    // Every later idle tick must do NO containment work and report 'none'.
    const before = containmentPassCount()
    const classes: string[] = []
    for (let i = 0; i < 5; i++) classes.push(revalidateSelectionIn(coord(), resolve, live))
    const delta = containmentPassCount() - before

    expect(classes).toEqual(['none', 'none', 'none', 'none', 'none'])
    expect(delta).toBe(0) // the assertion that fails on the defect: 0 passes, not 2 per tick
  })

  it('a NON-DEFAULT-space selection is not treated as permanently empty', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice('spaceB') // NOT the default space
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)
    const live = () => ({})

    coord().setSelectionProvenance({ ops: [rect([2, 2, 5, 5])], context: undefined })
    expect(revalidateSelectionIn(coord(), resolve, live)).toBe('data')
    // The ids landed in spaceB, so the DEFAULT space is empty — which is exactly what used to make
    // this look "never derived".
    expect(coord().pointSelection?.length ?? 0).toBe(0)
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBeGreaterThan(0)

    const before = containmentPassCount()
    const classes: string[] = []
    for (let i = 0; i < 5; i++) classes.push(revalidateSelectionIn(coord(), resolve, live))
    const delta = containmentPassCount() - before

    expect(classes).toEqual(['none', 'none', 'none', 'none', 'none'])
    expect(delta).toBe(0)
  })
})

// CONV-14 — the SAME default-space-only asymmetry, fourth recurrence, on the IDS side. The DEFAULT
// arm of the write-back always writes (so it clears on empty); the non-default loop only iterated
// the spaces `deriveSelection` FILLED, and it emits no key for a space that derived to nothing. A
// space whose recipe now selects ∅ therefore kept its old ids forever, under a recipe denoting the
// empty set — never repaired, and it serializes. Three recipe-focused sweeps missed it because they
// were reading `selectionProvenance`, not the ids.
describe('the DATA write-back clears a space the re-derive emptied (CONV-14)', () => {
  const boxIn = (region: [number, number, number, number]) =>
    [{ tool: 'rect' as const, op: 'add' as const, pane: 'p1', space: 'spaceB', region }]

  // A DATA reclassification needs the PANES hash to move — `classifyChange` keys on
  // `panes`/`filters`/`hidden`, so an arbitrary field would read as 'none'.
  const atHash = (h: string) => () => ({ panes: { p1: h } })

  it('a non-default space whose recipe now selects nothing is CLEARED, not left stale', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice('spaceB')
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)

    // Tick 1 — a live selection in spaceB from a box that hits the lattice.
    coord().setSelectionProvenance({ ops: boxIn([2, 2, 5, 5]), context: undefined })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h1'))).toBe('data')
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBeGreaterThan(0)

    // Tick 2 — same space, a recipe that now selects nothing (box far off the lattice). The tail of
    // tick 1 recorded `context: {panes:{p1:'h1'}}`, so a moved hash classifies 'data' and the
    // geometry genuinely re-runs.
    coord().setSelectionProvenance({ ops: boxIn([900, 900, 950, 950]), context: { panes: { p1: 'h1' } } })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h2'))).toBe('data')

    // THE ASSERTION THAT FAILS ON THE DEFECT: spaceB used to keep its old ids here, under a recipe
    // that produces ∅ — and it serialized that way.
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBe(0)
    expect(coord().pointSelection?.length ?? 0).toBe(0)
  })

  // CONV-18 — CONV-14's own regression. `deriveSelection` emits no key for a space for TWO reasons:
  // its recipe genuinely selects nothing (CONV-14's target) OR that space's pane did not resolve, so
  // its ops were SKIPPED and nothing looked. The clearing loop could not tell them apart, and the
  // `anyResolvable` guard is `some`, not `every` — so ONE resolvable pane admits the loop while
  // another is mid-reload, destroying a live multi-dataset selection that is never repaired.
  const twoPaneOps = [
    { tool: 'rect' as const, op: 'add' as const, pane: 'pA', space: DEFAULT_SELECTION_SPACE, region: [2, 2, 5, 5] as [number, number, number, number] },
    { tool: 'rect' as const, op: 'add' as const, pane: 'pB', space: 'spaceB', region: [2, 2, 5, 5] as [number, number, number, number] },
  ]

  it('CONV-18 — a space whose PANE is unresolvable is NOT cleared (the derive never looked)', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const paneA = lattice(DEFAULT_SELECTION_SPACE)
    const paneB = lattice('spaceB')

    coord().setSelectionProvenance({ ops: twoPaneOps, context: undefined })
    expect(
      revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : id === 'pB' ? paneB : null), atHash('h1')),
    ).toBe('data')
    const spaceBIds = coord().selectionBySpace?.spaceB?.ids?.length ?? 0
    expect(spaceBIds).toBeGreaterThan(0)

    // pB goes mid-reload; pA still resolves, so `anyResolvable` admits us to the clearing loop.
    coord().setSelectionProvenance({ ops: twoPaneOps, context: { panes: { pA: 'h1', pB: 'h1' } } })
    expect(revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : null), atHash('h2'))).toBe('data')

    // THE ASSERTION THAT FAILS ON THE DEFECT: spaceB was destroyed here, and `serialize().spaces`
    // became undefined — a saved workspace silently losing its multi-dataset selection.
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBe(spaceBIds)
  })

  it('CONV-18 — the DEFAULT space is equally protected when ITS pane is unresolvable', () => {
    // The DEFAULT arm wrote unconditionally, so the symmetric case lost the default selection.
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const paneA = lattice(DEFAULT_SELECTION_SPACE)
    const paneB = lattice('spaceB')

    coord().setSelectionProvenance({ ops: twoPaneOps, context: undefined })
    expect(
      revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : id === 'pB' ? paneB : null), atHash('h1')),
    ).toBe('data')
    const defaultIds = coord().pointSelection?.length ?? 0
    expect(defaultIds).toBeGreaterThan(0)

    coord().setSelectionProvenance({ ops: twoPaneOps, context: { panes: { pA: 'h1', pB: 'h1' } } })
    expect(revalidateSelectionIn(coord(), id => (id === 'pB' ? paneB : null), atHash('h2'))).toBe('data')
    expect(coord().pointSelection?.length ?? 0).toBe(defaultIds)
  })

  it('CONV-18 does NOT resurrect CONV-14: a RESOLVABLE space that derives to ∅ is still cleared', () => {
    // The regression guard for the fix itself — if `unevaluableSpaces` over-reported, CONV-14's
    // original defect would come straight back and this goes red.
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice('spaceB')
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)

    coord().setSelectionProvenance({ ops: boxIn([2, 2, 5, 5]), context: undefined })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h1'))).toBe('data')
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBeGreaterThan(0)

    coord().setSelectionProvenance({ ops: boxIn([900, 900, 950, 950]), context: { panes: { p1: 'h1' } } })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h2'))).toBe('data')
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBe(0)
  })

  it('a space the derive still fills is untouched by the clearing pass', () => {
    // Positive control: the clearing loop must not trade a stale-ids bug for a lost-selection bug.
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice('spaceB')
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)

    coord().setSelectionProvenance({ ops: boxIn([2, 2, 5, 5]), context: undefined })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h1'))).toBe('data')
    const n1 = coord().selectionBySpace?.spaceB?.ids?.length ?? 0

    coord().setSelectionProvenance({ ops: boxIn([2, 2, 5, 5]), context: { panes: { p1: 'h1' } } })
    expect(revalidateSelectionIn(coord(), resolve, atHash('h2'))).toBe('data')

    expect(n1).toBeGreaterThan(0)
    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBe(n1)
  })

  // CONV-21 — CONV-18 gated the two CLEAR branches and left the two WRITE branches unconditional,
  // so the same "ids destroyed on the strength of a derive that never fully ran" survived one step
  // to the left. Every CONV-18 case models ONE pane per space, which is exactly why they miss it:
  // the loss needs a space named by TWO panes with only one resolvable, so `bySpace` carries a
  // PARTIAL answer rather than no key at all. `recordCellProvenance` produces precisely that shape
  // for two grid cells over one dataset (`pane = cellId`, one `space`).
  /** A lattice whose canonical ids are offset, so two panes contribute DISJOINT ids and a partial
   *  derive shows up as a halved count rather than an unchanged union. */
  const latticeAt = (space: string, base: number) => {
    const l = lattice(space)
    return { ...l, pointIds: Uint32Array.from({ length: l.nPoints }, (_, i) => base + i) }
  }
  const twoPanesOneSpace = (space: string) => [
    { tool: 'rect' as const, op: 'add' as const, pane: 'pA', space, region: [0, 0, 9, 3] as [number, number, number, number] },
    { tool: 'rect' as const, op: 'add' as const, pane: 'pB', space, region: [0, 0, 9, 3] as [number, number, number, number] },
  ]

  it('CONV-21 — a space named by TWO panes with ONE unresolvable keeps ALL its ids (WRITE path)', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const paneA = latticeAt(DEFAULT_SELECTION_SPACE, 0)
    const paneB = latticeAt(DEFAULT_SELECTION_SPACE, 1000)
    const ops = twoPanesOneSpace(DEFAULT_SELECTION_SPACE)

    coord().setSelectionProvenance({ ops, context: undefined })
    expect(
      revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : id === 'pB' ? paneB : null), () => ({
        panes: { pA: 'h1', pB: 'h1' },
      })),
    ).toBe('data')
    const full = coord().pointSelection?.length ?? 0
    expect(full).toBe(80) // 40 rows per pane, disjoint ids

    // pB goes mid-reload. pA still resolves, so `anyResolvable` (`some`) admits us to the WRITE
    // path, and `bySpace[default]` now holds ONLY pA's contribution.
    coord().setSelectionProvenance({ ops, context: { panes: { pA: 'h1', pB: 'h1' } } })
    revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : null), () => ({ panes: { pA: 'h2', pB: 'h1' } }))

    // THE ASSERTION THAT FAILS ON THE DEFECT: 80 → 40, half the user's selection silently gone,
    // never repaired (the tail records the new context so the next tick is 'none'), and it
    // SERIALIZES — a saved workspace shipping ids its own recipe cannot reproduce.
    expect(coord().pointSelection?.length ?? 0).toBe(full)
  })

  it('CONV-21 — the same protection on a NON-DEFAULT space (the multi-dataset case)', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const paneA = latticeAt('spaceB', 0)
    const paneB = latticeAt('spaceB', 1000)
    const ops = twoPanesOneSpace('spaceB')

    coord().setSelectionProvenance({ ops, context: undefined })
    expect(
      revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : id === 'pB' ? paneB : null), () => ({
        panes: { pA: 'h1', pB: 'h1' },
      })),
    ).toBe('data')
    const full = coord().selectionBySpace?.spaceB?.ids?.length ?? 0
    expect(full).toBe(80)

    coord().setSelectionProvenance({ ops, context: { panes: { pA: 'h1', pB: 'h1' } } })
    revalidateSelectionIn(coord(), id => (id === 'pA' ? paneA : null), () => ({ panes: { pA: 'h2', pB: 'h1' } }))

    expect(coord().selectionBySpace?.spaceB?.ids?.length ?? 0).toBe(full)
  })

  it('CONV-21 does NOT over-correct: a FULLY resolvable space still takes its new answer', () => {
    // The guard for the fix itself. If the write path refused whenever a space were (wrongly)
    // reported unevaluable, a normal re-derive would stop updating and this goes red.
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const paneA = latticeAt(DEFAULT_SELECTION_SPACE, 0)
    const paneB = latticeAt(DEFAULT_SELECTION_SPACE, 1000)
    const resolve = (id: string | null) => (id === 'pA' ? paneA : id === 'pB' ? paneB : null)

    coord().setSelectionProvenance({ ops: twoPanesOneSpace(DEFAULT_SELECTION_SPACE), context: undefined })
    expect(revalidateSelectionIn(coord(), resolve, () => ({ panes: { pA: 'h1', pB: 'h1' } }))).toBe('data')
    expect(coord().pointSelection?.length ?? 0).toBe(80)

    // Both panes resolvable, a strictly smaller box ⇒ the new (smaller) answer MUST be written.
    const smaller = [
      { tool: 'rect' as const, op: 'add' as const, pane: 'pA', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 9, 0] as [number, number, number, number] },
      { tool: 'rect' as const, op: 'add' as const, pane: 'pB', space: DEFAULT_SELECTION_SPACE, region: [0, 0, 9, 0] as [number, number, number, number] },
    ]
    coord().setSelectionProvenance({ ops: smaller, context: { panes: { pA: 'h1', pB: 'h1' } } })
    expect(revalidateSelectionIn(coord(), resolve, () => ({ panes: { pA: 'h2', pB: 'h2' } }))).toBe('data')
    expect(coord().pointSelection?.length ?? 0).toBe(20) // 10 per pane
  })
})

// CONV-29 — THE COMMIT SEPARATION IS LOAD-BEARING, NOT TIDINESS.
//
// The write-back writes the ids and the recipe in the same TICK but as SEPARATE action commits.
// Invariant A fires on a live→empty transition ONLY while the recipe object is reference-unchanged,
// so today the clearing commits transition and are judged, and the recording commit sees no
// transition. Fusing them into one atomic commit — the obvious "keep the ids and the recorded
// context symmetric" refactor that CONV-14/CONV-18/CONV-21 are three consecutive fixes about —
// yields a commit that empties the ids AND rewrites the recipe, which A does not judge (see
// `CONV-29 — the acknowledged gap` in Coordination.store.invariant.test.ts). The result is a recipe
// describing a set that no longer exists, with the assertion silent.
//
// This test makes that hazard mechanical rather than a comment somebody has to remember: it counts
// commits. A fused write-back commits ONCE and reds this.
describe('CONV-29 — the write-back keeps the ids write and the recipe write in SEPARATE commits', () => {
  it('a derive that empties a LIVE selection issues ≥2 commits (fusing them reds this)', () => {
    const stores = createVizStores()
    const coord = () => stores.coordination.getState()
    const pane = lattice(DEFAULT_SELECTION_SPACE)
    const resolve = (id: string | null) => (id === 'p1' ? pane : null)
    // The pane hash MOVED since the recipe was recorded ⇒ `classifyChange` returns 'data', the only
    // class that re-runs geometry and therefore the only one that writes ids.
    const live = () => ({ panes: { p1: 'hash-after' } })

    // A genuinely live selection first — the clear must actually transition live→empty.
    coord().setSelection('originA', Uint32Array.from([1, 2, 3]))
    expect(coord().pointSelection?.length ?? 0).toBe(3)

    // …under a recipe whose answer is the empty set, so the write-back takes the clearing path
    // AND records the context in the same tick.
    coord().setSelectionProvenance({
      ops: [rect([2, 2, 5, 5]), rect([2, 2, 5, 5], 'subtract')],
      context: { panes: { p1: 'hash-before' } },
    })

    const before = __assertionRunCount()
    expect(revalidateSelectionIn(coord(), resolve, live)).toBe('data')
    const commits = __assertionRunCount() - before

    // ≥2: at least one commit clearing the ids, and a separate one recording the recipe. If a
    // refactor fuses them this is 1 — and invariant A stops judging the transition.
    expect(commits).toBeGreaterThanOrEqual(2)
    expect(coord().pointSelection?.length ?? 0).toBe(0)
    expect(coord().selectionProvenance).not.toBeNull()
  })
})
