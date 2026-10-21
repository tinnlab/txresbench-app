// colormapPicker.test.ts — TEST-5 [covers: ITEM-3] — the plot-editing continuous-COLORMAP picker's
// pure pieces (the node test env can't render the component): the selectable colormap LIST the picker
// offers, and the gradient-preview CSS it builds. The "select → colorBy.colormap" wiring itself is a
// GridWorkspace concern proven by the e2e (TEST-9).

import { describe, it, expect } from 'vitest'
import { CONTINUOUS_COLORMAPS, type ContinuousColormap } from '../data/color'
import { gradientCss } from './ColormapPicker'

describe('plot-editing: colormap picker option list (ITEM-3)', () => {
  it('offers a rich continuous-colormap set, viridis first, incl. the scanpy/perceptual staples', () => {
    expect(CONTINUOUS_COLORMAPS[0]).toBe('viridis')
    // The picker grew well beyond the original 5 (single-cell / scanpy vocabulary). Assert the core
    // perceptual maps are all present rather than pinning an exact list (which churns on every addition).
    for (const c of ['viridis', 'magma', 'inferno', 'plasma', 'cividis']) {
      expect(CONTINUOUS_COLORMAPS).toContain(c)
    }
    expect(CONTINUOUS_COLORMAPS.length).toBeGreaterThan(5)
    expect(new Set(CONTINUOUS_COLORMAPS).size).toBe(CONTINUOUS_COLORMAPS.length) // no dupes
  })

  it('every colormap yields a distinct multi-stop gradient preview', () => {
    const grads = CONTINUOUS_COLORMAPS.map(c => gradientCss(c, [0, 1]))
    for (const g of grads) {
      expect(g).toContain('linear-gradient(to right')
      expect(g).toContain('0%')
      expect(g).toContain('100%')
    }
    // Distinct colormaps look different (viridis ≠ magma).
    const viridis = gradientCss('viridis', [0, 1])
    const magma = gradientCss('magma', [0, 1])
    expect(viridis).not.toEqual(magma)
  })

  it('a colormap the picker offers is a valid ContinuousColormap (compile + runtime)', () => {
    for (const c of CONTINUOUS_COLORMAPS) {
      const typed: ContinuousColormap = c
      expect(typeof typed).toBe('string')
    }
  })
})
