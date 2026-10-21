// TEST-303 (ITEM-21) — run config input economy. A sole compatible artifact
// auto-picks (never overwriting a chosen or ambiguous field), the inputs→produces
// summary is computed, and Run is disabled-with-a-reason when a required input is
// unmet.

import { describe, expect, it } from 'vitest'
import type { AnalysisContribution } from '@/modules/workbench/core'
import {
  autoPickSoleArtifacts,
  inputsSummary,
  producesSummary,
  runGate,
  selectionSubmitGate,
} from './inputEconomy'

// The inputs are `appliesTo` SLOTS now, not `params.fields`. The old fixture declared its
// inputs twice — an unslotted `appliesTo` selector plus a `params.fields` list — and every
// helper here reads the slots, so an unslotted fixture makes each of these assertions pass
// over an EMPTY input set: `runGate` could not disable, `autoPickSoleArtifacts` could not
// pick. The slot is what carries the wire key (`inputs: { clusters: <id> }`), so it is what
// the fixture must declare.
function analysis(): AnalysisContribution {
  return {
    id: 'de.wilcoxon',
    extensionId: 'test',
    apiVersion: '^1.0',
    title: 'Differential expression',
    category: 'de',
    appliesTo: [
      // ITEM-29f — `clusters` DECLARES the auto-pick, because the specs below are about the
      // pick's own rules (sole / ambiguous / already-chosen) and would otherwise be asserting
      // those rules over a path that is now switched off. The declaration's own gate is
      // asserted separately, at the bottom of this describe.
      { slot: 'clusters', subtypes_of: 'clustering', auto_bind_sole_candidate: true },
      { slot: 'refs', subtypes_of: 'matrix', multiple: true },
    ],
    produces: ['de-table'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'de.py' },
  } as AnalysisContribution
}

describe('autoPickSoleArtifacts (ITEM-21)', () => {
  it('picks the SOLE compatible artifact for an unset single-value field', () => {
    const { patch } = autoPickSoleArtifacts(analysis(), {}, { clusters: [{ id: 'c1' }] })
    expect(patch).toEqual({ clusters: 'c1' })
  })

  it('does NOT pick when ambiguous (>1 option)', () => {
    const { patch } = autoPickSoleArtifacts(analysis(), {}, { clusters: [{ id: 'c1' }, { id: 'c2' }] })
    expect(patch).toEqual({})
  })

  it('does NOT overwrite an already-chosen field', () => {
    const { patch } = autoPickSoleArtifacts(analysis(), { clusters: 'chosen' }, { clusters: [{ id: 'c1' }] })
    expect(patch).toEqual({})
  })

  // ── TEST-90 (ITEM-29f) — the headless half of R2/INV-3 ───────────────────────────
  //
  // This site is the worse of the two ungated auto-binds the declaration had to reach: the
  // patch goes STRAIGHT into `params` from a mount effect, after which `runGate` reports the
  // form ready — so a run could launch on a binding nobody ever looked at. It has no UI at
  // all, so "the form shows what it bound" cannot happen here even in principle, which means
  // the DECLARATION is the whole of the rule rather than half of it.
  it('does NOT pick for a slot that did not DECLARE the auto-bind (DEC-15: absence is OFF)', () => {
    // Built by STRIPPING the key off the shared fixture rather than by retyping the selector:
    // a hand-copied twin can drift from the thing it is the control for.
    const { auto_bind_sole_candidate: _off, ...bare } = analysis().appliesTo![0]
    const undeclared = { ...analysis(), appliesTo: [bare] } as AnalysisContribution
    expect(autoPickSoleArtifacts(undeclared, {}, { clusters: [{ id: 'c1' }] }).patch).toEqual({})
  })

  it('an explicit `false` is the same as absence', () => {
    const off = {
      ...analysis(),
      appliesTo: [{ ...analysis().appliesTo![0], auto_bind_sole_candidate: false }],
    } as AnalysisContribution
    expect(autoPickSoleArtifacts(off, {}, { clusters: [{ id: 'c1' }] }).patch).toEqual({})
  })

  it('never auto-picks a multiple field', () => {
    const { patch } = autoPickSoleArtifacts(analysis(), {}, { refs: [{ id: 'm1' }] })
    expect(patch).toEqual({})
  })
})

// ── TEST-13 (ITEM-13) — the pick REPORTS what it bound ──────────────────────────────
//
// The caller has to record `'auto'` for the slots this bound, and the one way that record
// can be wrong is for the caller to work the set out for itself — a second implementation
// of the pick's rules, kept in step by hand until it isn't. So the function says. Every
// case below asserts the REPORT and the PATCH together: it is their agreement, in the
// refusing cases as much as in the binding one, that makes the report worth trusting.
describe('TEST-13: autoPickSoleArtifacts reports the slots it bound (ITEM-13)', () => {
  it('reports exactly the slot it patched', () => {
    const { patch, autoBound } = autoPickSoleArtifacts(analysis(), {}, { clusters: [{ id: 'c1' }] })
    expect(patch).toEqual({ clusters: 'c1' })
    expect(autoBound).toEqual(['clusters'])
  })

  it('reports NOTHING for a slot that did not DECLARE the auto-bind', () => {
    const { auto_bind_sole_candidate: _off, ...bare } = analysis().appliesTo![0]
    const undeclared = { ...analysis(), appliesTo: [bare] } as AnalysisContribution
    const { patch, autoBound } = autoPickSoleArtifacts(undeclared, {}, { clusters: [{ id: 'c1' }] })
    expect(patch).toEqual({})
    expect(autoBound).toEqual([])
  })

  it('reports NOTHING for a `multiple` slot', () => {
    const { patch, autoBound } = autoPickSoleArtifacts(analysis(), {}, { refs: [{ id: 'm1' }] })
    expect(patch).toEqual({})
    expect(autoBound).toEqual([])
  })

  it('reports NOTHING for an ALREADY-CHOSEN slot — a chosen value is not re-attributed', () => {
    // The sharp one: the value in the patch would be identical to the one already there,
    // so a caller re-deriving "what did it bind" from the resulting params would call a
    // slot the user chose auto-bound. The report cannot make that mistake.
    const { patch, autoBound } = autoPickSoleArtifacts(
      analysis(),
      { clusters: 'c1' },
      { clusters: [{ id: 'c1' }] },
    )
    expect(patch).toEqual({})
    expect(autoBound).toEqual([])
  })

  it('reports NOTHING when the candidate set is ambiguous (2+)', () => {
    const { patch, autoBound } = autoPickSoleArtifacts(
      analysis(),
      {},
      { clusters: [{ id: 'c1' }, { id: 'c2' }] },
    )
    expect(patch).toEqual({})
    expect(autoBound).toEqual([])
  })

  it('the report and the patch name the SAME slots, in every case above', () => {
    // The invariant behind all five, asserted as one statement rather than inferred from
    // them: a disagreement between the two is the defect this return shape exists to make
    // impossible, and it must fail here rather than surface as a mismarked run later.
    const cases: Record<string, { id: string }[]>[] = [
      { clusters: [{ id: 'c1' }] },
      { clusters: [{ id: 'c1' }, { id: 'c2' }] },
      { refs: [{ id: 'm1' }] },
      {},
    ]
    for (const byField of cases) {
      const { patch, autoBound } = autoPickSoleArtifacts(analysis(), {}, byField)
      expect([...autoBound].sort()).toEqual(Object.keys(patch).sort())
    }
  })
})

// ── TEST-14 (ITEM-16) — the summary carries the origin through ───────────────────────
describe('TEST-14: inputsSummary carries the origin of each entry (ITEM-16)', () => {
  it('marks ONLY the auto entry — the same artifact in another slot is not marked', () => {
    // Both slots hold artifact `c1`; only one of them was chosen by the system. If origin
    // travelled with the VALUE rather than with the binding, both would read the same.
    const s = inputsSummary(
      analysis(),
      { clusters: 'c1', refs: ['c1'] },
      { clusters: 'auto', refs: 'user' },
    )
    expect(s.find(i => i.field === 'clusters')?.origin).toBe('auto')
    expect(s.find(i => i.field === 'refs')?.origin).toBe('user')
  })

  it('an entry the map does not mention carries NO origin — absence is not `user`', () => {
    const s = inputsSummary(analysis(), { clusters: 'c1', refs: ['m1'] }, { clusters: 'auto' })
    expect(s.find(i => i.field === 'refs')?.origin).toBeUndefined()
  })

  it('called WITHOUT origins, every entry is unchanged from before the origin existed', () => {
    const before = inputsSummary(analysis(), { clusters: 'c1', refs: ['m1'] })
    expect(before).toEqual([
      { field: 'clusters', label: 'clusters', artifactId: 'c1' },
      { field: 'refs', label: 'refs', artifactId: 'm1' },
    ])
    for (const entry of before) expect(entry.origin).toBeUndefined()
  })
})

describe('summaries (ITEM-21)', () => {
  it('produces summary lists the produced datatypes', () => {
    expect(producesSummary(analysis())).toEqual(['de-table'])
  })

  it('inputs summary reflects the selected artifact', () => {
    const s = inputsSummary(analysis(), { clusters: 'c1' })
    const clusters = s.find(i => i.field === 'clusters')
    expect(clusters?.artifactId).toBe('c1')
  })
})

describe('runGate — disabled-with-reason (ITEM-21 / ITEM-52)', () => {
  it('disables Run when a required input is empty, naming it', () => {
    const gate = runGate(analysis(), {})
    expect(gate.disabled).toBe(true)
    expect(gate.reason).toContain('clusters')
  })

  it('enables Run once every required input is set', () => {
    const gate = runGate(analysis(), { clusters: 'c1', refs: ['m1'] })
    expect(gate).toEqual({ disabled: false })
  })

  // DEC-5 — EVERY `appliesTo` slot is required, `multiple` included. The old rule keyed
  // requiredness off cardinality (single ⇒ required unless it opted out, multiple ⇒ optional
  // unless it opted in), which was a property a FORM FIELD could have; an applicability
  // condition cannot. Both shipped multi-slots (qc `matrices`, cellranger `fastqs`) genuinely
  // need ≥1 artifact, and an OPTIONAL input is now a `consumes` edge or a view control.
  it('blocks an empty MULTIPLE slot too — cardinality no longer decides requiredness', () => {
    const gate = runGate(analysis(), { clusters: 'c1' })
    expect(gate.disabled).toBe(true)
    expect(gate.reason).toContain('refs')
    expect(runGate(analysis(), { clusters: 'c1', refs: [] }).disabled).toBe(true)
  })

  // ITEM-36 conditional-schema seam: a required field HIDDEN by its `when` must NOT
  // block Run (it's pruned from the submitted params, so gating on it would strand the
  // form un-runnable). The host passes the same visibility predicate SchemaForm renders.
  it('ignores a HIDDEN required input (visibility predicate excludes it)', () => {
    // `clusters` is required but currently hidden → Run enabled despite it being empty.
    const gate = runGate(analysis(), { refs: ['m1'] }, id => id !== 'clusters')
    expect(gate).toEqual({ disabled: false })
  })

  it('still blocks a VISIBLE required input when the predicate keeps it', () => {
    const gate = runGate(analysis(), { refs: ['m1'] }, () => true)
    expect(gate.disabled).toBe(true)
    expect(gate.reason).toContain('clusters')
  })
})

// ITEM-52 — the live selection submit gate reads an embedded widget gate.
describe('selectionSubmitGate (ITEM-52)', () => {
  it('disables Run when a widget value embeds an invalid gate, surfacing its reason', () => {
    const g = selectionSubmitGate({
      groups: { gate: { canSubmit: false, reason: 'Group 1 has 1 cell (min 3)' } },
      method: 'wilcoxon',
    })
    expect(g.disabled).toBe(true)
    expect(g.reason).toContain('min 3')
  })

  it('enables Run when every embedded gate is valid (or absent)', () => {
    expect(selectionSubmitGate({ groups: { gate: { canSubmit: true } }, method: 'x' })).toEqual({ disabled: false })
    expect(selectionSubmitGate({ method: 'x' })).toEqual({ disabled: false })
  })

  // ITEM-36 conditional-schema seam (mirrors `runGate`): a conditionally-HIDDEN selection
  // widget whose STALE value still embeds `canSubmit:false` must NOT strand Run — its value
  // is pruned from the submitted params, so gating on it is a phantom block. The host passes
  // the same visibility predicate SchemaForm renders with.
  it('ignores a HIDDEN widget gate (visibility predicate excludes it)', () => {
    const params = { groups: { gate: { canSubmit: false, reason: 'Group 1 has 1 cell (min 3)' } }, method: 'x' }
    // `groups` is hidden → its stale invalid gate is skipped → Run enabled.
    expect(selectionSubmitGate(params, id => id !== 'groups')).toEqual({ disabled: false })
    // still VISIBLE → the gate blocks Run (the predicate keeps it).
    const blocked = selectionSubmitGate(params, () => true)
    expect(blocked.disabled).toBe(true)
    expect(blocked.reason).toContain('min 3')
  })
})

// ITEM-64 — data-driven defaults. DELETED, not re-expressed: the property itself is gone.
//
// The three tests here drove `summaryColumnRefs` / `dataDrivenDefaultPatch` through a
// contribution declaring `params.fields[].defaultResolver` — a JS FUNCTION on a form field.
// `params` left `AnalysisContribution` with the rest of the form schema (INV-1), and a
// resolver was never representable in the YAML a manifest actually is: the loader could only
// ever have carried a string. There is no longer any way for a contribution to declare one,
// so `numberFieldsWithResolver` returns `[]` unconditionally and both helpers are empty by
// construction — a re-expression here could only assert that a stub returns nothing.
//
// Neither half of what these protected is lost:
//   * the RESOLVER ARITHMETIC (median 300 / mad 100 / 3·MAD lower / clampMin 0 ⇒ 0, and a
//     resolver over an absent column declining) is covered directly on the surviving
//     primitives in `core/form/defaults.test.ts` — same inputs, same expectations.
//   * a view that wants a data-driven starting value now computes it in its own `derived`
//     block, where the data it derives from is in scope; that mechanism has its own tests.
//
// Both helpers, their private `numberFieldsWithResolver`, and the run-panel effect that
// called them have since been REMOVED (they were the removal candidate this note named).
// Nothing replaced them: `AnalysisRunPanel` no longer builds a client data ctx or a
// `DataSummary` on mount, because there was never anything for it to summarize.

// ══════════════════════════════════════════════════════════════════════════════════════════
// TEST-6 (binding-origin / ITEM-13) — [acceptance] [invariant: INV-4] the gate does not turn
// on origin.
//
// DEC-1 is "annotate, never block", and INV-4 is *"nothing refuses on 'origin is unknown'"*.
// Those are claims about the RUN GATE, so they are asserted here, beside the gate — `core`
// may not import an extension, so the core store's own test cannot reach it (DRIFT-1.2).
//
// The reason this matters more than it looks: a refusal at the headless bind site would be
// unresolvable BY CONSTRUCTION — that path exists precisely for a caller with no form and no
// human, so a gate that fired there could never be cleared, and a refusal that never resolves
// is indistinguishable from no refusal at all. This tree has shipped that bug twice.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe('TEST-6: the run gate is a function of the params alone (INV-4 / DEC-1)', () => {
  it('takes no origins at all — the gate cannot consult one, because it is never handed one', () => {
    // Arity is weak evidence on its own (an author could read a module-level map instead), so
    // it is stated alongside the behavioural clauses below rather than as the whole proof.
    // What it does buy: folding origin into the gate requires CHANGING this signature, which
    // makes it a deliberate act rather than a quiet one.
    expect(runGate.length).toBe(3) // (analysis, params, isVisible?) — no origins parameter
    expect(selectionSubmitGate.length).toBe(2) // (params, isVisible?)
  })

  it('is a pure function of the params — same bag in, same verdict out, whatever bound it', () => {
    // The earlier form of this compared `runGate(a, {...bag})` with `runGate(a, bag)`, which is
    // a function compared with ITSELF over equal inputs — true of any pure function and so
    // true of a gate that DID read origin from somewhere. Stated properly: the verdict is
    // determined by the params, and the origins that could have produced that same bag are
    // three different histories the gate cannot distinguish because it is never told them.
    const a = analysis()
    const bag = { clusters: 'art-1', refs: ['art-2'] }
    // Three call shapes a caller might reach it by, including the one a host with an origin
    // map would use if it tried to pass one. All must agree.
    expect(runGate(a, bag)).toEqual({ disabled: false })
    expect(runGate(a, bag, () => true)).toEqual({ disabled: false })
    expect(
      (runGate as unknown as (x: unknown, y: unknown, z?: unknown, w?: unknown) => unknown)(
        a,
        bag,
        undefined,
        { clusters: 'auto' },
      ),
    ).toEqual({ disabled: false })
  })

  it('an UNSATISFIED gate is still unsatisfied, and an unknown origin does not add a refusal', () => {
    // The negative control that keeps the case above from being vacuous: the gate does have a
    // disabling verdict, it just is not this one. Without this, "same verdict" could be true of
    // a gate that never disables anything.
    const a = analysis()
    expect(runGate(a, {}).disabled).toBe(true)
    expect(runGate(a, {}).reason).toContain('clusters')
    // …and an origin-less satisfied bag is ENABLED. This is the clause that would go red if
    // anyone made "we do not know how this was bound" a reason to refuse.
    expect(runGate(a, { clusters: 'art-1', refs: ['art-2'] }).disabled).toBe(false)
  })

  it('the widget-validity gate is likewise origin-blind', () => {
    expect(selectionSubmitGate({ clusters: 'art-1', refs: ['art-2'] })).toEqual({ disabled: false })
  })
})
