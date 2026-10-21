// TEST-A3 [acceptance][invariant: INV-3] — every Billing Console mutation is a
// permissioned defineAction (never an inline onClick), AND is present in the single
// committed frontend-actions.json (baked into the server via include_str!), so it is
// AI-drivable via MCP on the hosted build. Locks both the registry shape and the
// manifest presence (which requires the collect-actions permission-union seam).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './billingActions' // register the actions
import { getActionMeta } from '../defineAction'

const EXPECTED: Record<string, string> = {
  'billing.setPlan': 'billing::admin',
  'billing.clearPlan': 'billing::admin',
  'billing.grantCredit': 'billing::admin',
  'billing.revokeCredit': 'billing::admin',
  'billing.setPremium': 'billing::admin',
  'billing.suspendAccount': 'admin::accounts',
  'billing.reactivateAccount': 'admin::accounts',
}

const manifest = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../server/src/modules/mcp/frontend-actions.json'),
    'utf8',
  ),
) as { actions: { id: string; permission: string; mutating: boolean }[] }

describe('TEST-A3 — billing mutations are permissioned, AI-drivable defineActions', () => {
  for (const [id, permission] of Object.entries(EXPECTED)) {
    it(`${id} is registered with permission ${permission}, mutating, AI-surfaced`, () => {
      const meta = getActionMeta(id)
      expect(meta, `${id} not registered`).toBeTruthy()
      expect(meta?.permission).toBe(permission)
      expect(meta?.mutating).toBe(true)
      // surfaces.ai defaults true; must not be disabled.
      expect(meta?.surfaces?.ai).not.toBe(false)
    })

    it(`${id} is present in the committed frontend-actions.json with the right permission`, () => {
      const entry = manifest.actions.find(a => a.id === id)
      expect(entry, `${id} missing from manifest`).toBeTruthy()
      expect(entry?.permission).toBe(permission)
      expect(entry?.mutating).toBe(true)
    })
  }
})
