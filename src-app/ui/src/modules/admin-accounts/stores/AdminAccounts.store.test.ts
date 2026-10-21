// @vitest-environment jsdom
// TEST-1 (#44) — the AdminAccounts cross-account list store: `loadAccounts`
// response mapping, `createOrg` → create-then-refetch, and error propagation.
//
// vitest (jsdom). Boundaries mocked: `ApiClient.Admin.listAccounts` /
// `ApiClient.Account.create` + the permission gate; the real store runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAccountSummary } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

const listAccounts = vi.fn()
const create = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Admin: { listAccounts: (...a: unknown[]) => listAccounts(...a) },
    Account: { create: (...a: unknown[]) => create(...a) },
  },
}))

const { useAdminAccountsStore } = await import('./AdminAccounts.store')
const state = () => useAdminAccountsStore.getState()

const ROWS: AdminAccountSummary[] = [
  {
    account: {
      id: 'a1',
      name: 'Acme',
      kind: 'organization',
      created_at: '',
      updated_at: '',
    },
    member_count: 3,
    owner_user_id: 'u1',
    owner_label: 'Ada Lovelace',
  },
]

beforeEach(() => {
  perm.mockReturnValue(true)
  listAccounts.mockReset()
  create.mockReset()
  useAdminAccountsStore.setState({
    accounts: [],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    kind: undefined,
    isInitialized: false,
    loading: false,
    creating: false,
    error: null,
  })
})

describe('TEST-1 — loadAccounts', () => {
  it('maps the Admin.listAccounts response into list state', async () => {
    listAccounts.mockResolvedValueOnce({
      accounts: ROWS,
      total: 42,
      page: 2,
      per_page: 20,
    })
    await state().loadAccounts(2, 20)
    expect(listAccounts).toHaveBeenCalledWith({ page: 2, per_page: 20 })
    expect(state().accounts).toEqual(ROWS)
    expect(state().total).toBe(42)
    expect(state().currentPage).toBe(2)
    expect(state().isInitialized).toBe(true)
    expect(state().loading).toBe(false)
  })

  it('returns early WITHOUT admin::accounts (never calls the API)', async () => {
    perm.mockReturnValue(false)
    await state().loadAccounts()
    expect(listAccounts).not.toHaveBeenCalled()
  })

  it('sets error and re-throws on a load failure', async () => {
    listAccounts.mockRejectedValueOnce(new Error('boom'))
    await expect(state().loadAccounts()).rejects.toThrow('boom')
    expect(state().error).toBe('boom')
    expect(state().loading).toBe(false)
  })

  it('marks isInitialized on FAILURE so the cold-load effect cannot loop', async () => {
    // Regression for the infinite-retry bug: the page's effect fires while
    // `!isInitialized && !loading`. If a failed load left isInitialized false,
    // the effect would re-fire the instant loading flips false. isInitialized
    // MUST become true even on failure.
    listAccounts.mockRejectedValueOnce(new Error('down'))
    await expect(state().loadAccounts()).rejects.toThrow('down')
    expect(state().isInitialized).toBe(true)
    expect(state().loading).toBe(false)
  })
})

describe('TEST-1 — createOrg', () => {
  it('calls Account.create then refetches page 1', async () => {
    create.mockResolvedValueOnce({
      id: 'a2',
      name: 'New Org',
      kind: 'organization',
      created_at: '',
      updated_at: '',
    })
    listAccounts.mockResolvedValueOnce({
      accounts: ROWS,
      total: 1,
      page: 1,
      per_page: 20,
    })
    const result = await state().createOrg({ name: 'New Org' })
    expect(create).toHaveBeenCalledWith({ name: 'New Org' })
    // Refetch happened (the create's follow-up load).
    expect(listAccounts).toHaveBeenCalledWith({ page: 1, per_page: 20 })
    expect(result?.id).toBe('a2')
    expect(state().creating).toBe(false)
  })

  it('returns undefined (not a silent success) when a create is already in flight', async () => {
    useAdminAccountsStore.setState({ creating: true } as never)
    const result = await state().createOrg({ name: 'dup' })
    expect(result).toBeUndefined() // caller must NOT report success on a dropped no-op
    expect(create).not.toHaveBeenCalled()
  })

  it('sets error and re-throws when create fails (no refetch)', async () => {
    create.mockRejectedValueOnce(new Error('name taken'))
    await expect(state().createOrg({ name: 'x' })).rejects.toThrow('name taken')
    expect(state().error).toBe('name taken')
    expect(state().creating).toBe(false)
    expect(listAccounts).not.toHaveBeenCalled()
  })
})
