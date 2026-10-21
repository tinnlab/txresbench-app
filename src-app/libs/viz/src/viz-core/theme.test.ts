// theme.test.ts — L0 unit test for the viz CHROME theme constants (DEC-39). Asserts both
// themes exist, carry all VizTheme keys, and differ (so chrome is actually theme-aware).

import { describe, it, expect } from 'vitest'
import { LIGHT_THEME, DARK_THEME, type VizTheme } from './theme'

const KEYS: (keyof VizTheme)[] = ['fg', 'muted', 'grid', 'surface', 'border']

describe('VizTheme constants (TEST theme)', () => {
  it('both themes define every VizTheme key as a non-empty string', () => {
    for (const theme of [LIGHT_THEME, DARK_THEME]) {
      for (const key of KEYS) {
        expect(typeof theme[key]).toBe('string')
        expect(theme[key].length).toBeGreaterThan(0)
      }
    }
  })

  it('light and dark differ on every key (chrome is theme-aware)', () => {
    for (const key of KEYS) {
      expect(LIGHT_THEME[key]).not.toBe(DARK_THEME[key])
    }
  })

  it('light is dark-on-light and dark is light-on-dark (surface/fg inverted)', () => {
    expect(LIGHT_THEME.surface).toBe('#ffffff')
    expect(DARK_THEME.surface).toBe('#0b1220')
    expect(LIGHT_THEME).not.toEqual(DARK_THEME)
  })
})
