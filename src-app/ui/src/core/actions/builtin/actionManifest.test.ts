// TEST-10 + TEST-16 (#49) — the committed frontend-actions.json manifest (baked into the server
// via include_str!) carries all 14 new actions with the right permission (proves the regen ran /
// ITEM-17), AND each migrated surface file is listed in the action-coverage allowlist (proves
// coverage enforcement was turned on for the migrated files / ITEM-16). This is the executable
// counterpart of the `collect-actions --check` + `action-coverage` gate steps that run inside
// `npm run check`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '../server/src/modules/mcp/frontend-actions.json'), 'utf8'),
) as { actions: { id: string; permission: string; mutating: boolean }[] }

const EXPECTED: Record<string, string> = {
  'user.create': 'users::create',
  'user.update': 'users::edit',
  'user.resetPassword': 'users::reset_password',
  'user.toggleActive': 'users::toggle_status',
  'user.delete': 'users::delete',
  'group.assignUser': 'groups::assign_users',
  'group.removeUser': 'groups::assign_users',
  'group.create': 'groups::create',
  'group.update': 'groups::edit',
  'group.delete': 'groups::delete',
  'sandbox.updateSettings': 'sandbox::settings::manage',
  'jobs.updateSettings': 'jobs::settings::manage',
  'provenance.updateSettings': 'provenance::settings::manage',
  'auth.updateSessionSettings': 'auth::session_settings::manage',
}

const ALLOWLISTED = [
  'modules/user/components/user/UsersSettings.tsx',
  'modules/user/components/user/CreateUserDrawer.tsx',
  'modules/user/components/user/EditUserDrawer.tsx',
  'modules/user/components/user/ResetPasswordDrawer.tsx',
  'modules/user/components/user/UserGroupsDrawer.tsx',
  'modules/user/components/user/AssignGroupDrawer.tsx',
  'modules/user/components/group/UserGroupsSettings.tsx',
  'modules/user/components/group/EditUserGroupDrawer.tsx',
  'modules/sandbox/components/ResourceLimitsCard.tsx',
  'modules/jobs/pages/JobSettingsPage.tsx',
  'modules/provenance/components/ProvenanceSettingsCard.tsx',
  'modules/auth/SessionSettingsPage.tsx',
]

describe('TEST-10 / TEST-16 — manifest carries the new actions and coverage is enforced on migrated files', () => {
  it('manifest has at least 70 actions (56 baseline + 14 new)', () => {
    expect(manifest.actions.length).toBeGreaterThanOrEqual(70)
  })

  for (const [id, permission] of Object.entries(EXPECTED)) {
    it(`manifest carries ${id} with permission ${permission}, mutating`, () => {
      const entry = manifest.actions.find(a => a.id === id)
      expect(entry, `${id} missing from manifest`).toBeTruthy()
      expect(entry?.permission).toBe(permission)
      expect(entry?.mutating).toBe(true)
    })
  }

  const allowlist = readFileSync(
    resolve(process.cwd(), 'scripts/action-coverage-allowlist.txt'),
    'utf8',
  )
  for (const file of ALLOWLISTED) {
    it(`coverage allowlist includes ${file}`, () => {
      expect(allowlist).toContain(file)
    })
  }
})
