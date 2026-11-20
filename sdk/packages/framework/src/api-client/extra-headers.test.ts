import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  callAsync,
  getExtraHeaders,
  setAuthTokenProvider,
  setBaseUrlResolver,
  setExtraHeadersProvider,
} from './core.ts'
import { __resetInflightForTests } from './inflight.ts'

// The injectable extra-request-headers provider: headers an app needs on EVERY
// request (the desktop's local-API key), learned asynchronously. The transport
// must send them on every request, must wait for them before it sends anything,
// and must change nothing when no provider is registered.

function stubFetch(impl: (url: string, init?: any) => Promise<Response>): () => void {
  const prev = globalThis.fetch
  ;(globalThis as any).fetch = impl
  return () => {
    ;(globalThis as any).fetch = prev
  }
}

const ok = () =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

function setup(): void {
  setAuthTokenProvider(() => 'test-token')
  setBaseUrlResolver(async () => 'http://stub.invalid')
  setExtraHeadersProvider(null)
  __resetInflightForTests()
}

test('EXTRAHDR-1: default sends no extra header', async () => {
  setup()
  assert.deepEqual(await getExtraHeaders(), {})
  let seen: Record<string, string> = {}
  const restore = stubFetch(async (_u, init) => {
    seen = init.headers
    return ok()
  })
  try {
    await callAsync('GET /api/x', {})
  } finally {
    restore()
  }
  assert.equal(seen['X-TxR-Local-Key'], undefined)
  assert.equal(seen['Authorization'], 'Bearer test-token')
})

test('EXTRAHDR-2: the injected headers go on GET and POST, next to the bearer', async () => {
  setup()
  setExtraHeadersProvider(async () => ({ 'X-TxR-Local-Key': 'run-key' }))
  const seen: Array<Record<string, string>> = []
  const restore = stubFetch(async (_u, init) => {
    seen.push(init.headers)
    return ok()
  })
  try {
    await callAsync('GET /api/x', {})
    await callAsync('POST /api/y', { a: 1 })
  } finally {
    restore()
    setExtraHeadersProvider(null)
  }
  assert.equal(seen.length, 2)
  for (const h of seen) {
    assert.equal(h['X-TxR-Local-Key'], 'run-key')
    assert.equal(h['Authorization'], 'Bearer test-token')
  }
  assert.equal(seen[1]['Content-Type'], 'application/json')
})

test('EXTRAHDR-3: nothing is sent before the provider has resolved', async () => {
  setup()
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  setExtraHeadersProvider(async () => {
    await gate // the host (Tauri IPC) has not answered yet
    return { 'X-TxR-Local-Key': 'late-key' }
  })
  let fetched = 0
  let seen: Record<string, string> = {}
  const restore = stubFetch(async (_u, init) => {
    fetched++
    seen = init.headers
    return ok()
  })
  try {
    const pending = callAsync('GET /api/x', {})
    await new Promise(r => setTimeout(r, 20))
    assert.equal(fetched, 0, 'no request may leave before the key is known')
    release()
    await pending
    assert.equal(fetched, 1)
    assert.equal(seen['X-TxR-Local-Key'], 'late-key')
  } finally {
    restore()
    setExtraHeadersProvider(null)
  }
})

test('EXTRAHDR-4: a provider that fails fails the request; none is sent', async () => {
  setup()
  setExtraHeadersProvider(async () => {
    throw new Error('ipc not ready')
  })
  let fetched = 0
  const restore = stubFetch(async () => {
    fetched++
    return ok()
  })
  try {
    await assert.rejects(callAsync('GET /api/x', {}), /ipc not ready/)
    assert.equal(fetched, 0)
  } finally {
    restore()
    setExtraHeadersProvider(null)
  }
})
