// TEST-8 (ITEM-1) — availability is DERIVED from `appliesTo`, and from nothing else.
// (Was TEST-4 over `accepts` + `when`, both removed by INV-1. The subtype delegation to
// the injected lattice is unchanged and still covered.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from './registry.ts'
import type { AnalysisContribution } from './types.ts'
import { computeAvailabilityWithArch } from './availability.ts'
import { fakeLattice } from '../__testutil__/fakes.ts'

function analysis(
  id: string,
  appliesTo: AnalysisContribution['appliesTo'],
  extra: Partial<AnalysisContribution> = {},
): AnalysisContribution {
  return {
    id,
    extensionId: 'ext',
    apiVersion: '^1.0',
    title: id,
    category: 'test',
    appliesTo,
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
    ...extra,
  }
}

test('TEST-8: available when a subtype satisfies an appliesTo selector', () => {
  // clustering.leiden applies to `subtypes_of: matrix`; an `embedding` isA `matrix`.
  const a = analysis('clustering.leiden', [{ subtypes_of: 'matrix' }])
  assert.equal(Registry.availability(a, ['embedding'], fakeLattice), true)
  // clustering (isA data, NOT matrix) does NOT satisfy it.
  assert.equal(Registry.availability(a, ['clustering'], fakeLattice), false)
})

test('TEST-8: EVERY appliesTo entry is required — a legacy `required:false` no longer exempts one (DEC-5)', () => {
  const exact = analysis('x', [{ type_id: 'embedding' }])
  assert.equal(Registry.availability(exact, ['embedding'], fakeLattice), true)
  assert.equal(Registry.availability(exact, ['clustering'], fakeLattice), false)
  // `accepts … required:false` used to make a selector OPTIONAL, so an analysis carrying
  // only optional entries was available against an EMPTY project. `appliesTo` has no
  // optional entries — "everything in it is required by definition" — because an optional
  // input was never an applicability condition (it is a `consumes` graph edge, or a
  // control the view offers). The flag is therefore inert and the selector still gates.
  const legacyOptional = analysis('y', [{ type_id: 'embedding', required: false }])
  assert.equal(Registry.availability(legacyOptional, [], fakeLattice), false)
  // …and it is genuinely EVALUATED, not merely refused: satisfy it and it passes.
  assert.equal(Registry.availability(legacyOptional, ['embedding'], fakeLattice), true)
})

test('TEST-8: availability is a function of `appliesTo` ALONE — the removed `when` key cannot gate', () => {
  // `when` was "a weaker restatement of `accepts` that could never independently fail"
  // (INV-1); it is off the contract, and a manifest still carrying one is refused at LOAD
  // (ITEM-25). This asserts the predicate itself no longer consults it: for the SAME
  // `appliesTo`, adding a `when` cannot change the verdict either way.
  const appliesTo: AnalysisContribution['appliesTo'] = [{ subtypes_of: 'matrix' }]
  const plain = analysis('z', appliesTo)
  const withWhen = analysis('z2', appliesTo, { when: { has: 'grouping' } })
  for (const produced of [[], ['projection'], ['projection', 'grouping'], ['grouping']]) {
    assert.equal(
      Registry.availability(withWhen, produced, fakeLattice),
      Registry.availability(plain, produced, fakeLattice),
      `a \`when\` clause changed the verdict for produced=[${produced.join(',')}]`,
    )
  }
  // control — the `appliesTo` selector itself still decides, so the equality above is not
  // an equality between two constants.
  assert.equal(Registry.availability(plain, ['projection'], fakeLattice), true)
  assert.equal(Registry.availability(plain, ['grouping'], fakeLattice), false)
})

// ITEM-9 deleted the `hasSelection` gating arm (and the 4th `Registry.availability`
// parameter that fed it) with the workbench selection feature. The CORR-2 regression it
// guarded — `Registry.availability` and `buildContributionCatalog` disagreeing because one
// copy hardcoded a context field — no longer has a field to disagree about, so the case is
// removed rather than re-pointed at an unrelated arm. The shared-predicate invariant
// itself stays covered by 'TEST-4: a when clause is ALSO required' above (both surfaces
// route through `computeAvailability`).

// ─────────────────────────── TEST-71 (ITEM-26 / DEC-29) ──────────────────────
// The CPU-arch lens: an analysis whose `arch` excludes the backend arch is
// not-runnable WITH A REASON but still LISTED (disabled, not hidden); default /
// inclusive `arch` stays runnable everywhere; arch never overrides applicability.
const noCtx = { producedTypeIds: [] as string[] }

test('TEST-71: arch:[x86_64] is not-runnable (with reason) on aarch64, runnable on x86_64 — still listed', () => {
  const proc = { appliesTo: [], arch: ['x86_64'] }
  // aarch64 backend: LISTED (available) but DISABLED (not runnable) + reason.
  const onArm = computeAvailabilityWithArch(proc, noCtx, fakeLattice, 'aarch64')
  assert.equal(onArm.available, true, 'still listed — not hidden (DEC-29)')
  assert.equal(onArm.runnable, false, 'not runnable on aarch64 — no emulation')
  assert.equal(onArm.reason, 'requires an x86_64 backend')
  // x86_64 backend: runnable, no reason.
  const onX86 = computeAvailabilityWithArch(proc, noCtx, fakeLattice, 'x86_64')
  assert.equal(onX86.available, true)
  assert.equal(onX86.runnable, true)
  assert.equal(onX86.reason, undefined)
})

test('TEST-71: arch:[x86_64,aarch64] is runnable on both arches', () => {
  const proc = { appliesTo: [], arch: ['x86_64', 'aarch64'] }
  for (const backend of ['x86_64', 'aarch64']) {
    const r = computeAvailabilityWithArch(proc, noCtx, fakeLattice, backend)
    assert.equal(r.available, true, `listed on ${backend}`)
    assert.equal(r.runnable, true, `runnable on ${backend}`)
    assert.equal(r.reason, undefined)
  }
})

test('TEST-71: no arch (default) — and empty arch — is runnable on every arch (existing processors unaffected)', () => {
  for (const backend of ['x86_64', 'aarch64', 'riscv64']) {
    const dflt = computeAvailabilityWithArch({ appliesTo: [] }, noCtx, fakeLattice, backend)
    assert.equal(dflt.runnable, true, `absent arch runnable on ${backend}`)
    const empty = computeAvailabilityWithArch({ appliesTo: [], arch: [] }, noCtx, fakeLattice, backend)
    assert.equal(empty.runnable, true, `empty arch runnable on ${backend}`)
  }
})

test('TEST-71: arch never overrides applicability — an inapplicable analysis stays hidden', () => {
  // `appliesTo` needs `matrix` but nothing is produced ⇒ not applicable ⇒ hidden,
  // regardless of an arch that WOULD otherwise run.
  const proc = { appliesTo: [{ subtypes_of: 'matrix' }], arch: ['x86_64'] }
  const r = computeAvailabilityWithArch(proc, noCtx, fakeLattice, 'x86_64')
  assert.equal(r.available, false, 'not applicable ⇒ not listed')
  assert.equal(r.runnable, false)
  assert.equal(r.reason, undefined)
})
