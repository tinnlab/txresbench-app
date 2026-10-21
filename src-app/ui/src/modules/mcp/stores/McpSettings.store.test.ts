// TEST-12 [covers ITEM-8/9] — the mcp settings store loads via ApiClient.Mcp, is
// guarded by the read permission, and its save delegates to updateSettings + re-stores
// the returned row. The Permissions constants proving `just openapi-regen` landed the
// new perms are asserted too.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permissions } from '@/api-client/permissions'

const h = vi.hoisted(() => ({ readOk: true, manageOk: true }))
const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock('@/core/permissions', () => ({
  hasPermissionNow: (p: string) => (p === 'mcp::settings::manage' ? h.manageOk : h.readOk),
}))
vi.mock('@/api-client', () => ({ ApiClient: { Mcp: api } }))

const { McpSettings, useMcpSettingsStore } = await import('./McpSettings.store')

const row = {
  max_control_sessions: 1024,
  max_inflight_per_user: 16,
  pairing_ttl_secs: 300,
  action_wall_clock_secs: 900,
  max_list_results: 200,
  max_result_bytes: 1048576,
}

beforeEach(() => {
  h.readOk = true
  h.manageOk = true
  Object.values(api).forEach(f => f.mockReset())
  useMcpSettingsStore.setState({
    settings: null,
    loading: false,
    saving: false,
    error: null,
  } as never)
})

describe('TEST-12 — McpSettings store', () => {
  it('loads settings via ApiClient.Mcp.getSettings and maps them into state', async () => {
    api.getSettings.mockResolvedValue(row)
    await McpSettings.loadSettings()
    expect(api.getSettings).toHaveBeenCalled()
    expect(useMcpSettingsStore.getState().settings).toEqual(row)
  })

  it('skips the load when the read permission is not held', async () => {
    h.readOk = false
    await McpSettings.loadSettings()
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('save delegates to updateSettings and re-stores the returned row', async () => {
    const updated = { ...row, max_inflight_per_user: 48 }
    api.updateSettings.mockResolvedValue(updated)
    const ok = await McpSettings.saveSettings({ max_inflight_per_user: 48 })
    expect(ok).toBe(true)
    expect(api.updateSettings).toHaveBeenCalledWith({ max_inflight_per_user: 48 })
    expect(useMcpSettingsStore.getState().settings).toEqual(updated)
  })

  it('skips the save when the manage permission is not held', async () => {
    h.manageOk = false
    const ok = await McpSettings.saveSettings({ max_inflight_per_user: 48 })
    expect(ok).toBe(false)
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('the regenerated Permissions constants equal the exact strings', () => {
    expect(Permissions.McpSettingsRead).toBe('mcp::settings::read')
    expect(Permissions.McpSettingsManage).toBe('mcp::settings::manage')
  })
})
