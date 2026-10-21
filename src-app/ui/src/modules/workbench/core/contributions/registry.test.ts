// TEST-3 (ITEM-3) — the generic Registry primitive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from './registry.ts'
import type { Contribution } from './types.ts'

function contrib(id: string, extra: Partial<Contribution> = {}): Contribution {
  return { id, extensionId: 'ext', apiVersion: '^1.0', title: id, ...extra }
}

test('TEST-3: register is idempotent-by-id (last wins) with a warn', () => {
  const warnings: string[] = []
  const orig = console.warn
  console.warn = (m: string) => void warnings.push(m)
  try {
    const r = new Registry<Contribution>('analyses')
    r.register(contrib('a', { title: 'first' }))
    r.register(contrib('a', { title: 'second' }))
    assert.equal(r.size, 1)
    assert.equal(r.get('a')?.title, 'second')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /re-registered/)
  } finally {
    console.warn = orig
  }
})

test('TEST-3: all() is stable — order then id', () => {
  const r = new Registry<Contribution>('views')
  r.register(contrib('z', { order: 1 }))
  r.register(contrib('a', { order: 1 }))
  r.register(contrib('m', { order: 0 }))
  assert.deepEqual(
    r.all().map(c => c.id),
    ['m', 'a', 'z'],
  )
})

test('TEST-3: byCategory groups + remove unregisters', () => {
  const r = new Registry<Contribution>('analyses')
  r.register(contrib('a', { category: 'qc' }))
  r.register(contrib('b', { category: 'cluster' }))
  r.register(contrib('c', { category: 'qc' }))
  assert.deepEqual(
    r.byCategory('qc').map(c => c.id),
    ['a', 'c'],
  )
  r.remove('a')
  assert.equal(r.has('a'), false)
  assert.equal(r.byCategory('qc').length, 1)
})
