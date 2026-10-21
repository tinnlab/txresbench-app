// TEST-9 (#49) — the new action files are SIDE-EFFECT-IMPORTED from their owning module, so
// the actions actually register at runtime (a builtin file that compiles but is never imported
// registers nothing). Two-part proof: (a) importing each builtin file registers its ids
// (asserted here via the live registry), and (b) each owning `module.tsx` carries the
// side-effect import (asserted against the module source). The Part A e2e (users-admin-crud)
// additionally drives the user path through the real module import at runtime.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './usersAdminActions'
import './userGroupActions'
import './sandboxSettingsActions'
import './workstoreSettingsActions'
import './provenanceSettingsActions'
import './sessionSettingsActions'
import './jobsActions'
import { getActionMeta } from '../defineAction'

const NEW_IDS = [
  'user.create',
  'user.update',
  'user.resetPassword',
  'user.toggleActive',
  'user.delete',
  'group.assignUser',
  'group.removeUser',
  'group.create',
  'group.update',
  'group.delete',
  'sandbox.updateSettings',
  'workstore.updateSettings',
  'provenance.updateSettings',
  'auth.updateSessionSettings',
  'jobs.updateSettings',
]

// owning module.tsx → the builtin file it must side-effect-import
const MODULE_IMPORTS: Record<string, string[]> = {
  'src/modules/user/module.tsx': [
    '@/core/actions/builtin/usersAdminActions',
    '@/core/actions/builtin/userGroupActions',
  ],
  'src/modules/sandbox/module.tsx': ['@/core/actions/builtin/sandboxSettingsActions'],
  'src/modules/workstore/module.tsx': ['@/core/actions/builtin/workstoreSettingsActions'],
  'src/modules/provenance/module.tsx': ['@/core/actions/builtin/provenanceSettingsActions'],
  'src/modules/auth/module.tsx': ['@/core/actions/builtin/sessionSettingsActions'],
  // jobs.updateSettings lives in jobsActions.ts, imported once from command-palette/module.tsx.
  'src/modules/command-palette/module.tsx': ['@/core/actions/builtin/jobsActions'],
}

describe('TEST-9 — new admin actions are registered and wired via their owning module', () => {
  for (const id of NEW_IDS) {
    it(`${id} is registered when its builtin file is imported`, () => {
      expect(getActionMeta(id), `${id} not registered`).toBeTruthy()
    })
  }

  for (const [moduleFile, imports] of Object.entries(MODULE_IMPORTS)) {
    for (const imp of imports) {
      it(`${moduleFile} side-effect-imports ${imp}`, () => {
        const src = readFileSync(resolve(process.cwd(), moduleFile), 'utf8')
        expect(src, `${moduleFile} must import ${imp}`).toContain(`import '${imp}'`)
      })
    }
  }
})
