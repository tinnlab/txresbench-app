// The `WhenClause` availability/visibility grammar (ITEM-7 + ITEM-36) — the pure
// gating engine that lights up analyses, drives artifact-ref pickers, gates views,
// AND (ITEM-36) drives conditional-form field/step visibility from sibling field
// VALUES. Owned by P5. Subtype-aware: `has:matrix`
// is satisfied by a produced `embedding` when the injected lattice says
// `isA('embedding','matrix')`. The value-predicate arms are ADDITIVE — every
// datatype-gating caller (availability, view placement) keeps passing a context
// without `values` and behaves identically; a value-predicate with no `values`
// threaded is UNMET (never a throw), so a schema that mixes both is always total.

import type { DatatypeLattice } from './lattice.ts'

/** A predicate over ONE sibling field's current VALUE (ITEM-36). `field` names the
 *  sibling param id; the op reads `ctx.values[field]`. Composes with and/or/not and
 *  the datatype arm (`has`). Statically analyzable — exactly one op key per clause. */
export type ValuePredicate =
  | { field: string; eq: unknown } // strict `===` (primitives; not deep-equal)
  | { field: string; neq: unknown } // strict `!==`
  | { field: string; in: unknown[] } // membership (`Array.includes`; a non-array `in` ⇒ unmet, never substring matching)
  | { field: string; gt: number } // numeric `>` (non-number value ⇒ false)
  | { field: string; lt: number } // numeric `<` (non-number value ⇒ false)
  | { field: string; exists: boolean } // `true`: value is non-nullish; `false`: nullish/absent

/** A boolean gating expression over the project's artifact catalog + (ITEM-36)
 *  sibling field values.
 *
 *  ITEM-9 removed the `{hasSelection:true}` arm along with the workbench selection
 *  feature: nothing produced a selection any more, so the arm could only ever be
 *  unmet — a gate that silently hides its subject forever is worse than no gate. */
export type WhenClause =
  | { has: string } // a produced datatype of this id (subtype-aware) exists
  | ValuePredicate // ITEM-36 — a sibling field-VALUE predicate
  | { and: WhenClause[] }
  | { or: WhenClause[] }
  | { not: WhenClause }
  | true // always available
  | false // never

/** The gating context: produced datatypes and (ITEM-36) the current form field
 *  values. `values` is OPTIONAL — pure datatype-gating callers omit it (a
 *  value-predicate then resolves as unmet, keeping the evaluator total). */
export interface WhenContext {
  producedTypeIds: string[]
  /** current form field values (id → value) — read only by value-predicate arms. */
  values?: Record<string, unknown>
}

/** Is this clause a sibling-field value-predicate? (exactly the ITEM-36 arms). */
function isValuePredicate(when: Exclude<WhenClause, boolean>): when is ValuePredicate {
  return 'field' in when
}

/** Evaluate a value-predicate against the threaded form values. With NO values
 *  threaded, EVERY value-predicate (incl. `exists:false`) is unmet — the additive,
 *  back-compat rule that keeps datatype-only callers unaffected. */
function evalValuePredicate(p: ValuePredicate, values: Record<string, unknown> | undefined): boolean {
  if (!values) return false
  const v = values[p.field]
  if ('eq' in p) return v === p.eq
  if ('neq' in p) return v !== p.neq
  // Runtime guard: an untrusted schema could carry a non-array `in` (e.g. a string).
  // Without this, `'abc'.includes(v)` would silently become SUBSTRING matching — a
  // malformed `in` must be UNMET, not a stringly-typed contains.
  if ('in' in p) return Array.isArray(p.in) && p.in.includes(v)
  if ('gt' in p) return typeof v === 'number' && v > p.gt
  if ('lt' in p) return typeof v === 'number' && v < p.lt
  // exists
  return p.exists ? v !== undefined && v !== null : v === undefined || v === null
}

/**
 * Evaluate a `WhenClause` against the context. Pure + total. `has:<id>` is
 * satisfied when ANY produced type is a subtype of (or equal to) `<id>` per the
 * injected lattice; with no lattice injected, identity match is used. A
 * value-predicate (`{field, eq|neq|in|gt|lt|exists}`) reads `ctx.values[field]`.
 */
export function evaluateWhen(
  when: WhenClause | string,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): boolean {
  if (when === true) return true
  if (when === false) return false
  // Tolerate the processor-package STRING form (`processorPackage.ts` documents `when` as a
  // `WhenClause` DATA string, e.g. `"has:single-cell/expression"`): translate it to the
  // structured `{ has }` clause. This is the form the shipped `packages/*/manifest.yaml`
  // availability gates use. A non-`has:` string is a malformed clause → UNMET (never a
  // stringly-typed match). CRITICAL: guarding this BEFORE the `in` checks below prevents
  // `'has' in <string>` from throwing a TypeError that white-screens the whole workbench.
  if (typeof when === 'string') {
    const m = /^has:(.+)$/.exec(when.trim())
    return m ? ctx.producedTypeIds.some(id => lattice.isA(id, m[1])) : false
  }
  // Any other non-object clause is malformed → unmet, not a crash (defense-in-depth, mirrors
  // the `evalValuePredicate` malformed-`in` guard).
  if (when === null || typeof when !== 'object') return false
  if ('has' in when) {
    const target = when.has
    return ctx.producedTypeIds.some(id => lattice.isA(id, target))
  }
  if (isValuePredicate(when)) {
    return evalValuePredicate(when, ctx.values)
  }
  if ('and' in when) {
    return when.and.every(w => evaluateWhen(w, ctx, lattice))
  }
  if ('or' in when) {
    return when.or.some(w => evaluateWhen(w, ctx, lattice))
  }
  if ('not' in when) {
    return !evaluateWhen(when.not, ctx, lattice)
  }
  return false
}
