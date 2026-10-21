// perfProbe.test.ts — L0 unit tests for the pure perf helpers (ITEM-59). The math is
// verified on KNOWN timestamp arrays: a constant 16.667ms cadence → 60fps; a tail spike
// → p95/minFps reflect the worst frame; degenerate input → safe zeros; and the budget
// verdict passes/fails on the right conditions.

import { describe, it, expect } from 'vitest'
import { frameStats, perfVerdict, RollingFrameTimer } from './perfProbe'

/** build timestamps (t0=0) from a list of per-frame durations. */
function tsFromDeltas(deltas: number[]): number[] {
  const ts = [0]
  for (const d of deltas) ts.push(ts[ts.length - 1] + d)
  return ts
}

const FRAME_60 = 1000 / 60 // 16.6667ms

describe('frameStats — constant 16.667ms cadence ⇒ 60fps', () => {
  const ts = tsFromDeltas(Array.from({ length: 60 }, () => FRAME_60))
  const s = frameStats(ts)

  it('counts frame INTERVALS (timestamps - 1)', () => {
    expect(s.frames).toBe(60) // 61 timestamps → 60 intervals
  })
  it('mean/median frame time is the constant', () => {
    expect(s.meanMs).toBeCloseTo(FRAME_60, 6)
    expect(s.medianMs).toBeCloseTo(FRAME_60, 6)
  })
  it('p95 equals the constant (no spread)', () => {
    expect(s.p95Ms).toBeCloseTo(FRAME_60, 6)
  })
  it('mean fps and min fps are both 60', () => {
    expect(s.meanFps).toBeCloseTo(60, 6)
    expect(s.minFps).toBeCloseTo(60, 6)
  })
})

describe('frameStats — a tail spike shows up in p95 / minFps, not (much) in the mean', () => {
  // 90 smooth 10ms frames + 10 janky 50ms frames (100 intervals).
  const deltas = [...Array(90).fill(10), ...Array(10).fill(50)]
  const s = frameStats(tsFromDeltas(deltas))

  it('frames = 100', () => {
    expect(s.frames).toBe(100)
  })
  it('mean stays low (14ms) — the spike is only 10% of frames', () => {
    // (90*10 + 10*50) / 100 = 14
    expect(s.meanMs).toBeCloseTo(14, 6)
  })
  it('median is the common 10ms frame', () => {
    expect(s.medianMs).toBeCloseTo(10, 6)
  })
  it('p95 reflects the 50ms spike (nearest-rank 95th percentile)', () => {
    expect(s.p95Ms).toBeCloseTo(50, 6)
  })
  it('minFps derives from the SLOWEST frame (1000/50 = 20)', () => {
    expect(s.minFps).toBeCloseTo(20, 6)
  })
})

describe('frameStats — degenerate input ⇒ safe zeros (never NaN/Infinity)', () => {
  it('empty array', () => {
    expect(frameStats([])).toEqual({
      frames: 0, meanMs: 0, medianMs: 0, p95Ms: 0, minFps: 0, meanFps: 0,
    })
  })
  it('single timestamp (zero intervals)', () => {
    expect(frameStats([5])).toEqual({
      frames: 0, meanMs: 0, medianMs: 0, p95Ms: 0, minFps: 0, meanFps: 0,
    })
  })
  it('non-monotonic clock: negative deltas clamp to 0 (no negative fps)', () => {
    const s = frameStats([0, 10, 5, 20]) // deltas 10, -5→0, 15
    expect(s.frames).toBe(3)
    expect(s.meanMs).toBeCloseTo((10 + 0 + 15) / 3, 6)
    expect(s.minFps).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(s.meanFps)).toBe(true)
  })
})

describe('perfVerdict', () => {
  const good = frameStats(tsFromDeltas(Array.from({ length: 60 }, () => FRAME_60))) // 60fps

  it('passes an empty budget when frames rendered (implicit non-zero-fps gate)', () => {
    expect(perfVerdict(good, {})).toEqual({ ok: true, reasons: [] })
  })
  it('always fails on nothing rendered, even with an empty budget', () => {
    const v = perfVerdict(frameStats([]), {})
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toMatch(/no frames rendered/)
  })
  it('passes a strict ~60fps budget on the 60fps run', () => {
    // minFps 59 (not exactly 60) avoids float-accumulation fragility in the timestamps.
    expect(perfVerdict(good, { minFps: 59, maxP95Ms: 17 }).ok).toBe(true)
  })
  it('fails minFps when the worst frame is too slow', () => {
    const slow = frameStats(tsFromDeltas([16.7, 16.7, 100])) // min fps = 10
    const v = perfVerdict(slow, { minFps: 60 })
    expect(v.ok).toBe(false)
    expect(v.reasons.some(r => /min fps/.test(r))).toBe(true)
  })
  it('fails maxP95Ms when the tail frame is too long', () => {
    // two slow tail frames land in the top 5% (n=20 ⇒ nearest-rank p95 = index 19/20).
    const janky = frameStats(tsFromDeltas([...Array(18).fill(10), 80, 80])) // p95 = 80
    const v = perfVerdict(janky, { maxP95Ms: 16.7 })
    expect(v.ok).toBe(false)
    expect(v.reasons.some(r => /p95/.test(r))).toBe(true)
  })
  it('fails minFrames when too few frames were rendered', () => {
    const few = frameStats(tsFromDeltas([16.7, 16.7])) // 2 frames
    const v = perfVerdict(few, { minFrames: 10 })
    expect(v.ok).toBe(false)
    expect(v.reasons.some(r => /frames rendered/.test(r))).toBe(true)
  })
})

describe('RollingFrameTimer — injectable clock for deterministic timing', () => {
  it('start/mark/stop collects timestamps that frameStats reads', () => {
    let now = 0
    const t = new RollingFrameTimer(() => now)
    t.start()
    for (let i = 0; i < 5; i++) {
      now += FRAME_60
      t.mark()
    }
    const ts = t.stop()
    expect(ts.length).toBe(6) // start + 5 marks
    expect(t.count).toBe(6)
    const s = frameStats(ts)
    expect(s.frames).toBe(5)
    expect(s.meanFps).toBeCloseTo(60, 6)
  })
  it('stop() returns a defensive copy (mutating it does not corrupt the timer)', () => {
    let now = 0
    const t = new RollingFrameTimer(() => now)
    t.start()
    now += 16
    t.mark()
    const a = t.stop()
    a.push(999)
    expect(t.count).toBe(2)
  })
})
