// @vitest-environment jsdom
// TEST-1 (#48) [acceptance INV-1] — the GLOBAL feature-flag toggle is declared
// ONCE as a permissioned `defineAction` that is AI-drivable (present on the AI
// surface) and delegates to the SAME store method a human handler calls — proving
// the mutation is one shared definition, not an inline human-only onClick.
// TEST-3 (#48) — the action's zod params reject malformed input and accept a
// well-formed {flag_key, enabled}.
//
// vitest (jsdom). Boundary mocked: the store method the action wraps; the real
// action registry + zod validation run.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const setGlobal = vi.fn()
const setAccount = vi.fn()
const clearAccount = vi.fn()
vi.mock('@/modules/features/FeatureFlags.store', () => ({
  FeatureFlags: {
    setGlobal: (...a: unknown[]) => setGlobal(...a),
    setAccount: (...a: unknown[]) => setAccount(...a),
    clearAccount: (...a: unknown[]) => clearAccount(...a),
  },
}))

// Importing the builtin module registers the action as a side effect.
await import('./featureFlagActions')
const { getActionRegistry, runAction } = await import('../defineAction')

beforeEach(() => {
  setGlobal.mockReset()
  setAccount.mockReset()
  clearAccount.mockReset()
})

describe('TEST-1 — features.setGlobalFlag registration (INV-1: one AI-drivable definition)', () => {
  it('is registered with a real permission, mutating, global, dangerous, and on the AI surface', () => {
    const entry = getActionRegistry().get('features.setGlobalFlag')
    expect(entry, 'action must be registered').toBeTruthy()
    const meta = entry!.meta
    expect(meta.permission).toBe('features::manage')
    expect(meta.mutating).toBe(true)
    expect(meta.kind).toBe('global')
    expect(meta.dangerous).toBe(true)
    // AI-drivable: present on the capability manifest surface (INV-1) AND the palette.
    expect(meta.surfaces.ai).toBe(true)
    expect(meta.surfaces.palette).toBe(true)
  })

  it('run() delegates to the SAME store method a human handler calls', async () => {
    setGlobal.mockResolvedValueOnce({ flag_key: 'demo.runtime_flag', effective: true })
    await runAction('features.setGlobalFlag', {
      flag_key: 'demo.runtime_flag',
      enabled: true,
    })
    expect(setGlobal).toHaveBeenCalledWith('demo.runtime_flag', true)
  })
})

describe('TEST-3 — params validation', () => {
  it('rejects a missing flag_key', async () => {
    await expect(
      runAction('features.setGlobalFlag', { enabled: true }),
    ).rejects.toThrow(/invalid params/i)
    expect(setGlobal).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean enabled', async () => {
    await expect(
      runAction('features.setGlobalFlag', { flag_key: 'x', enabled: 'yes' }),
    ).rejects.toThrow(/invalid params/i)
    expect(setGlobal).not.toHaveBeenCalled()
  })

  it('accepts a well-formed {flag_key, enabled}', async () => {
    setGlobal.mockResolvedValueOnce({})
    await expect(
      runAction('features.setGlobalFlag', { flag_key: 'x', enabled: false }),
    ).resolves.toBeDefined()
    expect(setGlobal).toHaveBeenCalledWith('x', false)
  })
})

describe('TEST-8 — per-account actions (#53) [acceptance INV-5: one AI-drivable definition]', () => {
  it('features.setAccountFlag is a mutating features::manage action that delegates to FeatureFlags.setAccount', async () => {
    const entry = getActionRegistry().get('features.setAccountFlag')
    expect(entry, 'setAccountFlag registered').toBeTruthy()
    const meta = entry!.meta
    expect(meta.permission).toBe('features::manage')
    expect(meta.mutating).toBe(true)
    expect(meta.surfaces.ai).toBe(true)
    expect(meta.surfaces.palette).toBe(true)

    setAccount.mockResolvedValueOnce({ flag_key: 'demo.runtime_flag', effective: false })
    await runAction('features.setAccountFlag', {
      flag_key: 'demo.runtime_flag',
      account_id: 'acct-1',
      enabled: false,
    })
    expect(setAccount).toHaveBeenCalledWith('demo.runtime_flag', 'acct-1', false)
  })

  it('features.clearAccountOverride is a mutating features::manage action that delegates to FeatureFlags.clearAccount', async () => {
    const entry = getActionRegistry().get('features.clearAccountOverride')
    expect(entry, 'clearAccountOverride registered').toBeTruthy()
    const meta = entry!.meta
    expect(meta.permission).toBe('features::manage')
    expect(meta.mutating).toBe(true)
    expect(meta.surfaces.ai).toBe(true)
    expect(meta.surfaces.palette).toBe(true)

    clearAccount.mockResolvedValueOnce({ flag_key: 'demo.runtime_flag', effective: true })
    await runAction('features.clearAccountOverride', {
      flag_key: 'demo.runtime_flag',
      account_id: 'acct-1',
    })
    expect(clearAccount).toHaveBeenCalledWith('demo.runtime_flag', 'acct-1')
  })

  it('rejects malformed params (missing account_id) for both actions', async () => {
    await expect(
      runAction('features.setAccountFlag', { flag_key: 'x', enabled: true }),
    ).rejects.toThrow(/invalid params/i)
    await expect(
      runAction('features.clearAccountOverride', { flag_key: 'x' }),
    ).rejects.toThrow(/invalid params/i)
    expect(setAccount).not.toHaveBeenCalled()
    expect(clearAccount).not.toHaveBeenCalled()
  })
})
