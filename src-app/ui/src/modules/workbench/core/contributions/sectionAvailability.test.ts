// TEST-75 (ITEM-61) + TEST-A18 [acceptance] [invariant: INV-18] (ITEM-61, ITEM-1) +
// TEST-76 (ITEM-62) — a section says what KIND of data it applies to, and never who made it.
//
// ── Why this is a vitest spec and not a `node:test` one ────────────────────────────────
//
// TESTS.md puts TEST-75 in `core/contributions/availability.test.ts`. That file is a
// `node --test --experimental-strip-types` suite and it injects `fakeLattice` — which the
// phase-2 audit already identified as the hazard here: `__testutil__/fakes.ts` and
// `identityLattice` both IGNORE `capabilities` and return `true`, so a capability-only
// assertion written there passes VACUOUSLY, whatever the implementation does. The audit's
// own remedy is "pin it against the REAL registry", and the real registry is a
// bundler-resolved module the node tier cannot import. So the spec lives beside it, in the
// tier that can. TESTS.md is amended.
//
// The fixture datatypes are neutral — no domain vocabulary anywhere. A capability-only
// selector is about a DECLARED capability, and a fixture spelling a shipped datatype's name
// would let an implementation that recognised the name pass.

import { beforeEach, describe, expect, it } from 'vitest'

import { datatypeRegistry } from '@/core/datatypes/registry'
import { workbenchLattice } from '@/modules/workbench/core/host/createHost'
import { fakeLattice } from '@/modules/workbench/core/__testutil__/fakes'
import { computeAvailability } from './availability'
import type { SectionContribution } from './types'

/** A section, with only the fields availability reads. */
function section(id: string, appliesTo: SectionContribution['appliesTo']): SectionContribution {
  return {
    id,
    extensionId: 'probe',
    apiVersion: '^1.0',
    title: id,
    pane: 'visualize',
    appliesTo,
    views: [{ view_id: `${id}.view`, view_spec: { id, title: id, permission: 'projects::use', state: {}, widgets: [], actions: [] } }],
  } as unknown as SectionContribution
}

const PLOTTABLE = 'probe/positions'
const FLAT = 'probe/notes'
const CAPABILITY = 'probe-plottable'

beforeEach(() => {
  // The REAL registry, loaded with a neutral two-type lattice: one DECLARING the capability
  // and one not. `replaceAll` is the registry's own boot path, so this is the production
  // matcher answering a production-shaped question.
  datatypeRegistry.replaceAll([
    { id: 'probe/base', title: 'Base', is_abstract: true, capabilities: [] },
    { id: PLOTTABLE, title: 'Positions', extends: 'probe/base', capabilities: [CAPABILITY] },
    { id: FLAT, title: 'Notes', extends: 'probe/base', capabilities: [] },
  ] as never)
})

describe('a capability-only `applies_to` (TEST-75, ITEM-61)', () => {
  const s = section('probe.block', [{ capabilities: [CAPABILITY] }])

  it('matches a type that DECLARES the capability and not one that does not', () => {
    // No shipped manifest used a capability-only selector before ITEM-65, so this is the
    // day-one pin the design asked for: the shape is legal in both registries, and this
    // asserts it actually SELECTS rather than merely parsing.
    expect(computeAvailability(s, { producedTypeIds: [PLOTTABLE] }, workbenchLattice)).toBe(true)
    expect(computeAvailability(s, { producedTypeIds: [FLAT] }, workbenchLattice)).toBe(false)
    // An empty project is not "universally available" — `[].some()` is false, which is the
    // right direction for a selector (unlike `[].every()` on the selector LIST).
    expect(computeAvailability(s, { producedTypeIds: [] }, workbenchLattice)).toBe(false)
  })

  it('would pass VACUOUSLY against the fake lattice — so the real one is load-bearing here', () => {
    // The guard on the guard. `fakeLattice` ignores `capabilities` entirely, so it answers
    // `true` for the type that does NOT declare it. Asserting that difference is what stops
    // a future edit from quietly swapping the lattice back and leaving a green test that
    // proves nothing. [feedback_guard_the_state_not_the_syntax]
    expect(computeAvailability(s, { producedTypeIds: [FLAT] }, fakeLattice)).toBe(true)
    expect(computeAvailability(s, { producedTypeIds: [FLAT] }, workbenchLattice)).toBe(false)
  })
})

describe('a section states a KIND and never a producer (TEST-A18, INV-18)', () => {
  it('the selector vocabulary has no way to name one', () => {
    // The rule is unbreakable BY DECLARATION rather than by convention: `SectionSelector` is
    // the LISTING subset of `TypeSelector` (`type_id` / `subtypes_of` / `capabilities` /
    // `excludes`) and BOTH Rust parsers are `deny_unknown_fields` over exactly that set, so
    // a section naming an analysis, a package, a `slot` or a `consumes` is a PARSE error at
    // the manifest boundary and never reaches this layer at all. What is asserted here is
    // the consequence: availability reads the kind fields and has no producer input to read
    // even if one were smuggled past.
    const smuggled = section('probe.smuggled', [
      { capabilities: [CAPABILITY], analysis: 'probe.maker', package: 'probe-pkg' } as never,
    ])
    // The extra keys change NOTHING — the answer is the same as the clean selector's, so an
    // ignored producer key cannot narrow or widen what a section applies to.
    expect(computeAvailability(smuggled, { producedTypeIds: [PLOTTABLE] }, workbenchLattice)).toBe(true)
    expect(computeAvailability(smuggled, { producedTypeIds: [FLAT] }, workbenchLattice)).toBe(false)
  })
})

describe('composition adds; arbitration discards (TEST-76, ITEM-62, INV-20)', () => {
  it('several sections applying to the SAME kind are ALL available — nothing picks one', () => {
    // Under the section model this is not a policy, it is the literal answer: availability
    // is computed per section against the project's data, with no cross-section step of any
    // kind. The assertion is that there is no such step — three contributors, three trues.
    const a = section('probe.alpha', [{ capabilities: [CAPABILITY] }])
    const b = section('probe.beta', [{ capabilities: [CAPABILITY] }])
    const c = section('probe.gamma', [{ type_id: PLOTTABLE }])
    const ctx = { producedTypeIds: [PLOTTABLE] }
    expect([a, b, c].map(s => computeAvailability(s, ctx, workbenchLattice))).toEqual([true, true, true])
  })
})
