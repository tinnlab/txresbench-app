// TEST-3 [acceptance][invariant: INV-1] + TEST-4 [acceptance][invariant: INV-2] (#49) —
// every user-group management mutation is a permissioned `defineAction` dispatched via
// `runAction` in its owning component (not a human-only inline handler), with the EXACT
// permission that gated the human affordance.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './userGroupActions' // register the actions
import { getActionMeta } from '../defineAction'

const EXPECTED: Record<string, { permission: string; component: string }> = {
  'group.assignUser': {
    permission: 'groups::assign_users',
    component: 'src/modules/user/components/user/UserGroupsDrawer.tsx',
  },
  'group.removeUser': {
    permission: 'groups::assign_users',
    component: 'src/modules/user/components/user/UserGroupsDrawer.tsx',
  },
  'group.create': {
    permission: 'groups::create',
    component: 'src/modules/user/components/group/UserGroupsSettings.tsx',
  },
  'group.update': {
    permission: 'groups::edit',
    component: 'src/modules/user/components/group/EditUserGroupDrawer.tsx',
  },
  'group.delete': {
    permission: 'groups::delete',
    component: 'src/modules/user/components/group/UserGroupsSettings.tsx',
  },
}

describe('TEST-3/TEST-4 — group management mutations are permissioned, AI-drivable defineActions', () => {
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
