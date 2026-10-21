// TEST-4  [covers ITEM-4] — the Users-tier mutations register with the right meta and
//   each run delegates to the Users-store method.
// TEST-9  [covers ITEM-9] — both ids are present in the committed frontend-actions.json.
// TEST-A3 [acceptance][invariant: INV-2] — the premium/comp mutations are reachable ONLY
//   through a registered, permissioned defineAction (never an inline onClick); an
//   unregistered id throws. Delete the registration and this turns red.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  setPersonalAccountPremium: vi.fn(),
  grantPersonalAccountCredit: vi.fn(),
}))
vi.mock('@/modules/user/stores/Users.store', () => ({ Users: store }))

import './userTierActions' // register the actions
import { getActionMeta, runAction, ActionNotFoundError } from '../defineAction'

const EXPECTED: Record<string, string> = {
  'user.grantPremiumComp': 'billing::admin',
  'user.grantUserCredit': 'billing::admin',
}

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '../server/src/modules/mcp/frontend-actions.json'), 'utf8'),
) as { actions: { id: string; permission: string; mutating: boolean; dangerous?: boolean }[] }

beforeEach(() => {
  store.setPersonalAccountPremium.mockReset()
  store.grantPersonalAccountCredit.mockReset()
})

describe('TEST-4 / TEST-A3 — Users-tier mutations are permissioned, dangerous, AI-drivable', () => {
  for (const [id, permission] of Object.entries(EXPECTED)) {
    it(`${id} registers with ${permission}, mutating, dangerous, AI-surfaced (INV-2)`, () => {
      const meta = getActionMeta(id)
      expect(meta, `${id} not registered`).toBeTruthy()
      expect(meta?.permission).toBe(permission)
      expect(meta?.mutating).toBe(true)
      expect(meta?.dangerous).toBe(true)
      expect(meta?.surfaces?.ai).not.toBe(false)
    })
  }

  it('grantPremiumComp run delegates to the store method', async () => {
    await runAction('user.grantPremiumComp', { account_id: 'acct-1', premium: true, reason: 'Comp' })
    expect(store.setPersonalAccountPremium).toHaveBeenCalledWith('acct-1', true, 'Comp')
  })

  it('grantUserCredit run delegates to the store method', async () => {
    await runAction('user.grantUserCredit', {
      account_id: 'acct-1',
      amount_cents: 1250,
      reason: 'Comp',
    })
    expect(store.grantPersonalAccountCredit).toHaveBeenCalledWith('acct-1', 1250, 'Comp', undefined)
  })

  it('an unregistered id throws — no inline back-door around the action seam (INV-2)', async () => {
    await expect(runAction('user.notARealAction' as never, {} as never)).rejects.toBeInstanceOf(
      ActionNotFoundError,
    )
  })
})

describe('TEST-9 — both ids are present in the committed manifest', () => {
  // The manifest serializes id/permission/mutating (+ params); `dangerous` is a
  // registry/launcher-UX flag not carried in the manifest (verified via getActionMeta
  // in TEST-4 above), so it is not asserted here.
  for (const [id, permission] of Object.entries(EXPECTED)) {
    it(`${id} is in frontend-actions.json with ${permission}, mutating`, () => {
      const entry = manifest.actions.find(a => a.id === id)
      expect(entry, `${id} missing from manifest`).toBeTruthy()
      expect(entry?.permission).toBe(permission)
      expect(entry?.mutating).toBe(true)
    })
  }
})
