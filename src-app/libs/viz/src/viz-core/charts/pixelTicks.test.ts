// pixelTicks.test.ts — BUG-1: axis tick marks must be a FIXED SCREEN-PIXEL length (not a data-space
// fraction that overruns the tick labels on a tall/wide pane). Proves `pixelTickTarget` re-derives a
// tick segment's far endpoint so its projected length is exactly `tickPx` px at any zoom, direction
// preserved — so the 8px label offset always clears the (default 6px) tick.
import { describe, it, expect } from 'vitest'
import { pixelTickTarget, dataPerPixel } from './ChartCanvas'

describe('pixelTickTarget — fixed screen-pixel axis ticks (BUG-1)', () => {
  it('X-axis tick (vertical segment) is exactly tickPx px long, pointing DOWN, x unchanged', () => {
    const [dppx, dppy] = dataPerPixel([2, 1]) // zy=1 → 0.5 data-units/px in y
    // source at the axis (y=10), original target points down (y=8) in data space.
    const t = pixelTickTarget([5, 10], [5, 8], dppx, dppy, 6)
    expect(t[0]).toBe(5) // x preserved
    // 6px * 0.5 data/px = 3 data-units below the axis; direction (down) preserved.
    expect(t[1]).toBeCloseTo(10 - 3, 6)
    // the projected pixel length is exactly tickPx.
    expect(Math.abs(t[1] - 10) / dppy).toBeCloseTo(6, 6)
  })

  it('Y-axis tick (horizontal segment) is exactly tickPx px long, pointing LEFT, y unchanged', () => {
    const [dppx, dppy] = dataPerPixel([2, 1]) // zx=2 → 0.25 data-units/px in x
    const t = pixelTickTarget([0, 3], [-40, 3], dppx, dppy, 6) // orig target far left (data-space)
    expect(t[1]).toBe(3) // y preserved
    expect(t[0]).toBeCloseTo(0 - 6 * 0.25, 6) // 6px left = 1.5 data-units
    expect(Math.abs(t[0] - 0) / dppx).toBeCloseTo(6, 6)
  })

  it('the fixed pixel length is INDEPENDENT of zoom (the whole point — no canvas-size overlap)', () => {
    // At a 4× tighter zoom the data-per-pixel halves, so the data-space tick length halves too —
    // keeping the SCREEN length constant at tickPx.
    const near = pixelTickTarget([5, 10], [5, 8], ...dataPerPixel([0, 0]), 6)
    const far = pixelTickTarget([5, 10], [5, 8], ...dataPerPixel([0, 2]), 6)
    const nearPx = Math.abs(near[1] - 10) / dataPerPixel([0, 0])[1]
    const farPx = Math.abs(far[1] - 10) / dataPerPixel([0, 2])[1]
    expect(nearPx).toBeCloseTo(6, 6)
    expect(farPx).toBeCloseTo(6, 6)
  })

  it('a scalar zoom applies equally to both axes', () => {
    expect(dataPerPixel(1)).toEqual([0.5, 0.5])
    expect(dataPerPixel([1, 3])).toEqual([0.5, 0.125])
  })
})
