import { describe, it, expect } from 'vitest'
import { deviceRectFor, effectiveDpr } from './cropCanvas'

describe('deviceRectFor', () => {
  it('is identity when the backing store matches the CSS size (1:1)', () => {
    const r = deviceRectFor({ x: 10, y: 20, width: 100, height: 50 }, 400, 300, 400, 300)
    expect(r).toEqual({ sx: 10, sy: 20, sw: 100, sh: 50 })
  })

  it('scales a CSS rect into device pixels by store/css ratio (2× backing store)', () => {
    // Canvas displayed at 640×480 CSS but backed by an 1280×960 store → ratio 2.
    const r = deviceRectFor({ x: 32, y: 16, width: 128, height: 64 }, 640, 480, 1280, 960)
    expect(r.sx).toBe(64) // 32 * (1280/640)
    expect(r.sy).toBe(32) // 16 * (960/480)
    expect(r.sw).toBe(256) // 128 * 2
    expect(r.sh).toBe(128) // 64 * 2
  })

  it('handles a non-integer (1.5×) backing-store ratio', () => {
    const r = deviceRectFor({ x: 100, y: 0, width: 200, height: 100 }, 1000, 500, 1500, 750)
    expect(r.sx).toBe(150) // 100 * 1.5
    expect(r.sw).toBe(300) // 200 * 1.5
    expect(r.sh).toBe(150) // 100 * 1.5
  })

  it('clamps a rect that overflows the right/bottom edge', () => {
    // Rect asks for x=900,w=200 on a 1000-wide store → only 100 remains.
    const r = deviceRectFor({ x: 900, y: 700, width: 200, height: 400 }, 1000, 1000, 1000, 1000)
    expect(r.sx).toBe(900)
    expect(r.sw).toBe(100) // clamped: 1000 - 900
    expect(r.sy).toBe(700)
    expect(r.sh).toBe(300) // clamped: 1000 - 700
  })

  it('clamps a negative origin inward (drops the off-canvas overhang)', () => {
    const r = deviceRectFor({ x: -20, y: -10, width: 100, height: 60 }, 500, 500, 500, 500)
    expect(r.sx).toBe(0)
    expect(r.sw).toBe(80) // 100 - 20 overhang
    expect(r.sy).toBe(0)
    expect(r.sh).toBe(50) // 60 - 10 overhang
  })

  it('never returns a negative width when the rect is fully off-canvas', () => {
    const r = deviceRectFor({ x: 2000, y: 0, width: 100, height: 100 }, 1000, 1000, 1000, 1000)
    expect(r.sw).toBe(0)
    expect(r.sh).toBeGreaterThanOrEqual(0)
  })
})

describe('effectiveDpr', () => {
  it('honors an explicit positive dpr', () => {
    expect(effectiveDpr(3)).toBe(3)
    expect(effectiveDpr(1.5)).toBe(1.5)
  })

  it('falls back for a missing / non-positive dpr', () => {
    // In the node test env there is no window → the floor of 1.
    expect(effectiveDpr(0)).toBeGreaterThanOrEqual(1)
    expect(effectiveDpr(-2)).toBeGreaterThanOrEqual(1)
    expect(effectiveDpr(undefined)).toBeGreaterThanOrEqual(1)
  })
})
