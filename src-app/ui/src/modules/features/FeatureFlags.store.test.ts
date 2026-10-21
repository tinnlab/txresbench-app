// @vitest-environment jsdom
// TEST-2 (#48) — the FeatureFlags store's GLOBAL toggle action `setGlobal`:
// it PUTs {flag_key, enabled} with NO account_id (global default), replaces the
// row with the server-resolved view, clears the pending marker, and on failure
// sets `error` + rethrows.
//
// vitest (jsdom). Boundaries mocked: `ApiClient.Features.set|list` + the
// permission gate; the real store runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureFlagView } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

const list = vi.fn()
const set = vi.fn()
const clear = vi.fn()
const listAccounts = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Features: {
      list: (...a: unknown[]) => list(...a),
      set: (...a: unknown[]) => set(...a),
      clear: (...a: unknown[]) => clear(...a),
    },
    Admin: {
      listAccounts: (...a: unknown[]) => listAccounts(...a),
    },
  },
}))

const { useFeatureFlagsStore } = await import('./FeatureFlags.store')
const { useFeatureFlagAccountsStore } = await import('./stores/FeatureFlagAccounts.store')
const state = () => useFeatureFlagsStore.getState()
const accountsState = () => useFeatureFlagAccountsStore.getState()

const OFF: FeatureFlagView = {
  flag_key: 'demo.runtime_flag',
  description: 'Demo flag.',
  default_enabled: false,
  effective: false,
}
const ON_GLOBAL: FeatureFlagView = {
  ...OFF,
  global_enabled: true,
  effective: true,
}

// A per-account resolved view where the account OVERRIDES the flag OFF (global is ON).
const ACCOUNT_OVERRIDE_OFF: FeatureFlagView = {
  ...OFF,
  global_enabled: true,
  account_enabled: false,
  effective: false,
}
// The same flag after the override is CLEARED — inheriting the global ON.
const ACCOUNT_INHERITED: FeatureFlagView = {
  ...OFF,
  global_enabled: true,
  effective: true,
}

beforeEach(() => {
  perm.mockReturnValue(true)
  list.mockReset()
  set.mockReset()
  clear.mockReset()
  listAccounts.mockReset()
  useFeatureFlagsStore.setState({
    flags: [{ ...OFF }],
    loading: false,
    error: null,
    pending: {},
    // The per-account methods are normally reached via selectAccount, which sets this
    // first; seed it so the direct-call happy-path tests pass the staleness guard.
    selectedAccountId: 'acct-1',
    accountFlags: [{ ...ACCOUNT_OVERRIDE_OFF }],
    accountLoading: false,
    accountError: null,
    accountPending: {},
  })
  useFeatureFlagAccountsStore.setState({
    accounts: [],
    isInitialized: false,
    loading: false,
    error: null,
  })
})

describe('TEST-2 — setGlobal', () => {
  it('PUTs {flag_key, enabled} with NO account_id and replaces the row with the returned view', async () => {
    set.mockResolvedValueOnce(ON_GLOBAL)
    const returned = await state().setGlobal('demo.runtime_flag', true)

    expect(set).toHaveBeenCalledWith({ flag_key: 'demo.runtime_flag', enabled: true })
    // No account_id key at all (global default, not a per-account override).
    expect(set.mock.calls[0][0]).not.toHaveProperty('account_id')
    expect(returned).toEqual(ON_GLOBAL)
    expect(state().flags[0]).toEqual(ON_GLOBAL)
    expect(state().flags[0].effective).toBe(true)
    // Pending cleared after success.
    expect(state().pending['demo.runtime_flag']).toBeUndefined()
    expect(state().error).toBeNull()
  })

  it('sets error and re-throws on a PUT failure, and clears pending', async () => {
    set.mockRejectedValueOnce(new Error('boom'))
    await expect(state().setGlobal('demo.runtime_flag', true)).rejects.toThrow('boom')
    expect(state().error).toBe('boom')
    expect(state().pending['demo.runtime_flag']).toBeUndefined()
    // The row is unchanged (no optimistic flip).
    expect(state().flags[0].effective).toBe(false)
  })
})

describe('TEST-6 — per-account overrides (#53)', () => {
  it('loadForAccount GETs the list WITH account_id and fills accountFlags', async () => {
    list.mockResolvedValueOnce({ flags: [ACCOUNT_OVERRIDE_OFF], account_id: 'acct-1' })
    await state().loadForAccount('acct-1')
    expect(list).toHaveBeenCalledWith({ account_id: 'acct-1' })
    expect(state().accountFlags).toEqual([ACCOUNT_OVERRIDE_OFF])
    expect(state().accountLoading).toBe(false)
  })

  it('selectAccount sets the id and loads; a null selection clears the list', async () => {
    list.mockResolvedValueOnce({ flags: [ACCOUNT_OVERRIDE_OFF], account_id: 'acct-1' })
    await state().selectAccount('acct-1')
    expect(state().selectedAccountId).toBe('acct-1')
    expect(state().accountFlags).toEqual([ACCOUNT_OVERRIDE_OFF])

    await state().selectAccount(null)
    expect(state().selectedAccountId).toBeNull()
    expect(state().accountFlags).toEqual([])
    // No extra list call for the null selection.
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('setAccount PUTs WITH account_id and replaces the row in accountFlags (not the global list)', async () => {
    set.mockResolvedValueOnce(ACCOUNT_OVERRIDE_OFF)
    const returned = await state().setAccount('demo.runtime_flag', 'acct-1', false)
    expect(set).toHaveBeenCalledWith({
      flag_key: 'demo.runtime_flag',
      account_id: 'acct-1',
      enabled: false,
    })
    expect(returned).toEqual(ACCOUNT_OVERRIDE_OFF)
    expect(state().accountFlags[0]).toEqual(ACCOUNT_OVERRIDE_OFF)
    expect(state().accountFlags[0].account_enabled).toBe(false)
    // The GLOBAL list row is untouched.
    expect(state().flags[0]).toEqual(OFF)
    expect(state().accountPending['demo.runtime_flag']).toBeUndefined()
  })

  it('clearAccount DELETEs {flag_key, account_id} and replaces the row with the inherited view', async () => {
    clear.mockResolvedValueOnce(ACCOUNT_INHERITED)
    const returned = await state().clearAccount('demo.runtime_flag', 'acct-1')
    expect(clear).toHaveBeenCalledWith({ flag_key: 'demo.runtime_flag', account_id: 'acct-1' })
    expect(returned).toEqual(ACCOUNT_INHERITED)
    // The row reverts to inheriting: account_enabled null, effective = global (true).
    expect(state().accountFlags[0].account_enabled).toBeUndefined()
    expect(state().accountFlags[0].effective).toBe(true)
    expect(state().accountPending['demo.runtime_flag']).toBeUndefined()
  })

  it('clearAccount sets error and re-throws on failure, clearing pending (no optimistic flip)', async () => {
    clear.mockRejectedValueOnce(new Error('nope'))
    await expect(state().clearAccount('demo.runtime_flag', 'acct-1')).rejects.toThrow('nope')
    expect(state().accountError).toBe('nope')
    expect(state().accountPending['demo.runtime_flag']).toBeUndefined()
    // The override row is unchanged (still overridden OFF).
    expect(state().accountFlags[0].account_enabled).toBe(false)
  })

  // Staleness guard (audit FF-1/FF-2): a load/mutation that resolves AFTER the user
  // switched accounts must NOT write into the now-selected account's list.
  it('loadForAccount drops its result if the selection changed while in flight', async () => {
    useFeatureFlagsStore.setState({ selectedAccountId: 'acct-B', accountFlags: [] })
    list.mockResolvedValueOnce({ flags: [ACCOUNT_OVERRIDE_OFF], account_id: 'acct-A' })
    await state().loadForAccount('acct-A') // resolves for A, but B is now selected
    expect(state().accountFlags).toEqual([]) // A's rows were NOT applied under B
  })

  it('setAccount drops its result if the selection changed while in flight', async () => {
    useFeatureFlagsStore.setState({ selectedAccountId: 'acct-B', accountFlags: [] })
    set.mockResolvedValueOnce(ACCOUNT_OVERRIDE_OFF)
    const returned = await state().setAccount('demo.runtime_flag', 'acct-A', false)
    // The action still gets the value (for its toast) but B's list is untouched.
    expect(returned).toEqual(ACCOUNT_OVERRIDE_OFF)
    expect(state().accountFlags).toEqual([])
  })

  it('selectAccount clears the prior account rows immediately on switch', async () => {
    // Seed A's rows, then switch to B; A's rows must not linger under B.
    useFeatureFlagsStore.setState({
      selectedAccountId: 'acct-A',
      accountFlags: [ACCOUNT_INHERITED],
    })
    list.mockResolvedValueOnce({ flags: [ACCOUNT_OVERRIDE_OFF], account_id: 'acct-B' })
    await state().selectAccount('acct-B')
    expect(state().selectedAccountId).toBe('acct-B')
    expect(state().accountFlags).toEqual([ACCOUNT_OVERRIDE_OFF]) // B's rows, not A's
  })
})

describe('TEST-7 — FeatureFlagAccounts picker store', () => {
  it('loads via Admin.listAccounts (bounded page) and maps options to human labels, not UUIDs', async () => {
    listAccounts.mockResolvedValueOnce({
      accounts: [
        { account: { id: 'acct-1', name: 'Nebula Diagnostics' }, member_count: 3, owner_label: 'Dr. Raman' },
      ],
      page: 1,
      per_page: 100,
      total: 1,
    })
    await accountsState().loadAccounts()
    expect(listAccounts).toHaveBeenCalledWith({ page: 1, per_page: 100 })
    const { featureFlagAccountLabel } = await import('./stores/FeatureFlagAccounts.store')
    const label = featureFlagAccountLabel(accountsState().accounts[0])
    expect(label).toContain('Nebula Diagnostics')
    // The visible label is the name (+ owner), never the raw UUID.
    expect(label).not.toContain('acct-1')
    expect(accountsState().isInitialized).toBe(true)
  })

  it('does NOT call listAccounts without admin::accounts (read-guarded)', async () => {
    perm.mockReturnValue(false)
    await accountsState().loadAccounts()
    expect(listAccounts).not.toHaveBeenCalled()
  })
})
