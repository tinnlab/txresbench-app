import { describe, it, expect } from 'vitest'
import { simulateColor, simulateImage } from './cvd'

describe('CVD simulation (ITEM-9)', () => {
  it('grayscale collapses to equal channels (BT.709 luminance)', () => {
    const [r, g, b] = simulateColor([255, 0, 0], 'grayscale')
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r).toBe(Math.round(0.2126 * 255))
  })
  it('deuteranopia confuses red/green (pure red shifts toward the green response)', () => {
    const red = simulateColor([255, 0, 0], 'deuteranopia')
    // red is no longer pure: the green channel picks up energy under deuteranopia.
    expect(red[1]).toBeGreaterThan(0)
  })
  it('leaves output in 0..255 and preserves alpha per pixel', () => {
    const img = new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 200])
    const out = simulateImage(img, 'protanopia')
    expect(out.length).toBe(img.length)
    expect(out[3]).toBe(128)
    expect(out[7]).toBe(200)
    for (const v of out) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255) }
  })
  it('every kind returns a value (no throw)', () => {
    for (const k of ['deuteranopia', 'protanopia', 'tritanopia', 'grayscale'] as const) {
      expect(simulateColor([120, 200, 40], k)).toHaveLength(3)
    }
  })
})
