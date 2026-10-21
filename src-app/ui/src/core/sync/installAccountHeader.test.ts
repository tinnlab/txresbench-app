// @vitest-environment jsdom
// A4 TEST-5 (stamping half) — the app-side fetch interceptor adds `X-Account-Id` on a
// same-origin request when the active-account holder is set, and never otherwise
// (null holder → no header; cross-origin → no header). This is the app's replacement
// for the SDK header hook the accounts epic deliberately does not add.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccountId, setAccountId } from './accountId'
import { installAccountHeaderStamping } from './installAccountHeader'

let lastInit: RequestInit | undefined
const spy = vi.fn((_input: unknown, init?: RequestInit) => {
  lastInit = init
  return Promise.resolve(new Response('{}'))
})

beforeEach(() => {
  setAccountId(null)
  lastInit = undefined
  spy.mockClear()
  // Install BEFORE it wraps our spy (idempotent — only the first install wraps).
  window.fetch = spy as unknown as typeof window.fetch
  installAccountHeaderStamping()
})
afterEach(() => setAccountId(null))

function headerOf(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null
  return new Headers(init.headers).get('X-Account-Id')
}

describe('installAccountHeaderStamping — the X-Account-Id request stamp', () => {
  it('stamps the header on a same-origin request when the holder is set', async () => {
    setAccountId('org-1')
    expect(getAccountId()).toBe('org-1')
    await window.fetch('/api/projects')
    expect(headerOf(lastInit)).toBe('org-1')
  })

  it('sends NO header when the holder is null (the solo/desktop default)', async () => {
    await window.fetch('/api/projects')
    expect(headerOf(lastInit)).toBeNull()
  })

  it('does NOT leak the header to a cross-origin request', async () => {
    setAccountId('org-1')
    await window.fetch('https://cdn.example.com/asset.js')
    expect(headerOf(lastInit)).toBeNull()
  })
})
