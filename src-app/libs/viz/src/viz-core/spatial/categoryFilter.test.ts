// categoryFilter.test.ts — correctness proof for the pure per-category filter
// policy. Covers: per-point mask correctness (known set), the empty / all-visible
// contracts, the "toggle one category changes ONLY that category's points" invariant,
// the top-k default selection, the uniform-path visible list, and the count readout.

import { describe, it, expect } from 'vitest'
import {
  MAX_UNIFORM_CATEGORIES,
  filterModeForCategoryCount,
  visibleCategoryList,
  categoryVisibilityMask,
  countByCategory,
  topCategoriesByCount,
  visibleCount,
} from './categoryFilter'

// A small known set: 8 points across 3 categories.
//   index: 0 1 2 3 4 5 6 7
//   code:  0 1 2 0 1 0 2 1
const CODES = new Uint16Array([0, 1, 2, 0, 1, 0, 2, 1])
//   counts: code 0 → 3 (ids 0,3,5); code 1 → 3 (ids 1,4,7); code 2 → 2 (ids 2,6)

describe('categoryVisibilityMask — known set', () => {
  it('marks exactly the points whose code is visible', () => {
    const mask = categoryVisibilityMask(CODES, new Set([0, 2]))
    // visible codes {0,2} → ids 0,2,3,5,6 = 1; ids 1,4,7 (code 1) = 0
    expect(Array.from(mask)).toEqual([1, 0, 1, 1, 0, 1, 1, 0])
  })

  it('empty visible set → all zero', () => {
    const mask = categoryVisibilityMask(CODES, new Set())
    expect(Array.from(mask)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('all categories visible → all one', () => {
    const mask = categoryVisibilityMask(CODES, new Set([0, 1, 2]))
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('is a Uint8Array of length n (default = codes length)', () => {
    const mask = categoryVisibilityMask(CODES, new Set([1]))
    expect(mask).toBeInstanceOf(Uint8Array)
    expect(mask.length).toBe(CODES.length)
    expect(Array.from(mask)).toEqual([0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('honors an explicit n: extra tail entries stay 0, a short n truncates', () => {
    const longer = categoryVisibilityMask(CODES, new Set([0, 1, 2]), 10)
    expect(longer.length).toBe(10)
    expect(Array.from(longer.subarray(8))).toEqual([0, 0]) // tail beyond codes → 0
    const shorter = categoryVisibilityMask(CODES, new Set([0, 1, 2]), 4)
    expect(Array.from(shorter)).toEqual([1, 1, 1, 1])
  })
})

describe('toggling one category changes ONLY that category’s points', () => {
  it('hiding a single category flips exactly that category’s mask bits', () => {
    const all = new Set([0, 1, 2])
    const before = categoryVisibilityMask(CODES, all)
    const afterHide1 = categoryVisibilityMask(CODES, new Set([0, 2])) // hide code 1
    for (let i = 0; i < CODES.length; i++) {
      if (CODES[i] === 1) {
        // code-1 points went 1 → 0
        expect(before[i]).toBe(1)
        expect(afterHide1[i]).toBe(0)
      } else {
        // every OTHER point is unchanged
        expect(afterHide1[i]).toBe(before[i])
      }
    }
  })

  it('the uniform-path visible list drops only the toggled category', () => {
    expect(visibleCategoryList(new Set([0, 1, 2]))).toEqual([0, 1, 2])
    expect(visibleCategoryList(new Set([0, 2]))).toEqual([0, 2]) // hid 1
    // sorted ascending regardless of insertion order (deterministic uniform input)
    expect(visibleCategoryList(new Set([2, 0, 1]))).toEqual([0, 1, 2])
    expect(visibleCategoryList(new Set())).toEqual([])
  })
})

describe('countByCategory', () => {
  it('counts occurrences per code (explicit categoryCount)', () => {
    expect(Array.from(countByCategory(CODES, 3))).toEqual([3, 3, 2])
  })

  it('derives the length from max(code)+1 when categoryCount is omitted', () => {
    const counts = countByCategory(CODES)
    expect(counts.length).toBe(3)
    expect(Array.from(counts)).toEqual([3, 3, 2])
  })

  it('ignores codes at/beyond an under-sized categoryCount (no overflow)', () => {
    expect(Array.from(countByCategory(CODES, 2))).toEqual([3, 3]) // code 2 dropped
  })

  it('empty input → empty counts', () => {
    expect(Array.from(countByCategory(new Uint16Array(0)))).toEqual([])
  })
})

describe('topCategoriesByCount', () => {
  it('returns the k most frequent codes, ties broken by ascending code', () => {
    // counts: 0→3, 1→3, 2→2 ⇒ order [0,1,2] (0 and 1 tie at 3 → lower code first)
    expect(topCategoriesByCount(CODES, 2)).toEqual([0, 1])
    expect(topCategoriesByCount(CODES, 1)).toEqual([0])
    expect(topCategoriesByCount(CODES, 3)).toEqual([0, 1, 2])
  })

  it('a clear frequency winner sorts first', () => {
    // code 5 appears 4×, code 2 twice, code 9 once
    const codes = new Uint16Array([5, 2, 5, 9, 5, 2, 5])
    expect(topCategoriesByCount(codes, 2)).toEqual([5, 2])
    expect(topCategoriesByCount(codes, 10)).toEqual([5, 2, 9]) // k > distinct → all present
  })

  it('k <= 0 → empty; only PRESENT categories are returned', () => {
    expect(topCategoriesByCount(CODES, 0)).toEqual([])
    expect(topCategoriesByCount(CODES, -3)).toEqual([])
    // categoryCount 5 but codes 3,4 absent → never listed
    expect(topCategoriesByCount(CODES, 10, 5)).toEqual([0, 1, 2])
  })
})

describe('visibleCount readout', () => {
  it('sums the per-category counts of the visible set', () => {
    const counts = countByCategory(CODES, 3)
    expect(visibleCount(counts, new Set([0, 1, 2]))).toBe(8)
    expect(visibleCount(counts, new Set([0, 2]))).toBe(5) // 3 + 2
    expect(visibleCount(counts, new Set([1]))).toBe(3)
    expect(visibleCount(counts, new Set())).toBe(0)
  })

  it('ignores out-of-range codes in the visible set', () => {
    const counts = countByCategory(CODES, 3)
    expect(visibleCount(counts, new Set([0, 99]))).toBe(3)
  })
})

describe('filterModeForCategoryCount', () => {
  it('uses the uniform category path up to and including 128 categories', () => {
    expect(MAX_UNIFORM_CATEGORIES).toBe(128)
    expect(filterModeForCategoryCount(1)).toBe('category')
    expect(filterModeForCategoryCount(30)).toBe('category')
    expect(filterModeForCategoryCount(128)).toBe('category')
  })

  it('falls back to the per-point mask above 128 categories', () => {
    expect(filterModeForCategoryCount(129)).toBe('mask')
    expect(filterModeForCategoryCount(1000)).toBe('mask')
  })
})
