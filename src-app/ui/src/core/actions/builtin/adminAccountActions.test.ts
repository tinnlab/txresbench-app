// @vitest-environment jsdom
// TEST-3 [acceptance][invariant: INV-4] (#44) — proves the DESIGN promise that
// EVERY account mutation is a permissioned, AI-drivable `defineAction`: the four
// ids are registered with a REAL `account::manage` permission, `mutating: true`,
// `kind: 'global'`, `removeMember` is `dangerous`, and each `run` DELEGATES to
// its store method (invoking the action drives the same store path a human
// button does — not a duplicated implementation). It fails if an id is missing,
// unpermissioned, non-mutating, or bypasses the store.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permissions } from '@/api-client/permissions'

const createOrg = vi.fn((..._a: unknown[]) => Promise.resolve(undefined))
const addMember = vi.fn((..._a: unknown[]) => Promise.resolve(undefined))
const removeMember = vi.fn((..._a: unknown[]) => Promise.resolve(undefined))
const setRole = vi.fn((..._a: unknown[]) => Promise.resolve(undefined))

vi.mock('@/modules/admin-accounts/stores/AdminAccounts.store', () => ({
  AdminAccounts: { createOrg: (...a: unknown[]) => createOrg(...a) },
}))
vi.mock('@/modules/admin-accounts/stores/AccountMembers.store', () => ({
  AccountMembers: {
    addMember: (...a: unknown[]) => addMember(...a),
    removeMember: (...a: unknown[]) => removeMember(...a),
    setRole: (...a: unknown[]) => setRole(...a),
  },
}))

// Import the actions file for its side effect (registers into the registry).
await import('./adminAccountActions')
const { getActionMeta, runAction } = await import('../defineAction')

beforeEach(() => {
  createOrg.mockClear()
  addMember.mockClear()
  removeMember.mockClear()
  setRole.mockClear()
})

const IDS = [
  'admin.account.createOrg',
  'admin.account.addMember',
  'admin.account.setMemberRole',
  'admin.account.removeMember',
] as const

describe('TEST-3 — the four mutations are permissioned defineActions', () => {
  it.each(IDS)('%s is registered, mutating, global, account::manage', id => {
    const meta = getActionMeta(id)
    expect(meta, `${id} must be registered`).toBeDefined()
    expect(meta!.permission).toBe(Permissions.AccountManage)
    expect(meta!.mutating).toBe(true)
    expect(meta!.kind).toBe('global')
  })

  it('removeMember is flagged dangerous; the others are not', () => {
    expect(getActionMeta('admin.account.removeMember')!.dangerous).toBe(true)
    expect(getActionMeta('admin.account.createOrg')!.dangerous).toBe(false)
    expect(getActionMeta('admin.account.addMember')!.dangerous).toBe(false)
    expect(getActionMeta('admin.account.setMemberRole')!.dangerous).toBe(false)
  })
})

describe('TEST-3 — each run delegates to its store method', () => {
  it('createOrg → AdminAccounts.createOrg', async () => {
    await runAction('admin.account.createOrg', { name: 'Acme', owner_id: 'u1' })
    expect(createOrg).toHaveBeenCalledWith({ name: 'Acme', owner_id: 'u1' })
  })

  it('createOrg omits owner_id when absent', async () => {
    await runAction('admin.account.createOrg', { name: 'Acme' })
    expect(createOrg).toHaveBeenCalledWith({ name: 'Acme' })
  })

  it('addMember → AccountMembers.addMember', async () => {
    await runAction('admin.account.addMember', { user_id: 'u2', role: 'admin' })
    expect(addMember).toHaveBeenCalledWith('u2', 'admin')
  })

  it('setMemberRole → AccountMembers.setRole', async () => {
    await runAction('admin.account.setMemberRole', { user_id: 'u2', role: 'owner' })
    expect(setRole).toHaveBeenCalledWith('u2', 'owner')
  })

  it('removeMember → AccountMembers.removeMember', async () => {
    await runAction('admin.account.removeMember', { user_id: 'u2' })
    expect(removeMember).toHaveBeenCalledWith('u2')
  })

  it('rejects invalid params (empty name) before calling the store', async () => {
    await expect(
      runAction('admin.account.createOrg', { name: '' }),
    ).rejects.toThrow()
    expect(createOrg).not.toHaveBeenCalled()
  })
})
