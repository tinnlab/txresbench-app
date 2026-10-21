// invariants.test.ts — the invariants ARE the battery's assertions, so they get their own
// positive/negative unit tests: each helper passes on a valid input and THROWS on the
// specific violation it guards. Keeps the battery honest — a broken invariant that silently
// never throws would make every property vacuously green.

import { describe, it, expect } from 'vitest'
import {
  assertAllFinite,
  assertNoNaN,
  assertNonNegative,
  assertFiniteRange,
  assertFiniteOrSentinel,
  assertMatrixShape,
  assertPartitionCoversAll,
  assertMonotoneTicks,
  assertByteQuad,
  assertMaskLength,
  assertQuartilesOrdered,
  assertCountsSumTo,
} from './invariants'

describe('assertAllFinite / assertNoNaN', () => {
  it('passes on finite arrays', () => {
    expect(() => assertAllFinite([1, 2, -3.5])).not.toThrow()
  })
  it('rejects NaN and ±Infinity', () => {
    expect(() => assertAllFinite([1, NaN])).toThrow()
    expect(() => assertAllFinite([1, Infinity])).toThrow()
  })
  it('assertNoNaN tolerates Infinity but rejects NaN', () => {
    expect(() => assertNoNaN([1, Infinity])).not.toThrow()
    expect(() => assertNoNaN([1, NaN])).toThrow()
  })
})

describe('assertNonNegative', () => {
  it('passes on ≥0, rejects negatives and NaN', () => {
    expect(() => assertNonNegative([0, 1, 2])).not.toThrow()
    expect(() => assertNonNegative([0, -1])).toThrow()
    expect(() => assertNonNegative([NaN])).toThrow()
  })
})

describe('assertFiniteRange / assertFiniteOrSentinel', () => {
  it('accepts a finite ordered range', () => {
    expect(() => assertFiniteRange([-1, 5])).not.toThrow()
  })
  it('rejects inverted or non-finite ranges', () => {
    expect(() => assertFiniteRange([5, -1])).toThrow()
    expect(() => assertFiniteRange([NaN, 1])).toThrow()
    expect(() => assertFiniteRange([-Infinity, Infinity])).toThrow()
  })
  it('sentinel [0,0] is accepted; other inverted ranges still throw', () => {
    expect(() => assertFiniteOrSentinel([0, 0])).not.toThrow()
    expect(() => assertFiniteOrSentinel([Infinity, -Infinity])).toThrow()
    expect(() => assertFiniteOrSentinel([3, 3], [3, 3])).not.toThrow()
  })
})

describe('assertMatrixShape', () => {
  it('passes when length == rows*cols and labels match', () => {
    expect(() =>
      assertMatrixShape([1, 2, 3, 4, 5, 6], 2, 3, { rowLabels: ['a', 'b'], colLabels: ['x', 'y', 'z'] }),
    ).not.toThrow()
  })
  it('rejects a size mismatch', () => {
    expect(() => assertMatrixShape([1, 2, 3], 2, 3)).toThrow()
  })
  it('rejects drifted labels', () => {
    expect(() => assertMatrixShape([1, 2], 1, 2, { colLabels: ['only-one'] })).toThrow()
  })
})

describe('assertPartitionCoversAll', () => {
  it('passes on a clean partition', () => {
    const codes = [0, 1, 0, 1]
    const facets = [{ indices: [0, 2] }, { indices: [1, 3] }]
    expect(() => assertPartitionCoversAll(facets, codes, 2)).not.toThrow()
  })
  it('excludes out-of-range points (must not be covered)', () => {
    const codes = [0, 5, 1] // index 1 is out of range for nCat=2
    const facets = [{ indices: [0] }, { indices: [2] }]
    expect(() => assertPartitionCoversAll(facets, codes, 2)).not.toThrow()
  })
  it('rejects a dropped in-range index', () => {
    const codes = [0, 1]
    const facets = [{ indices: [0] }, { indices: [] }]
    expect(() => assertPartitionCoversAll(facets, codes, 2)).toThrow()
  })
  it('rejects a double-counted index', () => {
    const codes = [0, 1]
    const facets = [{ indices: [0] }, { indices: [0, 1] }]
    expect(() => assertPartitionCoversAll(facets, codes, 2)).toThrow()
  })
  it('rejects covering an out-of-range index', () => {
    const codes = [0, 9]
    const facets = [{ indices: [0, 1] }]
    expect(() => assertPartitionCoversAll(facets, codes, 1)).toThrow()
  })
})

describe('assertMonotoneTicks', () => {
  it('accepts non-decreasing (and empty / single)', () => {
    expect(() => assertMonotoneTicks([])).not.toThrow()
    expect(() => assertMonotoneTicks([5])).not.toThrow()
    expect(() => assertMonotoneTicks([1, 1, 2, 3])).not.toThrow()
  })
  it('strict rejects equal neighbors', () => {
    expect(() => assertMonotoneTicks([1, 1, 2], { strict: true })).toThrow()
  })
  it('rejects a decrease or a non-finite tick', () => {
    expect(() => assertMonotoneTicks([3, 2])).toThrow()
    expect(() => assertMonotoneTicks([1, NaN, 2])).toThrow()
  })
})

describe('assertByteQuad / assertMaskLength', () => {
  it('accepts a Uint8Array of length n*4', () => {
    expect(() => assertByteQuad(new Uint8Array(12), 3)).not.toThrow()
  })
  it('rejects a wrong length or non-Uint8Array', () => {
    expect(() => assertByteQuad(new Uint8Array(11), 3)).toThrow()
    expect(() => assertByteQuad([0, 0, 0, 0], 1)).toThrow()
  })
  it('assertMaskLength checks the mask length', () => {
    expect(() => assertMaskLength({ length: 5 }, 5)).not.toThrow()
    expect(() => assertMaskLength({ length: 4 }, 5)).toThrow()
  })
})

describe('assertQuartilesOrdered', () => {
  const ok = { q1: 1, median: 2, q3: 3, lowerFence: 0, upperFence: 4, outliers: [5] }
  it('accepts an ordered box', () => {
    expect(() => assertQuartilesOrdered(ok)).not.toThrow()
  })
  it('accepts the degenerate all-zero box', () => {
    expect(() =>
      assertQuartilesOrdered({ q1: 0, median: 0, q3: 0, lowerFence: 0, upperFence: 0, outliers: [] }),
    ).not.toThrow()
  })
  it('rejects an unordered box', () => {
    expect(() => assertQuartilesOrdered({ ...ok, median: 9 })).toThrow()
  })
  it('rejects a NaN summary or NaN outlier', () => {
    expect(() => assertQuartilesOrdered({ ...ok, q3: NaN })).toThrow()
    expect(() => assertQuartilesOrdered({ ...ok, outliers: [NaN] })).toThrow()
  })
})

describe('assertCountsSumTo', () => {
  it('accepts a conserved sum', () => {
    expect(() => assertCountsSumTo([1, 2, 3], 6)).not.toThrow()
  })
  it('rejects a mismatch or a negative count', () => {
    expect(() => assertCountsSumTo([1, 2], 6)).toThrow()
    expect(() => assertCountsSumTo([-1, 7], 6)).toThrow()
  })
})
