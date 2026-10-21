// @vitest-environment jsdom
// TEST-2 (#44) — the AccountMembers drawer store: `loadMembers` mapping, the
// three admin mutations (add/remove/set-role) each calling their endpoint then
// refetching, and error propagation (the store never swallows — the caller must
// see the 422 LAST_OWNER to surface it, INV-3).
//
// vitest (jsdom). Boundaries mocked: `ApiClient.Account.listMembers` +
// `ApiClient.Admin.*` + the permission gate; the real store runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountMember } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

const listMembers = vi.fn()
const addMember = vi.fn()
const removeMember = vi.fn()
const setMemberRole = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Account: { listMembers: (...a: unknown[]) => listMembers(...a) },
    Admin: {
      addMember: (...a: unknown[]) => addMember(...a),
      removeMember: (...a: unknown[]) => removeMember(...a),
      setMemberRole: (...a: unknown[]) => setMemberRole(...a),
    },
  },
}))

const { useAccountMembersStore } = await import('./AccountMembers.store')
const state = () => useAccountMembersStore.getState()

const ORG: Account = {
  id: 'a1',
  name: 'Acme',
  kind: 'organization',
  created_at: '',
  updated_at: '',
}
const MEMBERS: AccountMember[] = [
  {
    account_id: 'a1',
    user_id: 'u1',
    role: 'owner',
    created_at: '',
    username: 'ada',
    email: 'ada@acme.bio',
    display_name: 'Ada Lovelace',
  },
  {
    account_id: 'a1',
    user_id: 'u2',
    role: 'member',
    created_at: '',
    username: 'grace',
    email: 'grace@acme.bio',
    display_name: 'Grace Hopper',
  },
]

const membersResponse = () => ({
  members: MEMBERS,
  total: MEMBERS.length,
  page: 1,
  per_page: 20,
})

beforeEach(() => {
  perm.mockReturnValue(true)
  listMembers.mockReset().mockResolvedValue(membersResponse())
  addMember.mockReset().mockResolvedValue(undefined)
  removeMember.mockReset().mockResolvedValue(undefined)
  setMemberRole.mockReset().mockResolvedValue(undefined)
  useAccountMembersStore.setState({
    account: null,
    members: [],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    isInitialized: false,
    loading: false,
    mutating: false,
    error: null,
  })
})

describe('TEST-2 — setAccount (inline account context, #57)', () => {
  it('points the store at an account and resets the list WITHOUT an isOpen flag', () => {
    useAccountMembersStore.setState({
      members: MEMBERS,
      total: MEMBERS.length,
      currentPage: 3,
      isInitialized: true,
      error: 'stale',
    })
    state().setAccount(ORG)
    expect(state().account).toEqual(ORG)
    expect(state().members).toEqual([])
    expect(state().total).toBe(0)
    expect(state().currentPage).toBe(1)
    expect(state().isInitialized).toBe(false)
    expect(state().error).toBeNull()
    // The drawer's `isOpen` flag is gone — this is an inline widget now.
    expect('isOpen' in state()).toBe(false)
  })

  it('is a no-op when re-set for the same account (a re-render must not wipe a loaded list)', async () => {
    state().setAccount(ORG)
    await state().loadMembers()
    expect(state().members).toEqual(MEMBERS)
    state().setAccount(ORG)
    expect(state().members).toEqual(MEMBERS) // not wiped
  })
})

describe('TEST-2 — loadMembers', () => {
  it('maps the Account.listMembers response', async () => {
    state().setAccount(ORG)
    await state().loadMembers()
    expect(listMembers).toHaveBeenCalledWith({ id: 'a1', page: 1, per_page: 20 })
    expect(state().members).toEqual(MEMBERS)
    expect(state().total).toBe(2)
    expect(state().isInitialized).toBe(true)
  })

  it('does nothing when no account is open', async () => {
    await state().loadMembers()
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('marks isInitialized on FAILURE so the drawer load effect cannot loop', async () => {
    state().setAccount(ORG)
    listMembers.mockRejectedValueOnce(new Error('down'))
    await expect(state().loadMembers()).rejects.toThrow('down')
    expect(state().isInitialized).toBe(true)
    expect(state().loading).toBe(false)
  })
})

describe('TEST-2 — mutations call the endpoint then refetch', () => {
  beforeEach(() => {
    state().setAccount(ORG)
  })

  it('addMember → Admin.addMember + refetch', async () => {
    await state().addMember('u3', 'member')
    expect(addMember).toHaveBeenCalledWith({
      account_id: 'a1',
      user_id: 'u3',
      role: 'member',
    })
    expect(listMembers).toHaveBeenCalled() // refetch
    expect(state().mutating).toBe(false)
  })

  it('setRole → Admin.setMemberRole + refetch', async () => {
    await state().setRole('u2', 'admin')
    expect(setMemberRole).toHaveBeenCalledWith({
      account_id: 'a1',
      user_id: 'u2',
      role: 'admin',
    })
    expect(listMembers).toHaveBeenCalled()
  })

  it('removeMember → Admin.removeMember + refetch', async () => {
    await state().removeMember('u2')
    expect(removeMember).toHaveBeenCalledWith({
      account_id: 'a1',
      user_id: 'u2',
    })
    expect(listMembers).toHaveBeenCalled()
  })

  it('returns false (not a silent success) when a concurrent mutation is in flight', async () => {
    useAccountMembersStore.setState({ mutating: true } as never)
    const ran = await state().addMember('u3', 'member')
    expect(ran).toBe(false) // the caller must NOT toast success on a dropped no-op
    expect(addMember).not.toHaveBeenCalled()
  })

  it('returns true when the mutation actually ran', async () => {
    const ran = await state().addMember('u3', 'member')
    expect(ran).toBe(true)
  })

  it('propagates a removeMember 422 (LAST_OWNER) — sets error and re-throws', async () => {
    const err = Object.assign(new Error('last owner'), {
      status: 422,
      error_code: 'LAST_OWNER',
    })
    removeMember.mockRejectedValueOnce(err)
    await expect(state().removeMember('u1')).rejects.toBe(err)
    expect(state().error).toBe('last owner')
    expect(state().mutating).toBe(false)
  })
})
