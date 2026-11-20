import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_KEY_HEADER, getLocalKeyHeaders, resetLocalKeyForTests } from './localKey'

// The webview learns the per-run local-API key over Tauri IPC only. In a plain
// browser (no Tauri global) there is nothing to send.

beforeEach(() => {
  resetLocalKeyForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLocalKeyHeaders', () => {
  it('sends nothing outside the desktop webview', async () => {
    expect(await getLocalKeyHeaders()).toEqual({})
  })

  it('reads the key from get_api_secret once and sends it as X-TxR-Local-Key', async () => {
    const invoke = vi.fn(async () => 'run-key-abc')
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    expect(await getLocalKeyHeaders()).toEqual({ [LOCAL_KEY_HEADER]: 'run-key-abc' })
    expect(await getLocalKeyHeaders()).toEqual({ [LOCAL_KEY_HEADER]: 'run-key-abc' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_api_secret')
    expect(LOCAL_KEY_HEADER).toBe('X-TxR-Local-Key')
  })

  it('shares one in-flight read between concurrent requests', async () => {
    const invoke = vi.fn(async () => 'k')
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    await Promise.all([getLocalKeyHeaders(), getLocalKeyHeaders(), getLocalKeyHeaders()])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects when the key cannot be read, and asks again next time', async () => {
    const invoke = vi
      .fn<(cmd: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('api secret not ready'))
      .mockResolvedValueOnce('k2')
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    await expect(getLocalKeyHeaders()).rejects.toThrow('api secret not ready')
    expect(await getLocalKeyHeaders()).toEqual({ [LOCAL_KEY_HEADER]: 'k2' })
  })
})
