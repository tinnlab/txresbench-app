import { describe, it, expect } from 'vitest'
import {
  OKABE_ITO, OKABE_ITO_MAX, exceedsCategoricalCap,
  isMonotonicLuminance, sampleLuminance, BANNED_SEQUENTIAL, symmetricDivergingDomain,
} from './pubreadyColor'

describe('Okabe-Ito (ITEM-11)', () => {
  it('has 8 colors starting with black', () => {
    expect(OKABE_ITO.length).toBe(8)
    expect(OKABE_ITO[0]).toEqual([0, 0, 0])
    expect(OKABE_ITO_MAX).toBe(8)
  })
  it('flags category counts over the cap (facet nudge)', () => {
    expect(exceedsCategoricalCap(8)).toBe(false)
    expect(exceedsCategoricalCap(9)).toBe(true)
  })
})

describe('monotonic-luminance gate (ITEM-10)', () => {
  it('viridis and cividis are monotonic (grayscale-safe)', () => {
    expect(isMonotonicLuminance('viridis')).toBe(true)
    expect(isMonotonicLuminance('cividis')).toBe(true)
  })
  it('turbo (rainbow) is NOT monotonic', () => {
    expect(isMonotonicLuminance('turbo')).toBe(false)
  })
  it('turbo is on the banned sequential list', () => {
    expect(BANNED_SEQUENTIAL).toContain('turbo')
  })
  it('sampleLuminance returns the requested number of steps', () => {
    expect(sampleLuminance('viridis', 10)).toHaveLength(10)
  })
})

describe('symmetric diverging domain (ITEM-12)', () => {
  it('centers a signed range at 0 with vmin = -vmax', () => {
    expect(symmetricDivergingDomain([-2, 5])).toEqual([-5, 5])
    expect(symmetricDivergingDomain([1, 3])).toEqual([-3, 3])
    expect(symmetricDivergingDomain([-8, 2])).toEqual([-8, 8])
  })
})
