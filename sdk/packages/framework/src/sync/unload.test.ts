import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R2-G5 — the unload signal. The SyncClient (and the app's agent stream)
 * must not warn "stream ended; reconnecting" when the stream was torn down
 * because the page is going away: `pagehide` → the signal is true (log at
 * debug), `pageshow` (a bfcache restore) → false again (a genuine drop is
 * worth a warn). One page, one flag, one truth.
 */

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

async function loadUnload() {
  vi.resetModules()
  listeners.clear()
  vi.stubGlobal('window', windowStub)
  return import('./unload')
}

beforeEach(() => {
  listeners.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sync unload signal (R2-G5)', () => {
  it('registers pagehide/pageshow listeners on the window', async () => {
    await loadUnload()
    expect(listeners.has('pagehide')).toBe(true)
    expect(listeners.has('pageshow')).toBe(true)
  })

  it('is false at load, true after pagehide, false again after pageshow', async () => {
    const { isDocumentUnloading } = await loadUnload()
    expect(isDocumentUnloading()).toBe(false)
    fire('pagehide')
    expect(isDocumentUnloading()).toBe(true)
    fire('pageshow')
    expect(isDocumentUnloading()).toBe(false)
  })

  it('works without a window (node/SSR — the client is never started there)', async () => {
    vi.resetModules()
    vi.stubGlobal('window', undefined)
    const { isDocumentUnloading } = await import('./unload')
    expect(isDocumentUnloading()).toBe(false)
  })
})
