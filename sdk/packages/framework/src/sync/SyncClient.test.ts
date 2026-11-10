import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R2-G5 — the stream-ended log level, under the REAL connect loop.
 *
 * help-r2.md measured "[sync] stream ended; reconnecting" on 52 of 56 page
 * loads: the long-lived SSE stream is cut when the page navigates or closes,
 * and the reconnect warning was noise the page load produced by itself. The
 * fix is the report's own direction — an unloading document logs at DEBUG,
 * while a genuine drop on a live page stays a WARN (the reconnect loop
 * itself is untouched; only the level + the wording follow the signal).
 *
 * `getBaseUrl`/`getAuthToken` are mocked (the api-client core); `fetch`
 * rejects like a torn-down stream does. `window` is stubbed BEFORE the
 * module loads so the pagehide/pageshow listeners register (the browser
 * case; the no-window case is `unload.test.ts`).
 */

vi.mock('../api-client/core', () => ({
  getAuthToken: () => 'test-token',
  getBaseUrl: async () => 'http://sync.test',
}))

type Listener = () => void
const listeners = new Map<string, Listener[]>()

function fire(type: string): void {
  for (const fn of listeners.get(type) ?? []) fn()
}

const windowStub = {
  addEventListener: (type: string, fn: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn])
  },
  removeEventListener: () => {},
}

async function loadClient() {
  vi.resetModules()
  listeners.clear()
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('network error')
    }),
  )
  return import('./SyncClient')
}

beforeEach(() => {
  listeners.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SyncClient stream-end log level (R2-G5)', () => {
  it('warns on a genuine drop while the page is alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const { startSyncClient, stopSyncClient } = await loadClient()
    startSyncClient()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    const [message] = warn.mock.calls[0]
    expect(String(message)).toContain('[sync] stream ended; reconnecting')
    expect(debug).not.toHaveBeenCalled()
    stopSyncClient()
  })

  it('logs at debug — never warn — when the document is unloading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const { startSyncClient, stopSyncClient } = await loadClient()
    fire('pagehide')
    startSyncClient()
    await vi.waitFor(() => expect(debug).toHaveBeenCalled())
    const [message] = debug.mock.calls[0]
    expect(String(message)).toContain('[sync] stream ended as the page unloads; reconnecting')
    expect(warn).not.toHaveBeenCalled()
    stopSyncClient()
  })
})
