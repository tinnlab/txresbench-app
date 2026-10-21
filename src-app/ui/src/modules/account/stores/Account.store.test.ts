// @vitest-environment jsdom
// A4 TEST-3/4/5 — the `Accounts` client store: response mapping + switching, the
// no-403-on-reconnect self-gate, the default-active resolution (persisted pref
// re-validated, DEC-3), and the `X-Account-Id` header holder it drives.
//
// vitest (jsdom). Boundaries mocked: `ApiClient.Account.*` + the permission gate;
// the store's real `init` wiring + the real EventBus + the real header holder run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

let accounts: Account[] = []
const list = vi.fn(async () => ({ accounts }))
vi.mock('@/api-client', () => ({
  ApiClient: { Account: { list: () => list(), listMembers: vi.fn() } },
}))

const { getAccountId, setAccountId } = await import('@/core/sync/accountId')
const { useEventBusStore } = await import('@ziee/framework/events')
const { useAccountStore } = await import('./Account.store')
const state = () => useAccountStore.getState()

const PERSONAL: Account = {
  id: 'p1',
  kind: 'personal',
  name: 'me',
  personal_user_id: 'u1',
  created_at: '',
  updated_at: '',
}
const ORG: Account = {
  id: 'o1',
  kind: 'organization',
  name: 'Acme',
  personal_user_id: undefined,
  created_at: '',
  updated_at: '',
}

beforeEach(() => {
  perm.mockReturnValue(true)
  accounts = [PERSONAL, ORG]
  list.mockClear()
  localStorage.clear()
  setAccountId(null)
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loading: false,
    error: null,
    isInitialized: false,
  })
})

afterEach(() => {
  state().__destroy__()
})

describe('TEST-3 — load / switch / self-gate', () => {
  it('load() maps the response and defaults active to the personal account', async () => {
    await state().load()
    expect(state().accounts.map(a => a.id)).toEqual(['p1', 'o1'])
    expect(state().activeAccountId).toBe('p1') // personal is the INV-1 default
  })

  it('setActiveAccount updates the active id', async () => {
    await state().load()
    state().setActiveAccount('o1')
    expect(state().activeAccountId).toBe('o1')
  })

  it('the sync reload returns early WITHOUT account::read, and refetches WITH it', async () => {
    perm.mockReturnValue(false)
    state().__init__.__store__() // wire sync:account / sync:reconnect; init does NOT load (no perm)
    expect(list).not.toHaveBeenCalled()

    await useEventBusStore.getState().emit({ type: 'sync:account', data: {} } as never)
    await Promise.resolve()
    expect(list, 'no-403-on-reconnect: a user without the perm never refetches').not.toHaveBeenCalled()

    perm.mockReturnValue(true)
    await useEventBusStore.getState().emit({ type: 'sync:account', data: {} } as never)
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
  })
})

describe('TEST-4 — default-active resolution (DEC-3, re-validated per load)', () => {
  it('honors a persisted preference that is still a membership', async () => {
    localStorage.setItem('cyto.activeAccountId', 'o1')
    await state().load()
    expect(state().activeAccountId).toBe('o1')
  })

  it('falls back to personal when the persisted preference is no longer a membership', async () => {
    localStorage.setItem('cyto.activeAccountId', 'gone-org') // left the org
    await state().load()
    expect(state().activeAccountId).toBe('p1') // self-heals to personal, no stranding
  })
})

describe('TEST-5 — the X-Account-Id header holder', () => {
  it('an ORG active account stamps the header; the PERSONAL default clears it', async () => {
    await state().load()
    // personal default → header-FREE (server defaults to personal; INV-1/INV-4)
    expect(getAccountId()).toBeNull()

    state().setActiveAccount('o1')
    expect(getAccountId()).toBe('o1') // an org stamps its id

    state().setActiveAccount('p1')
    expect(getAccountId()).toBeNull() // back to personal → header cleared
  })
})
