// TEST-13 [covers ITEM-11] — mcp.updateSettings is a permissioned, AI-drivable
// defineAction dispatched via runAction in its settings card (not a human-only form
// submit), with the exact permission that gates the settings PUT.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './mcpSettingsActions' // register
import { getActionMeta } from '../defineAction'

const ID = 'mcp.updateSettings'
const PERMISSION = 'mcp::settings::manage'
const COMPONENT = 'src/modules/mcp/components/McpLimitsCard.tsx'

describe('TEST-13 — mcp.updateSettings is a permissioned, AI-drivable settings defineAction', () => {
  it('is registered, mutating, AI-surfaced with the exact permission', () => {
    const meta = getActionMeta(ID)
    expect(meta, ID + ' not registered').toBeTruthy()
    expect(meta?.permission).toBe(PERMISSION)
    expect(meta?.mutating).toBe(true)
    expect(meta?.surfaces?.ai).toBe(true)
  })
  it('is dispatched via runAction in its settings card', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    expect(src).toContain("runAction('" + ID + "'")
  })
})
