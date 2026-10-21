// TEST-1 [acceptance][invariant: INV-1] + TEST-2 [acceptance][invariant: INV-2] (#49) —
// every Users identity-CRUD mutation is a permissioned `defineAction` (not a human-only
// inline onClick), registered with the EXACT permission that gated the human affordance, AND
// the owning component dispatches it via `runAction('<id>')` — so a control reverted to a bare
// inline store call would turn the source-reference assertion RED (that is what makes this a
// real INV-1 proof, not merely "an action with this id happens to exist").

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './usersAdminActions' // register the actions
import { getActionMeta } from '../defineAction'

// id → [expected permission, owning component that must dispatch it via runAction]
const EXPECTED: Record<string, { permission: string; component: string }> = {
  'user.create': {
    permission: 'users::create',
    component: 'src/modules/user/components/user/CreateUserDrawer.tsx',
  },
  'user.update': {
    permission: 'users::edit',
    component: 'src/modules/user/components/user/EditUserDrawer.tsx',
  },
  'user.resetPassword': {
    permission: 'users::reset_password',
    component: 'src/modules/user/components/user/ResetPasswordDrawer.tsx',
  },
  'user.toggleActive': {
    permission: 'users::toggle_status',
    component: 'src/modules/user/components/user/UsersSettings.tsx',
  },
  'user.delete': {
    permission: 'users::delete',
    component: 'src/modules/user/components/user/UsersSettings.tsx',
  },
}

describe('TEST-1/TEST-2 — Users identity-CRUD mutations are permissioned, AI-drivable defineActions', () => {
  for (const [id, { permission, component }] of Object.entries(EXPECTED)) {
    it(`${id} is registered, mutating, AI-surfaced (INV-1)`, () => {
      const meta = getActionMeta(id)
      expect(meta, `${id} not registered`).toBeTruthy()
      expect(meta?.mutating).toBe(true)
      expect(meta?.surfaces?.ai).not.toBe(false)
    })

    it(`${id} carries the exact permission ${permission} (INV-2)`, () => {
      expect(getActionMeta(id)?.permission).toBe(permission)
    })

    it(`${id} is dispatched via runAction in ${component} (INV-1: no human-only path)`, () => {
      const src = readFileSync(resolve(process.cwd(), component), 'utf8')
      expect(src, `${component} must dispatch ${id} via runAction`).toContain(`runAction('${id}'`)
    })
  }
})
