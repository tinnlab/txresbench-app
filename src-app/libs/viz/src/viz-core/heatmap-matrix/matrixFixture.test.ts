// matrixFixture.test.ts — determinism + shape + structure coverage for the seeded matrix
// fixture. The fixture is the input to the pyramid oracle tests, so "same seed ⇒ identical
// bytes" is load-bearing (a non-deterministic fixture would make the oracle tests flaky).

import { describe, it, expect } from 'vitest'
import { makeMatrixFixture } from './matrixFixture'
import { matrixIndex, VALUE_MIN, VALUE_MAX } from './matrixTypes'

describe('makeMatrixFixture', () => {
  it('produces a column-major MatrixData of the requested shape', () => {
    const m = makeMatrixFixture({ rows: 8, cols: 64, seed: 1 })
    expect(m.rows).toBe(8)
    expect(m.cols).toBe(64)
    expect(m.values).toBeInstanceOf(Uint8Array)
    expect(m.values.length).toBe(8 * 64)
  })

  it('is deterministic: same seed ⇒ byte-identical output', () => {
    const a = makeMatrixFixture({ rows: 8, cols: 64, seed: 42 })
    const b = makeMatrixFixture({ rows: 8, cols: 64, seed: 42 })
    expect(Array.from(a.values)).toEqual(Array.from(b.values))
  })

  it('different seeds ⇒ different bytes', () => {
    const a = makeMatrixFixture({ rows: 8, cols: 64, seed: 1 })
    const b = makeMatrixFixture({ rows: 8, cols: 64, seed: 2 })
    // at least one byte must differ (the seeded jitter decorrelates the two)
    let differs = false
    for (let i = 0; i < a.values.length; i++) {
      if (a.values[i] !== b.values[i]) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })

  it('every value is within the uint8 domain [0,255]', () => {
    const m = makeMatrixFixture({ rows: 6, cols: 50, seed: 3 })
    for (let i = 0; i < m.values.length; i++) {
      expect(m.values[i]).toBeGreaterThanOrEqual(VALUE_MIN)
      expect(m.values[i]).toBeLessThanOrEqual(VALUE_MAX)
    }
  })

  it('has visible BLOCK structure: high bands out-rank low bands on average', () => {
    // With blocks=8 over 64 cols, blockWidth=8; block 0 (cols 0..7) is a HIGH band and
    // block 1 (cols 8..15) is a LOW band. Averaged over rows, the high block must exceed
    // the low block — i.e. the fixture is structured, not uniform noise.
    const m = makeMatrixFixture({ rows: 8, cols: 64, seed: 1, blocks: 8, noise: 0 })
    const colMean = (col: number): number => {
      let s = 0
      for (let r = 0; r < m.rows; r++) s += m.values[matrixIndex(r, col, m.rows)]
      return s / m.rows
    }
    const highBand = (colMean(0) + colMean(4) + colMean(7)) / 3
    const lowBand = (colMean(8) + colMean(12) + colMean(15)) / 3
    expect(highBand).toBeGreaterThan(lowBand)
  })

  it('handles a single column and a single row without dividing by zero', () => {
    const oneCol = makeMatrixFixture({ rows: 4, cols: 1, seed: 1 })
    expect(oneCol.values.length).toBe(4)
    const oneRow = makeMatrixFixture({ rows: 1, cols: 10, seed: 1 })
    expect(oneRow.values.length).toBe(10)
    for (const v of oneRow.values) expect(Number.isFinite(v)).toBe(true)
  })
})
