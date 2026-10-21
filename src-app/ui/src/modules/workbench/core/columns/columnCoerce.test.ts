import { describe, expect, it } from 'vitest'
import { asNumsNaNMissing, asNumsZeroMissing, asStrs, isColumn } from './columnCoerce'

// TEST-30 [ITEM-25] — ONE shared coercer module, with the SEMANTIC FORK preserved and named.
//
// The plan called the three copies "verbatim". They were not: `store.ts` mapped a missing entry to
// NaN (documented: "rather than silently skewing them to 0") while the two canvas copies used a bare
// `Number(x)`, which is 0 for null/''/false. Collapsing to one implementation would have moved a
// colour-scale domain or a fabricated coordinate as a side effect of tidying a helper. So the fork
// survives as two named exports, and this file pins BOTH — including the property that they DISAGREE,
// so a later "cleanup" that quietly converges them turns this red.

describe('columnCoerce — the single shared coercer (ITEM-25)', () => {
  describe('asNumsNaNMissing — the careful semantics (was store.ts)', () => {
    it('maps a MISSING entry to NaN, never to 0', () => {
      // The whole documented point: a blank entry must be dropped by extent/keep_range as
      // non-finite, not counted as a real zero that drags a domain or passes a `min: 0` filter.
      expect(asNumsNaNMissing([1, null, 2])).toEqual([1, NaN, 2])
      expect(asNumsNaNMissing([''])).toEqual([NaN])
      expect(asNumsNaNMissing(['   '])).toEqual([NaN])
      expect(asNumsNaNMissing([false])).toEqual([NaN])
      expect(asNumsNaNMissing([undefined])).toEqual([NaN])
    })

    it('parses a numeric STRING, because a column can arrive stringly-typed', () => {
      expect(asNumsNaNMissing(['1.5', '2'])).toEqual([1.5, 2])
    })

    it('preserves the NaN contract on a TYPED array input (the migration case)', () => {
      // A Uint32Array has no NaN and no null: every slot is a real number. The contract this
      // preserves is that nothing INVENTS a missing value, and nothing erases one either.
      expect(asNumsNaNMissing(new Uint32Array([0, 5]))).toEqual([0, 5])
      expect(asNumsNaNMissing(new Float32Array([1.5, NaN]))).toEqual([1.5, NaN])
    })
  })

  describe('asNumsZeroMissing — the loose semantics (was the two canvas copies)', () => {
    it('maps a MISSING entry to 0, verbatim as the canvas had it', () => {
      expect(asNumsZeroMissing([1, null, 2])).toEqual([1, 0, 2])
      expect(asNumsZeroMissing([''])).toEqual([0])
      expect(asNumsZeroMissing([false])).toEqual([0])
    })
  })

  it('THE FORK IS REAL — the two disagree on a missing entry, and that is load-bearing', () => {
    // This is the assertion that stops a future "collapse the duplicates" pass from silently
    // converging them. If they ever agree, either a colour domain or a fabricated coordinate has
    // moved, and that must be a deliberate, separately-tested change.
    const missing = [null]
    expect(asNumsZeroMissing(missing)).toEqual([0])
    expect(asNumsNaNMissing(missing)).toEqual([NaN])
    expect(asNumsZeroMissing(missing)).not.toEqual(asNumsNaNMissing(missing))
  })

  describe('isColumn — the successor to the fail-open Array.isArray guards', () => {
    it('accepts a plain array AND a typed array', () => {
      expect(isColumn([1, 2])).toBe(true)
      expect(isColumn([])).toBe(true)
      // The whole reason the predicate exists: this is FALSE under Array.isArray, and every
      // guard in the tree fails OPEN, so an unconverted guard drops the column silently.
      expect(Array.isArray(new Float32Array([1]))).toBe(false)
      expect(isColumn(new Float32Array([1]))).toBe(true)
      expect(isColumn(new Uint16Array([1]))).toBe(true)
      expect(isColumn(new Uint32Array([1]))).toBe(true)
    })

    it('rejects the non-columns the old guards rejected', () => {
      expect(isColumn(null)).toBe(false)
      expect(isColumn(undefined)).toBe(false)
      expect(isColumn({ length: 2 })).toBe(false)
      expect(isColumn('ab')).toBe(false)
      expect(isColumn(3)).toBe(false)
    })
  })

  describe('coercing a non-column', () => {
    it('yields [] rather than throwing — the fail-open behaviour every call site relies on', () => {
      expect(asNumsNaNMissing(null)).toEqual([])
      expect(asNumsZeroMissing(undefined)).toEqual([])
      expect(asStrs({})).toEqual([])
    })
  })

  // NOTE: the "each call site kept its semantics" leg lives in the CANVAS extension's own test
  // file, not here. It needs the canvas source class, and a core module must not reach into an
  // extension — the layer + domain lints refuse it, correctly. The assertion is the same; it just
  // belongs on the consumer's side of the boundary.

  describe('asStrs — identical in all three copies, so there is only one', () => {
    it('stringifies, including a typed array', () => {
      expect(asStrs([1, null, 'a'])).toEqual(['1', 'null', 'a'])
      expect(asStrs(new Uint16Array([1, 2]))).toEqual(['1', '2'])
    })
  })
})
