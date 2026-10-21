import { describe, it, expect } from 'vitest'
import { windowRange } from './WindowedList'

describe('windowRange', () => {
  it('renders only the visible window (+overscan) at the top', () => {
    // 10000 rows × 30px, 300px viewport, overscan 4. At scrollTop 0: first=-4→0.
    const r = windowRange(0, 300, 30, 10000, 4)
    expect(r.start).toBe(0)
    // first = floor(0/30)-4 = -4 (clipped to start 0); end = first + visible(18) = 14 (the above-
    // overscan clips at the top), i.e. 10 visible + 4 below.
    expect(r.end).toBe(14)
    expect(r.padTop).toBe(0)
    expect(r.totalHeight).toBe(300000)
  })

  it('windows correctly when scrolled into the middle', () => {
    const r = windowRange(3000, 300, 30, 10000, 4)
    // first = floor(3000/30) - 4 = 100 - 4 = 96
    expect(r.start).toBe(96)
    expect(r.padTop).toBe(96 * 30)
    // visible = ceil(300/30)+8 = 18 → end = 96 + 18 = 114
    expect(r.end).toBe(114)
  })

  it('renders only a bounded row count even for a 50k list', () => {
    const r = windowRange(750000, 400, 30, 50000, 4)
    expect(r.end - r.start).toBeLessThanOrEqual(30) // never the whole 50k
  })

  it('clamps the end to itemCount near the bottom', () => {
    const r = windowRange(299700, 300, 30, 10000, 4) // last page
    expect(r.end).toBe(10000)
    expect(r.start).toBeLessThan(10000)
  })

  it('never returns start>end for an out-of-content scrollTop (contract: start<=end)', () => {
    const r = windowRange(1e9, 300, 30, 100, 4)
    expect(r.start).toBeLessThanOrEqual(r.end)
    expect(r.start).toBeLessThanOrEqual(100)
    expect(r.padTop).toBeLessThanOrEqual(r.totalHeight)
  })

  it('handles empty + degenerate inputs without NaN', () => {
    const empty = windowRange(0, 300, 30, 0, 4)
    expect(empty.start).toBe(0)
    expect(empty.end).toBe(0)
    expect(empty.totalHeight).toBe(0)
    const zeroRow = windowRange(0, 300, 0, 100, 4) // rowHeight coerced to 1
    expect(zeroRow.totalHeight).toBe(100)
    const negScroll = windowRange(-500, 300, 30, 100, 4)
    expect(negScroll.start).toBe(0)
  })
})
