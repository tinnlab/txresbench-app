// @vitest-environment jsdom
// TEST-1 [covers ITEM-1] — the AccountDetail store: `load(id)` resolves the
// canonical Account via Admin.getAccount, the admin::accounts read-guard makes it a
// no-op without the permission, and a failure sets error + isInitialized (no
// re-fire loop) and rethrows so a caller can toast.
//
// vitest (jsdom). Boundaries mocked: `ApiClient.Admin.getAccount` + the permission
// gate; the real store runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

const getAccount = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: { Admin: { getAccount: (...a: unknown[]) => getAccount(...a) } },
}))

const { useAccountDetailStore } = await import('./AccountDetail.store')
const state = () => useAccountDetailStore.getState()

const ACME: Account = {
  id: 'a1',
  name: 'Acme Bio',
  kind: 'organization',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '',
}

beforeEach(() => {
  perm.mockReturnValue(true)
  getAccount.mockReset().mockResolvedValue(ACME)
  useAccountDetailStore.setState({
    accountId: null,
    account: null,
    isInitialized: false,
    loading: false,
    error: null,
  })
})

describe('TEST-1 — AccountDetail.load', () => {
  it('calls Admin.getAccount and sets the resolved account', async () => {
    await state().load('a1')
    expect(getAccount).toHaveBeenCalledWith({ account_id: 'a1' })
    expect(state().account).toEqual(ACME)
    expect(state().accountId).toBe('a1')
    expect(state().isInitialized).toBe(true)
    expect(state().loading).toBe(false)
  })

  it('is a no-op without the admin::accounts permission', async () => {
    perm.mockReturnValue(false)
    await state().load('a1')
    expect(getAccount).not.toHaveBeenCalled()
    expect(state().account).toBeNull()
  })

  it('sets error + isInitialized on failure (no re-fire loop) and rethrows', async () => {
    getAccount.mockRejectedValueOnce(new Error('not found'))
    await expect(state().load('a1')).rejects.toThrow('not found')
    expect(state().error).toBe('not found')
    expect(state().isInitialized).toBe(true)
    expect(state().loading).toBe(false)
    expect(state().account).toBeNull()
  })

  it('clearError clears the error', async () => {
    getAccount.mockRejectedValueOnce(new Error('down'))
    await expect(state().load('a1')).rejects.toThrow()
    state().clearError()
    expect(state().error).toBeNull()
  })
})
