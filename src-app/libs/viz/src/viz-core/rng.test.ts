import { describe, it, expect } from 'vitest'
import { mulberry32, seedFromString, defaultCellSeed, cellRng } from './rng'

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })
  it('produces values in [0,1)', () => {
    const r = mulberry32(1)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)())
  })
})

describe('seedFromString / defaultCellSeed', () => {
  it('is stable for the same string', () => {
    expect(seedFromString('cell-a')).toBe(seedFromString('cell-a'))
  })
  it('differs for different strings', () => {
    expect(seedFromString('cell-a')).not.toBe(seedFromString('cell-b'))
  })
  it('returns an unsigned 32-bit int', () => {
    const s = seedFromString('anything')
    expect(Number.isInteger(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(0xffffffff)
  })
  it('defaultCellSeed derives from the id (reproducible by default)', () => {
    expect(defaultCellSeed('cat')).toBe(seedFromString('cat'))
  })
})

describe('cellRng', () => {
  it('two rngs from the same cell id produce the same stream (reproducible figure)', () => {
    const a = cellRng('violin-1')
    const b = cellRng('violin-1')
    expect(a.seed).toBe(b.seed)
    expect([a.rng(), a.rng()]).toEqual([b.rng(), b.rng()])
  })
  it('an override seed wins and is what the manifest records', () => {
    const { seed, rng } = cellRng('violin-1', 7)
    expect(seed).toBe(7)
    expect(rng()).toBe(mulberry32(7)())
  })
})
