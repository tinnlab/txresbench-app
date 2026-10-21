import { describe, it, expect } from 'vitest'
import { colorbarLabel, colorbarDescriptor } from './color'

describe('colorbar unit label (ITEM-17)', () => {
  it('composes quantity + unit', () => {
    expect(colorbarLabel('mean expression', 'z-score')).toBe('mean expression (z-score)')
    expect(colorbarLabel('counts')).toBe('counts')
  })
  it('flows a label onto the colorbar descriptor', () => {
    const cb = colorbarDescriptor('viridis', [0, 1], 8, colorbarLabel('expression', 'CPM'))
    expect(cb.label).toBe('expression (CPM)')
    expect(colorbarDescriptor('viridis', [0, 1]).label).toBeUndefined() // absent by default
  })
})
