// The AUTO-MOUNT GATE's predicate.
//
// The flag that used to sit beside it — `?gateViewAutomount=1` / `VITE_GATE_VIEW_AUTOMOUNT=1`,
// its precedence rules, its latch, and the seven tests that pinned them — is GONE with the
// adoption. The whole point of those tests was that the un-flagged side was provably untouched;
// with no flag there is no un-flagged side, and a test asserting a default nobody can change is
// a test asserting nothing.
//
// What remains is the predicate itself, which is now the shipped behaviour rather than one arm
// of a switch.
//
import { describe, it, expect } from 'vitest'
import type { AnalysisContribution, Contributions, DatatypeLattice, WhenContext } from '@/modules/workbench/core'
import { isViewAutoMountable } from './viewAutomountGate'

// ── the predicate ───────────────────────────────────────────────────────────────────────────
//
// A synthetic lattice + synthetic datatype ids: the workbench app surface may carry NO domain
// datatype literal (`lint-no-domain-in-builtin.mjs`), and a gate that needed one would be the
// bug, not the test.
const LATTICE = {
  isA: (id: string, target: string) => id === target,
  matches: (id: string, sel: { type_id?: string; subtypes_of?: string }) =>
    id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
} as unknown as DatatypeLattice

/** `appliesTo` is REQUIRED by the type but OPTIONAL in practice: `loadProcessors` copies
 *  `data.appliesTo` straight off the parsed YAML, so a manifest that omits the key produces a
 *  contribution whose `appliesTo` is `undefined` at runtime. Omitting it here (behind the cast)
 *  is therefore reproducing a shape the loader really emits, not inventing one. */
function analysis(id: string, appliesTo?: AnalysisContribution['appliesTo']): AnalysisContribution {
  return {
    id,
    extensionId: 'test',
    apiVersion: '1.0.0',
    title: id,
    category: 'test',
    produces: [],
    run: { kind: 'sandbox', runtime: 'python', entry: 'x.py' },
    ...(appliesTo ? { appliesTo } : {}),
  } as AnalysisContribution
}
function registryOf(analyses: AnalysisContribution[]): Contributions {
  const byId = new Map(analyses.map(a => [a.id, a]))
  return { analyses: { get: (id: string) => byId.get(id) } } as unknown as Contributions
}
const ctx = (...ids: string[]): WhenContext => ({ producedTypeIds: ids })

describe('isViewAutoMountable gates on the OWNING analysis’ declared input type', () => {
  const reg = registryOf([analysis('a.gated', [{ slot: 'x', subtypes_of: 'test/thing' }])])

  it('an EMPTY project does not mount a view whose analysis needs a type', () => {
    expect(isViewAutoMountable('a.gated', reg, ctx(), LATTICE)).toBe(false)
  })

  it('the SAME view mounts once the project has produced that type', () => {
    expect(isViewAutoMountable('a.gated', reg, ctx('test/thing'), LATTICE)).toBe(true)
  })

  it('an unrelated produced type does NOT satisfy it', () => {
    expect(isViewAutoMountable('a.gated', reg, ctx('test/other'), LATTICE)).toBe(false)
  })

  it('EVERY declared selector is required — one satisfied of two is not enough', () => {
    const two = registryOf([
      analysis('a.two', [
        { slot: 'x', subtypes_of: 'test/thing' },
        { slot: 'y', subtypes_of: 'test/second' },
      ]),
    ])
    expect(isViewAutoMountable('a.two', two, ctx('test/thing'), LATTICE)).toBe(false)
    expect(isViewAutoMountable('a.two', two, ctx('test/thing', 'test/second'), LATTICE)).toBe(true)
  })

  it('FAILS OPEN for a view no analysis owns — nothing declares an inspected type to gate on', () => {
    expect(isViewAutoMountable('shell.something', reg, ctx(), LATTICE)).toBe(true)
  })

  it('FAILS OPEN for an analysis that declares no appliesTo at all', () => {
    const open = registryOf([analysis('a.open')])
    expect(isViewAutoMountable('a.open', open, ctx(), LATTICE)).toBe(true)
  })
})
