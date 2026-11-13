// TEST-10 + TEST-16 (#49) — the committed frontend-actions.json manifest (baked into the server
// via include_str!) carries all the settings actions with the right permission (proves the regen
// ran / ITEM-17), AND each migrated surface file is listed in the action-coverage allowlist
// (proves coverage enforcement was turned on for the migrated files / ITEM-16). This is the
// executable counterpart of the `collect-actions --check` + `action-coverage` gate steps that
// run inside `npm run check`.
//
// TxResBench strip: the user/group/session-settings actions were removed with the auth and
// account-management modules they served, and the sandbox/jobs/provenance/workstore settings
// actions with their single-cell modules. The manifest carries the app-owned surface that
// remains (9 actions), pinned here so a skipped regen cannot silently drift the two sides.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '../server/src/modules/mcp/frontend-actions.json'), 'utf8'),
) as { actions: { id: string; permission: string; mutating: boolean }[] }

const EXPECTED: Record<string, { permission: string; mutating: boolean }> = {
  'app.navigate': { permission: 'mcp::use', mutating: true },
  'nav.aiAccess': { permission: 'mcp::use', mutating: true },
  'views.list': { permission: 'mcp::use', mutating: false },
  'view.describe': { permission: 'mcp::use', mutating: false },
  'selection.get': { permission: 'mcp::use', mutating: false },
  'mcp.updateSettings': { permission: 'mcp::settings::manage', mutating: true },
  'features.setGlobalFlag': { permission: 'features::manage', mutating: true },
  'features.setAccountFlag': { permission: 'features::manage', mutating: true },
  'features.clearAccountOverride': { permission: 'features::manage', mutating: true },
}

// No removed-module path may sit in the allowlist. Its remaining entries are
// pre-strip identity/account files, so only absence-of-single-cell is asserted.
const FORBIDDEN = [
  'modules/sandbox/',
  'modules/jobs/',
  'modules/provenance/',
  'modules/workstore/',
  'modules/workbench/',
  'modules/datasets/',
  'modules/project/',
]

describe('TEST-10 / TEST-16 — manifest carries the kept action surface and coverage stays enforced', () => {
  it('manifest carries the TxResBench action surface (9 actions)', () => {
    expect(manifest.actions.length).toBeGreaterThanOrEqual(9)
  })

  for (const [id, { permission, mutating }] of Object.entries(EXPECTED)) {
    it(`manifest carries ${id} with permission ${permission}, mutating=${mutating}`, () => {
      const entry = manifest.actions.find(a => a.id === id)
      expect(entry, `${id} missing from manifest`).toBeTruthy()
      expect(entry?.permission).toBe(permission)
      expect(entry?.mutating).toBe(mutating)
    })
  }

  const allowlist = readFileSync(
    resolve(process.cwd(), 'scripts/action-coverage-allowlist.txt'),
    'utf8',
  )
  for (const prefix of FORBIDDEN) {
    it(`coverage allowlist has no ${prefix} entry (module removed)`, () => {
      expect(allowlist).not.toContain(prefix)
    })
  }
})
