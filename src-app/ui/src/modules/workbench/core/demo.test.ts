// TEST-24 (ITEM-22) — the dogfood built-in registers through the PUBLIC API only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workbenchRegistry, resetWorkbenchRegistry } from './contributions/workbenchRegistry.ts'
import { registerDemoExtension } from './__testutil__/demoExtension.ts'
import { Registry } from './contributions/registry.ts'
import { fakeLattice } from './__testutil__/fakes.ts'

test('TEST-24: the dogfood registers its analysis + view via the public API only', () => {
  resetWorkbenchRegistry()
  registerDemoExtension()
  const leiden = workbenchRegistry.analyses.get('demo.leiden')
  assert.ok(leiden, 'demo.leiden registered')
  assert.deepEqual(leiden!.produces, ['clustering'])
  assert.ok(workbenchRegistry.views.get('demo.clustering-result'), 'demo result view registered')

  // The acceptance proof also exercises availability against the real lattice
  // shape: demo.leiden lights up once an embedding exists, gated otherwise.
  assert.equal(Registry.availability(leiden!, ['embedding'], fakeLattice), true)
  assert.equal(Registry.availability(leiden!, ['clustering'], fakeLattice), false)
  resetWorkbenchRegistry()
})
