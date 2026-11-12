import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TEST-QF2-3 (R2-G5) — the agent stream's reconnect log level.
 *
 * help-r2.md measured "[actions] agent stream ended; reconnecting" on 30 of
 * 56 page loads — the same teardown-noise class as the sync stream: the
 * SSE is cut when the page navigates or closes. The engine answers the ONE
 * unload signal the SDK sync module owns (`@txresbench/framework/sync`'s
 * `isDocumentUnloading`, driven by pagehide/pageshow): an unloading page
 * logs at debug, a genuine drop on a live page stays a warn. The reconnect
 * loop itself is untouched.
 *
 * The api-client transport is mocked (the loop's token/base URLs) and
 * `fetch` rejects like a torn-down stream; `sessionStorage` is stubbed for
 * the engine's per-tab session id (node has no DOM session storage).
 */

vi.mock('@txresbench/framework/api-client', () => ({
  getAuthToken: () => 'test-token',
  getBaseUrl: async () => 'http://agent.test',
  callAsync: vi.fn(),
}))

const unloading = { current: false }
vi.mock('@txresbench/framework/sync', () => ({
  isDocumentUnloading: () => unloading.current,
}))

const storage = new Map<string, string>()

beforeEach(() => {
  unloading.current = false
  storage.clear()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v)
    },
    removeItem: (k: string) => {
      storage.delete(k)
    },
    clear: () => storage.clear(),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('network error')
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function liveEngine() {
  const mod = await import('./engine')
  return mod
}

describe('actions engine stream-end log level (R2-G5)', () => {
  it('warns on a genuine drop while the page is alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const { start, stop } = await liveEngine()
    start()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    const [message] = warn.mock.calls[0]
    expect(String(message)).toContain('[actions] agent stream ended; reconnecting')
    expect(debug).not.toHaveBeenCalled()
    stop()
  })

  it('logs at debug — never warn — when the document is unloading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const { start, stop } = await liveEngine()
    unloading.current = true
    start()
    await vi.waitFor(() => expect(debug).toHaveBeenCalled())
    const [message] = debug.mock.calls[0]
    expect(String(message)).toContain('[actions] agent stream ended as the page unloads; reconnecting')
    expect(warn).not.toHaveBeenCalled()
    stop()
  })
})
