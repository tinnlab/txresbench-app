// TEST-10 + TEST-16 (#49) — the committed frontend-actions.json manifest (baked into the server
// via include_str!) carries all the settings actions with the right permission (proves the regen
// ran / ITEM-17), AND each migrated surface file is listed in the action-coverage allowlist
// (proves coverage enforcement was turned on for the migrated files / ITEM-16). This is the
// executable counterpart of the `collect-actions --check` + `action-coverage` gate steps that
// run inside `npm run check`.
//
// TxResBench strip: the user/group/session-settings actions were removed with the auth and
// account-management modules they served; the settings actions that remain are asserted here.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '../server/src/modules/mcp/frontend-actions.json'), 'utf8'),
) as { actions: { id: string; permission: string; mutating: boolean }[] }

const EXPECTED: Record<string, string> = {
  'sandbox.updateSettings': 'sandbox::settings::manage',
  'jobs.updateSettings': 'jobs::settings::manage',
  'provenance.updateSettings': 'provenance::settings::manage',
  'workstore.updateSettings': 'workstore::settings::manage',
  'mcp.updateSettings': 'mcp::settings::manage',
}

const ALLOWLISTED = [
  'modules/sandbox/components/ResourceLimitsCard.tsx',
  'modules/jobs/pages/JobSettingsPage.tsx',
  'modules/provenance/components/ProvenanceSettingsCard.tsx',
]

describe('TEST-10 / TEST-16 — manifest carries the settings actions and coverage is enforced on migrated files', () => {
  it('manifest carries the TxResBench action surface (46 actions)', () => {
    expect(manifest.actions.length).toBeGreaterThanOrEqual(46)
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
