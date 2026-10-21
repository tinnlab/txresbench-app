// TEST-5 (#49) — the sandbox.updateSettings admin settings-save mutation is a permissioned defineAction
// dispatched via runAction in its settings page (not a human-only form submit), with the
// exact permission that gates the settings PUT.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './sandboxSettingsActions' // register
import { getActionMeta } from '../defineAction'

const ID = 'sandbox.updateSettings'
const PERMISSION = 'sandbox::settings::manage'
const COMPONENT = 'src/modules/sandbox/components/ResourceLimitsCard.tsx'

describe('TEST-5 — sandbox.updateSettings is a permissioned, AI-drivable settings defineAction', () => {
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
