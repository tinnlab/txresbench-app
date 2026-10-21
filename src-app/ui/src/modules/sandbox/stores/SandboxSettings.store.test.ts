// @vitest-environment jsdom
// TEST-13 (#54) — the SandboxSettings store forwards a PARTIAL update (including the
// new per-class defaults + default_env_id fields) to ApiClient.Sandbox.updateSettings
// and re-stores the server-returned row (so the form reflects server clamping). The
// store is field-agnostic, so this proves the new fields round-trip through saveSettings.
//
// vitest (jsdom). Boundaries mocked: ApiClient.Sandbox.updateSettings + the permission
// gate; the real store runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxResourceLimits } from '@/api-client/types'

const perm = vi.fn(() => true)
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => perm() }))

const getSettings = vi.fn()
const updateSettings = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Sandbox: {
      getSettings: (...a: unknown[]) => getSettings(...a),
      updateSettings: (...a: unknown[]) => updateSettings(...a),
    },
  },
}))

const { useSandboxSettingsStore } = await import('./SandboxSettings.store')
const state = () => useSandboxSettingsStore.getState()

const BASE: SandboxResourceLimits = {
  memory_max_bytes: 8589934592,
  memory_swap_max_bytes: 8589934592,
  pids_max: 512,
  cpu_max: '200000 100000',
  address_space_bytes: 68719476736,
  fsize_bytes: 2147483648,
  nproc_max: 512,
  nofile_max: 4096,
  cpu_secs_max: 600,
  timeout_secs: 600,
  staging_timeout_secs: 900,
  interactive_cpu_cores: 2,
  interactive_mem_bytes: 4294967296,
  normal_cpu_cores: 2,
  normal_mem_bytes: 4294967296,
  batch_cpu_cores: 4,
  batch_mem_bytes: 8589934592,
  // default_env_id / updated_by are optional (unset = auto-detect / no writer yet).
}

beforeEach(() => {
  perm.mockReturnValue(true)
  getSettings.mockReset()
  updateSettings.mockReset()
  useSandboxSettingsStore.setState({ limits: { ...BASE }, loading: false, saving: false, error: null })
})

describe('TEST-13 — saveSettings forwards the new #54 fields', () => {
  it('forwards a partial per-class + env-id update and re-stores the returned row', async () => {
    const returned: SandboxResourceLimits = { ...BASE, batch_cpu_cores: 8, default_env_id: 'demo-env' }
    updateSettings.mockResolvedValueOnce(returned)

    const update = { batch_cpu_cores: 8, batch_mem_bytes: 8589934592, default_env_id: 'demo-env' }
    const ok = await state().saveSettings(update)

    expect(ok).toBe(true)
    expect(updateSettings).toHaveBeenCalledWith(update)
    expect(state().limits?.batch_cpu_cores).toBe(8)
    expect(state().limits?.default_env_id).toBe('demo-env')
    expect(state().saving).toBe(false)
  })

  it('refuses without the manage permission (no call)', async () => {
    perm.mockReturnValue(false)
    const ok = await state().saveSettings({ normal_cpu_cores: 3 })
    expect(ok).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
