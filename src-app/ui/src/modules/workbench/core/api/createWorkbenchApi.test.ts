// TEST-10 (ITEM-9) — createWorkbenchApi assembles the per-extension surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbenchApi } from './createWorkbenchApi.ts'
import { WORKBENCH_API_VERSION } from '../version.ts'
import { workbenchRegistry } from '../contributions/workbenchRegistry.ts'
import { makeFakeHost } from '../__testutil__/fakes.ts'

test('TEST-10: createWorkbenchApi returns the full capability-scoped surface', () => {
  const api = createWorkbenchApi(makeFakeHost(), 'clustering')
  assert.equal(api.version, WORKBENCH_API_VERSION)
  assert.equal(api.extensionId, 'clustering')
  assert.equal(api.registry, workbenchRegistry)
  // ITEM-7 — the EXACT field set. `data`/`compute` are gone (they are extension
  // capabilities now, reached through `capabilities`); `ui`/`storage`/`events` are HOST
  // services and stay on the handle.
  assert.deepEqual(Object.keys(api).sort(), [
    'capabilities',
    'events',
    'extensionId',
    'registry',
    'storage',
    'ui',
    'version',
  ])
  for (const service of ['capabilities', 'ui', 'storage', 'events'] as const) {
    assert.ok(api[service], `has ${service}`)
  }
  // routing is by id: nothing is published against a bare fake host.
  assert.equal(api.capabilities.resolve('data').present, false)
})
