// TEST-8 (ITEM-7) — the WhenClause evaluator (subtype-aware).
// TEST-406/407/408 (ITEM-36) — value-predicate arms + back-compat + params pruning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWhen } from './when.ts'
import type { WhenClause } from './when.ts'
import { fakeLattice } from '../__testutil__/fakes.ts'
import { visibleFields, pruneHiddenParams } from '../form/schema-types.ts'
import type { ParamsSchema } from '../form/schema-types.ts'

const ctx = (produced: string[]) => ({ producedTypeIds: produced })

/** a context with sibling field VALUES threaded (ITEM-36). */
const vctx = (values: Record<string, unknown>, produced: string[] = []) => ({
  producedTypeIds: produced,
  values,
})

test('TEST-8: has:<id> is subtype-aware', () => {
  // has:matrix is satisfied by a produced embedding (embedding isA matrix).
  assert.equal(evaluateWhen({ has: 'matrix' }, ctx(['embedding']), fakeLattice), true)
  assert.equal(evaluateWhen({ has: 'matrix' }, ctx(['clustering']), fakeLattice), false)
  assert.equal(evaluateWhen({ has: 'embedding' }, ctx(['embedding']), fakeLattice), true)
})

// ITEM-9 deleted the `{hasSelection:true}` arm with the workbench selection feature, so
// this case keeps ONLY its boolean-combinator half (the selection assertions had no arm
// left to evaluate — they are removed, not weakened into a tautology).
test('TEST-8: boolean combinators', () => {
  const clause: WhenClause = { and: [{ has: 'embedding' }, { not: { has: 'clustering' } }] }
  assert.equal(evaluateWhen(clause, ctx(['embedding']), fakeLattice), true)
  assert.equal(evaluateWhen(clause, ctx(['embedding', 'clustering']), fakeLattice), false)
  assert.equal(evaluateWhen({ or: [{ has: 'de' }, { has: 'embedding' }] }, ctx(['embedding']), fakeLattice), true)
  assert.equal(evaluateWhen(true, ctx([]), fakeLattice), true)
  assert.equal(evaluateWhen(false, ctx([]), fakeLattice), false)
})

test('TEST-406: value-predicate arms (eq/neq/in/gt/lt/exists) read ctx.values, composing with and/or/not + has', () => {
  const v = vctx({ method: 'leiden', resolution: 1.2, mode: 'advanced', label: '' })
  // eq / neq
  assert.equal(evaluateWhen({ field: 'method', eq: 'leiden' }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'method', eq: 'louvain' }, v, fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'method', neq: 'louvain' }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'method', neq: 'leiden' }, v, fakeLattice), false)
  // in
  assert.equal(evaluateWhen({ field: 'method', in: ['leiden', 'louvain'] }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'method', in: ['walktrap'] }, v, fakeLattice), false)
  // gt / lt (numeric; a non-number value ⇒ false)
  assert.equal(evaluateWhen({ field: 'resolution', gt: 1 }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'resolution', gt: 2 }, v, fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'resolution', lt: 2 }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'method', gt: 0 }, v, fakeLattice), false) // string ⇒ false
  // exists — a present but EMPTY string is non-nullish ⇒ exists:true holds
  assert.equal(evaluateWhen({ field: 'resolution', exists: true }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'label', exists: true }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'missing', exists: true }, v, fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'missing', exists: false }, v, fakeLattice), true)
  // composition: value-predicate AND a datatype clause, OR/NOT.
  assert.equal(
    evaluateWhen(
      { and: [{ field: 'mode', eq: 'advanced' }, { has: 'embedding' }] },
      vctx({ mode: 'advanced' }, ['embedding']),
      fakeLattice,
    ),
    true,
  )
  assert.equal(
    evaluateWhen({ and: [{ field: 'mode', eq: 'advanced' }, { has: 'embedding' }] }, vctx({ mode: 'basic' }, ['embedding']), fakeLattice),
    false,
  )
  assert.equal(evaluateWhen({ not: { field: 'method', eq: 'louvain' } }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ or: [{ field: 'method', eq: 'x' }, { has: 'embedding' }] }, vctx({ method: 'y' }, ['embedding']), fakeLattice), true)
})

test('TEST-406: `in` requires an ARRAY — a non-array `in` (malformed schema) is UNMET, never substring matching', () => {
  const v = vctx({ tag: 'ell' })
  // a genuine array membership works.
  assert.equal(evaluateWhen({ field: 'tag', in: ['ell', 'x'] }, v, fakeLattice), true)
  assert.equal(evaluateWhen({ field: 'tag', in: ['x', 'y'] }, v, fakeLattice), false)
  // a NON-array `in` must NOT fall into String.prototype.includes substring matching
  // ('hello'.includes('ell') === true would have leaked through).
  assert.equal(evaluateWhen({ field: 'tag', in: 'hello' as unknown as unknown[] }, v, fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'tag', in: null as unknown as unknown[] }, v, fakeLattice), false)
})

test('TEST-407: back-compat — evaluateWhen keeps 3 args; a context with no `values` resolves has/boolean and treats a value-predicate as UNMET (never throws)', () => {
  // No `values` threaded (a pure datatype-gating caller). has/boolean unaffected.
  assert.equal(evaluateWhen({ has: 'matrix' }, ctx(['embedding']), fakeLattice), true)
  assert.equal(evaluateWhen(true, ctx([]), fakeLattice), true)
  // A value-predicate with no `values` is UNMET (not a throw) — for every op, incl. exists:false.
  assert.doesNotThrow(() => evaluateWhen({ field: 'x', eq: 'y' }, ctx([]), fakeLattice))
  assert.equal(evaluateWhen({ field: 'x', eq: 'y' }, ctx([]), fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'x', exists: false }, ctx([]), fakeLattice), false)
  assert.equal(evaluateWhen({ field: 'x', gt: 0 }, ctx([]), fakeLattice), false)
  // A datatype clause still evaluates even when it's ANDed with an (unmet) value-predicate.
  assert.equal(evaluateWhen({ or: [{ has: 'matrix' }, { field: 'x', eq: 'y' }] }, ctx(['embedding']), fakeLattice), true)
})

test('TEST-408: a params-pruning pass excludes any field whose `when` is false from BOTH validation and the submitted params', () => {
  // FLAT, because a schema has no other shape: the `steps:` half of this case (a WHOLE step
  // gated off by `when`) went with the stepped form, which was deleted as unreachable. The
  // field-level half below is the live behaviour and is unchanged — `pruneHiddenParams` is
  // still the reason a hidden control's stale value never reaches a run.
  const schema: ParamsSchema = {
    fields: [
      { id: 'mode', type: 'enum', options: ['basic', 'advanced'] },
      // a sibling field visible only in advanced mode.
      { id: 'tuning', type: 'number', when: { field: 'mode', eq: 'advanced' } },
      { id: 'seed', type: 'number', when: { field: 'mode', eq: 'advanced' } },
    ],
  }

  // basic mode → the two advanced-only fields are excluded.
  const basicValues = { mode: 'basic', tuning: 99, seed: 7, note: 'kept' }
  const visBasic = visibleFields(schema, basicValues, ctx([]), fakeLattice).map(f => f.id)
  assert.deepEqual(visBasic, ['mode'])
  const prunedBasic = pruneHiddenParams(schema, basicValues, ctx([]), fakeLattice)
  assert.deepEqual(prunedBasic, { mode: 'basic', note: 'kept' }) // tuning + seed stripped; non-field `note` kept

  // advanced mode → both re-enter and their values survive.
  const advValues = { mode: 'advanced', tuning: 99, seed: 7 }
  const visAdv = visibleFields(schema, advValues, ctx([]), fakeLattice).map(f => f.id)
  assert.deepEqual(visAdv.sort(), ['mode', 'seed', 'tuning'])
  assert.deepEqual(pruneHiddenParams(schema, advValues, ctx([]), fakeLattice), advValues)
})
