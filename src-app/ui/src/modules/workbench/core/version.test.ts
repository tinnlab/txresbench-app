// TEST-2 (ITEM-2) — the apiVersion compatibility gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApiVersionCompatible, WORKBENCH_API_VERSION } from './version.ts'

test('TEST-2: accepts in-range apiVersion ranges against 1.0.0', () => {
  assert.equal(WORKBENCH_API_VERSION, '1.0.0')
  for (const range of ['^1.0', '^1.0.0', '1.x', '1.0.x', '1', '1.0', '>=1.0 <2.0.0', '>=1.0.0', '1.0.0']) {
    assert.equal(isApiVersionCompatible(range), true, `expected ${range} compatible`)
  }
})

test('TEST-2: refuses out-of-range apiVersion (fail-closed)', () => {
  for (const range of ['^2.0', '2.x', '>=2.0.0', '<1.0.0', '0.9', '^0.9', 'garbage', '']) {
    assert.equal(isApiVersionCompatible(range), false, `expected ${range} incompatible`)
  }
})

test('TEST-2: caret honors the left-most non-zero component', () => {
  assert.equal(isApiVersionCompatible('^1.2.0', '1.5.0'), true)
  assert.equal(isApiVersionCompatible('^1.2.0', '2.0.0'), false)
  assert.equal(isApiVersionCompatible('^0.2.0', '0.2.9'), true)
  assert.equal(isApiVersionCompatible('^0.2.0', '0.3.0'), false)
})

test('TEST-2: a space after the comparator operator is accepted (audit CORR-1 regression)', () => {
  assert.equal(isApiVersionCompatible('>= 1.0.0', '1.0.0'), true)
  assert.equal(isApiVersionCompatible('>= 1.0.0 <2.0.0', '1.4.0'), true)
  assert.equal(isApiVersionCompatible('>= 2.0.0', '1.0.0'), false)
})
