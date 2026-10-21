// TEST-22 (ITEM-21) — the built-in discovery topo-sort (dependency order, cycle
// detection, zero-extension tolerance).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topoSortByDependencies, DependencyCycleError } from './topoSort.ts'

test('TEST-22: orders built-ins so a dependency precedes its dependents', () => {
  const out = topoSortByDependencies([
    { id: 'clustering', dependencies: ['embedding'] },
    { id: 'embedding', dependencies: ['data-io'] },
    { id: 'data-io' },
  ]).map(m => m.id)
  assert.ok(out.indexOf('data-io') < out.indexOf('embedding'))
  assert.ok(out.indexOf('embedding') < out.indexOf('clustering'))
})

test('TEST-22: tolerates a ZERO-extension set (fresh tree no-op)', () => {
  assert.deepEqual(topoSortByDependencies([]), [])
})

test('TEST-22: an unknown dependency does not constrain ordering (not fatal)', () => {
  const out = topoSortByDependencies([{ id: 'a', dependencies: ['not-present'] }]).map(m => m.id)
  assert.deepEqual(out, ['a'])
})

test('TEST-22: a dependency cycle throws DependencyCycleError', () => {
  assert.throws(
    () =>
      topoSortByDependencies([
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['a'] },
      ]),
    (e: unknown) => e instanceof DependencyCycleError,
  )
})
