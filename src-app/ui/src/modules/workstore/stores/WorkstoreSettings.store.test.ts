// TEST-10 [covers ITEM-8] — the workstore settings store loads via ApiClient.Workstore,
// is guarded by the read permission, and its save delegates to updateSettings + re-stores
// the returned row.
// TEST-14 [covers ITEM-12] — the regenerated Permissions constants exist and equal the
// exact permission strings (proves `just openapi-regen` landed the new perms).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permissions } from '@/api-client/permissions'

const h = vi.hoisted(() => ({ readOk: true, manageOk: true }))
const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock('@/core/permissions', () => ({
  hasPermissionNow: (p: string) =>
    p === 'workstore::settings::manage' ? h.manageOk : h.readOk,
}))
vi.mock('@/api-client', () => ({ ApiClient: { Workstore: api } }))

const { WorkstoreSettings, useWorkstoreSettingsStore } = await import('./WorkstoreSettings.store')

// uncapped-uploads: fixture carries the two promoted upload-limit knobs (#185 §1) so
// the store's types still check once `WorkstoreSettings` grows the fields.
const row = {
  gc_enabled: true,
  gc_interval_hours: 6,
  gc_grace_secs: 3600,
  max_output_file_bytes: 8589934592,
  max_multifile_total_bytes: 34359738368,
  max_upload_body_bytes: 68719476736,
  max_upload_parts: 1024,
}

beforeEach(() => {
  h.readOk = true
  h.manageOk = true
  Object.values(api).forEach(f => f.mockReset())
  useWorkstoreSettingsStore.setState({
    settings: null,
    loading: false,
    saving: false,
    error: null,
  } as never)
})

describe('TEST-10 — WorkstoreSettings store', () => {
  it('loads settings via ApiClient.Workstore.getSettings and maps them into state', async () => {
    api.getSettings.mockResolvedValue(row)
    await WorkstoreSettings.loadSettings()
    expect(api.getSettings).toHaveBeenCalled()
    expect(useWorkstoreSettingsStore.getState().settings).toEqual(row)
  })

  it('skips the load when the read permission is not held', async () => {
    h.readOk = false
    await WorkstoreSettings.loadSettings()
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('save delegates to updateSettings and re-stores the returned row', async () => {
    const updated = { ...row, gc_interval_hours: 12 }
    api.updateSettings.mockResolvedValue(updated)
    const ok = await WorkstoreSettings.saveSettings({ gc_interval_hours: 12 })
    expect(ok).toBe(true)
    expect(api.updateSettings).toHaveBeenCalledWith({ gc_interval_hours: 12 })
    expect(useWorkstoreSettingsStore.getState().settings).toEqual(updated)
  })

  it('skips the save when the manage permission is not held', async () => {
    h.manageOk = false
    const ok = await WorkstoreSettings.saveSettings({ gc_interval_hours: 12 })
    expect(ok).toBe(false)
    expect(api.updateSettings).not.toHaveBeenCalled()
  })
})

describe('TEST-14 — regenerated workstore permission constants', () => {
  it('exist and equal the exact permission strings', () => {
    expect(Permissions.WorkstoreSettingsRead).toBe('workstore::settings::read')
    expect(Permissions.WorkstoreSettingsManage).toBe('workstore::settings::manage')
  })
})
