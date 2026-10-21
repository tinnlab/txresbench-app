// TEST-9 (#49) — the new action files are SIDE-EFFECT-IMPORTED from their owning module, so
// the actions actually register at runtime (a builtin file that compiles but is never imported
// registers nothing). Two-part proof: (a) importing each builtin file registers its ids
// (asserted here via the live registry), and (b) each owning `module.tsx` carries the
// side-effect import (asserted against the module source).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './sandboxSettingsActions'
import './workstoreSettingsActions'
import './provenanceSettingsActions'
import './jobsActions'
import { getActionMeta } from '../defineAction'

const NEW_IDS = [
  'sandbox.updateSettings',
  'workstore.updateSettings',
  'provenance.updateSettings',
  'jobs.updateSettings',
]

// owning module.tsx → the builtin file it must side-effect-import
const MODULE_IMPORTS: Record<string, string[]> = {
  'src/modules/sandbox/module.tsx': ['@/core/actions/builtin/sandboxSettingsActions'],
  'src/modules/workstore/module.tsx': ['@/core/actions/builtin/workstoreSettingsActions'],
  'src/modules/provenance/module.tsx': ['@/core/actions/builtin/provenanceSettingsActions'],
  // jobs.updateSettings lives in jobsActions.ts, imported once from command-palette/module.tsx.
  'src/modules/command-palette/module.tsx': ['@/core/actions/builtin/jobsActions'],
}

const SRC_ROOT = resolve(__dirname, '../../../..')

describe('actionWiring (TxResBench subset)', () => {
  it('side-effect imports register the action ids', () => {
    for (const id of NEW_IDS) {
      expect(getActionMeta(id), `${id} should be registered`).toBeDefined()
    }
  })

  it('each owning module side-effect-imports its builtin action file', () => {
    for (const [moduleFile, builtins] of Object.entries(MODULE_IMPORTS)) {
      const source = readFileSync(resolve(SRC_ROOT, moduleFile), 'utf8')
      for (const builtin of builtins) {
        expect(source, `${moduleFile} must import ${builtin}`).toContain(`import '${builtin}'`)
      }
    }
  })
})
