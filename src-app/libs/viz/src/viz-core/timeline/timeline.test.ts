// timeline.test.ts — unit tests for the pure timeline model + frame→range math.

import { describe, it, expect } from 'vitest'
import {
  createTimeline,
  frameToRange,
  frameCenter,
  frameLabel,
  step,
  seek,
  advance,
  setPlaying,
  setSpeed,
} from './timeline'

describe('frameToRange (sliding window)', () => {
  it('window sits at the LOW end on frame 0 (clamped to min)', () => {
    const [lo, hi] = frameToRange(0, { min: 0, max: 10, frameCount: 11, window: 0.2 })
    expect(lo).toBeCloseTo(0, 6) // clamped to min
    expect(hi).toBeCloseTo(2, 6) // width = 0.2 * 10
  })

  it('window sits at the HIGH end on the last frame (clamped to max)', () => {
    const [lo, hi] = frameToRange(10, { min: 0, max: 10, frameCount: 11, window: 0.2 })
    expect(lo).toBeCloseTo(8, 6) // max - width
    expect(hi).toBeCloseTo(10, 6) // clamped to max
  })

  it('window is centered mid-travel at the middle frame', () => {
    const [lo, hi] = frameToRange(5, { min: 0, max: 10, frameCount: 11, window: 0.2 })
    // travel = 8, t = 0.5 → lo = 4, hi = 6
    expect(lo).toBeCloseTo(4, 6)
    expect(hi).toBeCloseTo(6, 6)
  })

  it('window ≥ 1 covers the whole domain (no travel)', () => {
    expect(frameToRange(0, { min: -3, max: 7, frameCount: 5, window: 1 })).toEqual([-3, 7])
    expect(frameToRange(3, { min: -3, max: 7, frameCount: 5, window: 1.5 })).toEqual([-3, 7])
  })

  it('degenerate span returns [min,max]', () => {
    expect(frameToRange(2, { min: 5, max: 5, frameCount: 4, window: 0.3 })).toEqual([5, 5])
  })

  it('single-frame timeline pins t=0 (window at low end)', () => {
    const [lo, hi] = frameToRange(0, { min: 0, max: 10, frameCount: 1, window: 0.2 })
    expect(lo).toBeCloseTo(0, 6)
    expect(hi).toBeCloseTo(2, 6)
  })

  it('frameCenter is the window midpoint', () => {
    expect(frameCenter(5, { min: 0, max: 10, frameCount: 11, window: 0.2 })).toBeCloseTo(5, 6)
  })
})

describe('step (integer stepping + looping)', () => {
  const m = createTimeline(0, 1, 5, { frame: 0 })

  it('steps forward', () => {
    expect(step(m, 1).frame).toBe(1)
    expect(step(m, 3).frame).toBe(3)
  })

  it('loops past the end', () => {
    expect(step({ ...m, frame: 4 }, 1).frame).toBe(0) // 5 wraps → 0
    expect(step({ ...m, frame: 4 }, 3).frame).toBe(2) // 7 % 5 = 2
  })

  it('loops below zero (prev on frame 0)', () => {
    expect(step({ ...m, frame: 0 }, -1).frame).toBe(4)
    expect(step({ ...m, frame: 1 }, -3).frame).toBe(3) // -2 → 3
  })
})

describe('seek (absolute, clamped, no wrap)', () => {
  const m = createTimeline(0, 1, 10)
  it('clamps into [0, frameCount-1]', () => {
    expect(seek(m, 5).frame).toBe(5)
    expect(seek(m, -4).frame).toBe(0)
    expect(seek(m, 999).frame).toBe(9)
  })
})

describe('advance (play by dt, looping)', () => {
  it('advances by speed*dt', () => {
    const m = createTimeline(0, 1, 10, { frame: 0, speed: 6 })
    expect(advance(m, 0.5).frame).toBeCloseTo(3, 6) // 6 * 0.5
  })

  it('loops when it runs past the end', () => {
    const m = createTimeline(0, 1, 5, { frame: 4, speed: 2 })
    // 4 + 2*1 = 6 → 6 % 5 = 1
    expect(advance(m, 1).frame).toBeCloseTo(1, 6)
  })

  it('a full-second at speed=frameCount wraps back near start', () => {
    const m = createTimeline(0, 1, 8, { frame: 0, speed: 8 })
    expect(advance(m, 1).frame).toBeCloseTo(0, 6) // 8 % 8 = 0
  })
})

describe('flags + factory', () => {
  it('createTimeline floors frameCount to ≥1 and sets defaults', () => {
    const m = createTimeline(2, 9, 0)
    expect(m.frameCount).toBe(1)
    expect(m.min).toBe(2)
    expect(m.max).toBe(9)
    expect(m.playing).toBe(false)
  })

  it('setPlaying / setSpeed are pure updates', () => {
    const m = createTimeline(0, 1, 4)
    expect(setPlaying(m, true).playing).toBe(true)
    expect(m.playing).toBe(false) // original untouched
    expect(setSpeed(m, 12).speed).toBe(12)
  })

  it('frameLabel renders 1-based index / count + center', () => {
    const opts = { min: 0, max: 10, frameCount: 11, window: 0.2 }
    expect(frameLabel(0, opts)).toBe('1/11 · 1.00')
    expect(frameLabel(5, opts)).toBe('6/11 · 5.00')
  })
})
