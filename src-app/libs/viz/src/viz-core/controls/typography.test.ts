import { describe, it, expect } from 'vitest'
import { resolveTextStyle, fontShorthand, DEFAULT_FONT_FAMILY, DEFAULT_BASE_SIZE } from './typography'

describe('resolveTextStyle', () => {
  it('undefined typography → built-in defaults (family + base-scaled sizes)', () => {
    expect(resolveTextStyle(undefined, 'title')).toEqual({ family: DEFAULT_FONT_FAMILY, size: Math.round(DEFAULT_BASE_SIZE * 1.3), weight: 'bold' })
    expect(resolveTextStyle(undefined, 'tick')).toEqual({ family: DEFAULT_FONT_FAMILY, size: Math.round(DEFAULT_BASE_SIZE * 0.92), weight: 'normal' })
  })
  it('figure-wide family + base size flow to every element', () => {
    const t = { fontFamily: 'Inter', baseSize: 20 }
    expect(resolveTextStyle(t, 'title').family).toBe('Inter')
    expect(resolveTextStyle(t, 'legend').family).toBe('Inter')
    expect(resolveTextStyle(t, 'axis').size).toBe(Math.round(20 * 1.08))
  })
  it('a per-element override wins over the figure default', () => {
    const t = { fontFamily: 'Inter', baseSize: 12, tick: { size: 9, family: 'Roboto' }, title: { weight: 'normal' as const } }
    const tick = resolveTextStyle(t, 'tick')
    expect(tick).toEqual({ family: 'Roboto', size: 9, weight: 'normal' })
    expect(resolveTextStyle(t, 'title').weight).toBe('normal') // overrode the default bold
  })
  it('guards non-positive sizes back to the default', () => {
    expect(resolveTextStyle({ baseSize: 0 }, 'tick').size).toBe(Math.round(DEFAULT_BASE_SIZE * 0.92))
    expect(resolveTextStyle({ baseSize: 12, tick: { size: -3 } }, 'tick').size).toBe(Math.round(12 * 0.92))
  })
})

describe('fontShorthand', () => {
  it('emits a canvas/DOM font string, bold-prefixed only when bold', () => {
    expect(fontShorthand({ family: 'Inter', size: 14, weight: 'normal' })).toBe('14px Inter')
    expect(fontShorthand({ family: 'Arial', size: 16, weight: 'bold' })).toBe('700 16px Arial')
  })
})
