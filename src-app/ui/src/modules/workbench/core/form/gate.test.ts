// TEST-512 (ITEM-52) — `readWidgetGate` reads an embedded submit gate off an arbitrary
// widget value. PROVENANCE: ported out of `core/interaction/summarize.test.ts` (the rest
// of that file covered the deleted `summarize` evaluator + `deriveSubmitGate`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readWidgetGate } from './gate.ts'

test('TEST-512: readWidgetGate reads an embedded gate off a widget value', () => {
  assert.deepEqual(readWidgetGate({ gate: { canSubmit: false, reason: 'x' } }), { canSubmit: false, reason: 'x' })
  assert.deepEqual(readWidgetGate({ gate: { canSubmit: true } }), { canSubmit: true })
})

test('TEST-512: a value with no (or a malformed) gate reads as null — never blocks Run', () => {
  assert.equal(readWidgetGate({ nope: 1 }), null)
  assert.equal(readWidgetGate(null), null)
  assert.equal(readWidgetGate('a string'), null)
  assert.equal(readWidgetGate({ gate: { canSubmit: 'yes' } }), null)
})
