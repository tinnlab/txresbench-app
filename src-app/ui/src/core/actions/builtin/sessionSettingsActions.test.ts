// TEST-8 (#49) — the auth.updateSessionSettings admin settings-save mutation is a permissioned defineAction
// dispatched via runAction in its settings page (not a human-only form submit), with the
// exact permission that gates the settings PUT.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './sessionSettingsActions' // register
import { getActionMeta } from '../defineAction'

const ID = 'auth.updateSessionSettings'
const PERMISSION = 'auth::session_settings::manage'
const COMPONENT = 'src/modules/auth/SessionSettingsPage.tsx'

describe('TEST-8 — auth.updateSessionSettings is a permissioned, AI-drivable settings defineAction', () => {
  it('is registered, mutating, AI-surfaced with the exact permission', () => {
    const meta = getActionMeta(ID)
    expect(meta, ID + ' not registered').toBeTruthy()
    expect(meta?.permission).toBe(PERMISSION)
    expect(meta?.mutating).toBe(true)
    expect(meta?.surfaces?.ai).not.toBe(false)
  })
  it('is dispatched via runAction in its settings page', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    expect(src).toContain("runAction('" + ID + "'")
  })
})
