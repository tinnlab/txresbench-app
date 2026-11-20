import { describe, expect, it } from 'vitest'

import { ENV_FAMILY_CODES, isEnvFamilyCode } from './trouble'

describe('the environment family of reason codes', () => {
  it('holds the runner codes of the Mac method VM and the Windows runner', () => {
    expect(isEnvFamilyCode('SANDBOX_VM_UNAVAILABLE')).toBe(true)
    expect(isEnvFamilyCode('SANDBOX_WSL_UNAVAILABLE')).toBe(true)
    expect(isEnvFamilyCode('SANDBOX_UNAVAILABLE')).toBe(true)
  })

  it('keeps a copy-back failure and unknown codes out of it', () => {
    expect(isEnvFamilyCode('SANDBOX_VM_OUTPUTS_INCOMPLETE')).toBe(false)
    expect(isEnvFamilyCode('PREDICTION_INVALID')).toBe(false)
    expect(isEnvFamilyCode(null)).toBe(false)
    expect(isEnvFamilyCode(undefined)).toBe(false)
    expect(ENV_FAMILY_CODES.size).toBe(7)
  })
})
