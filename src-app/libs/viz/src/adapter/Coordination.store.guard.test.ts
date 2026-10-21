// Coordination.store.guard.test.ts — a SECONDARY, ADVISORY static check (DEMOTED in fix round 5).
//
// ⚠️ THIS FILE IS NOT THE PROTECTION. `Coordination.store.invariant.test.ts` is: a RUNTIME
// assertion that checks state after every commit. This scan is kept only because it names the
// offending ACTION instantly and cheaply, which a runtime failure does not — a fast smoke signal,
// never the guarantee.
//
// WHY IT WAS DEMOTED (CONV-19). Fix round 4 presented this scan AS the structural guard. A source
// scan must anticipate SYNTAX, and convergence-4 proved this one does not: of six plausible
// "site six" shapes, FIVE escaped — a helper one level down (a shape already used twice in the
// store file), a renamed draft parameter, `set(` on the same line as `=>`, an async
// `then(() => set(…))`, and a computed field name. Its predicate also saw only 4 of the 7
// selection-mutating actions: `setSelectionInSpace` and `clearSelectionInSpace` — sites #4 and #5
// of this defect's own history — passed by being SKIPPED, not by being checked. And its `>= 10`
// non-vacuity check counts ALL actions, so it would still clear if every selection action fell out
// of the scan. Decisive: unwrapping an EXISTING action left it silent at exit 0 while the
// behavioural suites went red.
//
// Round 5 fixes the three named blind spots (name-agnostic draft parameter, helper-aware, same-line
// `set(`) and asserts POSITIVELY that the two previously-invisible actions are detected, so the
// scan's blind spot cannot silently widen again. It is still only advisory.
//
// The history it all comes from — the defect recurred FOUR times across SIX sites:
//   1. `selectionRevalidate.liveIsEmpty`  (round 1)
//   2. `setSelection`                     (CONV-1)
//   3. `clearSelection`                   (CONV-8 — at a line CONV-1's own sweep certified clean)
//   4. `setSelectionInSpace`              (CONV-8 — no predicate at all)
//   5. `setPointSelection`                (CONV-13 — never called the shared predicate)
//   6. `revalidateSelectionIn` write-back (CONV-14 — the same asymmetry on the IDS side)
//
// The escape hatch is an explicit allowlist of TWO names, because those actions WRITE the recipe
// and must not be normalised (see `selectionMutation`'s note): the ops-only restore (INV-7/DEC-9)
// and the convergence of a legitimately-empty re-derive both legitimately hold a recipe with no ids.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'Coordination.store.ts'), 'utf8')

/** State fields whose mutation can leave the recipe describing a set that no longer exists. */
const SELECTION_FIELDS = [
  'pointSelection',
  'selectionByOrigin',
  'selectionBySpace',
  'selectionOrigin',
]

/** The ONLY actions permitted to bypass `selectionMutation` — they set the recipe itself. */
const RAW_WRITE_ALLOWLIST = ['setSelectionProvenance', 'hydrate']

/** Every `name: … => set(` action in the store factory, with the source text of its recipe body. */
function storeActions(): { name: string; body: string; wrapper: string | null }[] {
  const out: { name: string; body: string; wrapper: string | null }[] = []
  // CONV-19 blind spot #3: the old regex required a NEWLINE between `=>` and `set(`, so an action
  // written on one line was not scanned at all. `\s*` spans both.
  const re = /^ {6}(\w+): [^\n]*=>\s*set\(/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(SRC)) !== null) {
    const name = m[1]
    const start = m.index
    // The action ends where the next 6-space-indented `name:` begins (or at the factory's close).
    const rest = SRC.slice(start + m[0].length)
    const nextIdx = rest.search(/^ {6}\w+: /m)
    const body = nextIdx === -1 ? rest.slice(0, 4000) : rest.slice(0, nextIdx)
    const wrapper = /^\s*(selectionMutation|rawSelectionWrite)\(/.exec(body)?.[1] ?? null
    out.push({ name, body, wrapper })
  }
  return out
}

/** Helpers that write selection state on a caller's behalf — a body handing the draft to one of
 *  these mutates selection just as surely as an inline assignment (CONV-19 blind spot #2: the old
 *  predicate saw only inline `s.<field>`, so `set(s => writeSelectionSpace(s, …))` — a shape used
 *  twice in the store — was invisible, which is how `setSelectionInSpace` and
 *  `clearSelectionInSpace` passed by being skipped). */
const SELECTION_WRITING_HELPERS = [
  'writeSelectionSpace',
  'syncDefaultSelectionSpace',
  'dropProvenanceIfNoSelection',
]

/** Does this action's recipe body write any selection field?
 *
 *  Name-agnostic in the draft parameter (CONV-19 blind spot #1: the old predicate hard-coded `s.`,
 *  so `set(draft => { draft.pointSelection = … })` escaped) and helper-aware (blind spot #2).
 *  Still cannot see a computed field name or an async deferral — which is precisely why this file
 *  is advisory and the runtime assertion is the protection. */
function touchesSelection(body: string): boolean {
  const inline = SELECTION_FIELDS.some(f =>
    new RegExp(`(?:^|[^\\w.])[A-Za-z_$][\\w$]*\\.${f}\\s*(=|\\[)`).test(body),
  )
  const viaHelper = SELECTION_WRITING_HELPERS.some(h => new RegExp(`\\b${h}\\s*\\(`).test(body))
  const viaDelete = /\bdelete\s+[A-Za-z_$][\w$]*\.selectionBySpace\b/.test(body)
  return inline || viaHelper || viaDelete
}

describe('Coordination store — the selection chokepoint is structurally enforced (CONV-13)', () => {
  it('finds the store actions at all (the scan itself is not vacuous)', () => {
    const actions = storeActions()
    // A regex that silently matches nothing would make every assertion below trivially true —
    // the exact failure mode this whole guard exists to prevent.
    expect(actions.length).toBeGreaterThanOrEqual(10)
    expect(actions.map(a => a.name)).toEqual(
      expect.arrayContaining([
        'setPointSelection',
        'setSelection',
        'clearSelection',
        'setSelectionInSpace',
        'clearSelectionInSpace',
        'setSelectionProvenance',
        'hydrate',
      ]),
    )
  })

  it('sees selection writes where they exist and not where they do not', () => {
    const byName = Object.fromEntries(storeActions().map(a => [a.name, a]))
    // Positive controls: these genuinely mutate selection ids.
    expect(touchesSelection(byName.setPointSelection.body)).toBe(true)
    expect(touchesSelection(byName.clearSelection.body)).toBe(true)
    // Negative control: an unrelated action must NOT be flagged, or the guard would be crying wolf.
    expect(touchesSelection(byName.setViewState.body)).toBe(false)
  })

  it('DETECTS the two actions that previously passed by being SKIPPED (CONV-19)', () => {
    // `setSelectionInSpace` and `clearSelectionInSpace` write through `writeSelectionSpace`, so the
    // old inline-only predicate returned false for both — sites #4 and #5 of this defect's own
    // history were invisible to the assertion that claimed to cover them. Asserting detection
    // POSITIVELY means the scan's blind spot cannot silently widen back over them.
    const byName = Object.fromEntries(storeActions().map(a => [a.name, a]))
    expect(touchesSelection(byName.setSelectionInSpace.body)).toBe(true)
    expect(touchesSelection(byName.clearSelectionInSpace.body)).toBe(true)
    // `hydrate` writes the ids fields too, so the ids-scan must see it — it is exempted by NAME on
    // the allowlist, never by being invisible, or the allowlist would be decorative.
    expect(touchesSelection(byName.hydrate.body)).toBe(true)
    // `setSelectionProvenance` is deliberately NOT in this set: it writes only `selectionProvenance`
    // (the recipe), never an ids field, so an ids-write scan correctly does not flag it. Its
    // exemption rests on `rawSelectionWrite`, which the next assertion pins.
    expect(touchesSelection(byName.setSelectionProvenance.body)).toBe(false)
    expect(byName.setSelectionProvenance.wrapper).toBe('rawSelectionWrite')
  })

  it('the non-vacuity floor counts SELECTION actions, not all actions (CONV-19)', () => {
    // The old `actions.length >= 10` counted all 15 actions, so every selection assertion could go
    // vacuous — all selection actions dropping out of the scan would still clear the floor on
    // `setViewState`/`setColorScale`/… alone.
    const seen = storeActions().filter(a => touchesSelection(a.body)).map(a => a.name)
    expect(seen).toEqual(
      expect.arrayContaining([
        'setPointSelection',
        'setSelection',
        'clearSelection',
        'setSelectionInSpace',
        'clearSelectionInSpace',
        'hydrate',
      ]),
    )
    expect(seen.length).toBeGreaterThanOrEqual(6)
  })

  it('EVERY action that writes a selection field routes through selectionMutation', () => {
    const offenders = storeActions()
      .filter(a => touchesSelection(a.body))
      .filter(a => !RAW_WRITE_ALLOWLIST.includes(a.name))
      .filter(a => a.wrapper !== 'selectionMutation')
      .map(a => `${a.name} (wrapper: ${a.wrapper ?? 'NONE — raw set()'})`)

    // A future action #6 that mutates a selection field with a bare `set(s => …)` lands here the
    // day it is written. That is the entire point: nobody has to remember to update this file.
    expect(offenders).toEqual([])
  })

  it('only the two recipe-writing actions use the rawSelectionWrite escape hatch', () => {
    const raw = storeActions()
      .filter(a => a.wrapper === 'rawSelectionWrite')
      .map(a => a.name)
      .sort()
    expect(raw).toEqual([...RAW_WRITE_ALLOWLIST].sort())
  })

  it('the escape hatch is named loudly enough to be greppable', () => {
    // If someone renames it to something innocuous, this guard's allowlist stops meaning anything.
    expect(SRC).toContain('function rawSelectionWrite(')
    expect(SRC).toContain('function selectionMutation(')
  })
})
