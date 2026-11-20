import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The agent stream is opened with a hand-rolled `fetch` (EventSource cannot set
 * headers), so it must carry the desktop's local-API key itself: the embedded
 * server refuses any request without it.
 */

vi.mock('@txresbench/framework/api-client', () => ({
  getAuthToken: () => 'test-token',
  getBaseUrl: async () => 'http://agent.test',
  getExtraHeaders: async () => ({ 'X-TxR-Local-Key': 'run-key' }),
  callAsync: vi.fn(),
}))
vi.mock('@txresbench/framework/sync', () => ({ isDocumentUnloading: () => false }))

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
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

describe('actions engine agent stream', () => {
  it('sends the local-API key header with the bearer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { start, stop } = await import('./engine')
    start()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('http://agent.test/api/mcp/agent/stream?session_id=')
    expect(init.headers['X-TxR-Local-Key']).toBe('run-key')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    stop()
  })
})
