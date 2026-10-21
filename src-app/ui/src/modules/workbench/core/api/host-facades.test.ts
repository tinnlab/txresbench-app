// TEST-14 (ITEM-13) — storage namespace isolation + the events bridge.
//
// ITEM-35 deleted this file's first subject: the `commands` facade
// (`createCommandsApi`) was the WRITE side of the `commands` registry, and NOTHING in
// production ever called it (`api.commands.register` has zero production call sites), so
// it went with the registry. Its two cases — dispatch, and the CONC-1 ownership-guarded
// late-dispose — are deleted with their subject, not re-pointed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorageApi, createEventsApi } from './host-facades.ts'
import { makeFakeHost } from '../__testutil__/fakes.ts'

test('TEST-14: storage namespaces are isolated per extension', async () => {
  const backend = makeFakeHost().storage
  const a = createStorageApi(backend, 'ext-a')
  const b = createStorageApi(backend, 'ext-b')
  await a.set('k', 'from-a')
  assert.equal(await a.get('k'), 'from-a')
  assert.equal(await b.get('k'), null, 'b cannot read a key')
  assert.deepEqual(await a.keys(), ['k'])
  assert.deepEqual(await b.keys(), [])
})

test('TEST-14: events bridge to the injected bus AND dispose unsubscribes', () => {
  let onCalls = 0
  let disposed = 0
  let emitted: unknown = null
  const bus = {
    on: (_e: string, _cb: (p: unknown) => void) => {
      onCalls++
      return { dispose: () => void disposed++ }
    },
    emit: (_e: string, p: unknown) => void (emitted = p),
  }
  const events = createEventsApi(bus)
  const d = events.on('sync:artifact', () => {})
  events.emit('sync:artifact', { id: 'x' })
  assert.equal(onCalls, 1)
  assert.deepEqual(emitted, { id: 'x' })
  // dispose MUST propagate to the bus's unsubscribe (not just be a function).
  d.dispose()
  assert.equal(disposed, 1)
})
