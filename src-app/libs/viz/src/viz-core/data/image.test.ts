// image.test.ts — the cell↔image affine model (ITEM-10). Focused coverage of `invertAffine`'s
// scale-invariant singularity test (audit finding 6): a well-conditioned but small-magnitude
// affine (e.g. an isotropic 1e-7 micron→pixel scale) must invert; a genuinely rank-deficient
// affine must be rejected.

import { describe, it, expect } from 'vitest'
import {
  applyAffine,
  composeAffine,
  invertAffine,
  scaleAffine,
  type Affine,
} from './image'

/** Compose two affines (a after b): the linear parts multiply, translation maps through. */
function compose(a: Affine, b: Affine): Affine {
  const [a0, a1, a2, a3, a4, a5] = a
  const [b0, b1, b2, b3, b4, b5] = b
  return [
    a0 * b0 + a1 * b3,
    a0 * b1 + a1 * b4,
    a0 * b2 + a1 * b5 + a2,
    a3 * b0 + a4 * b3,
    a3 * b1 + a4 * b4,
    a3 * b2 + a4 * b5 + a5,
  ]
}

function expectClose(a: Affine, b: Affine, eps = 1e-6): void {
  for (let i = 0; i < 6; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
}

describe('invertAffine — scale-invariant singularity test (finding 6)', () => {
  it('inverts a general well-conditioned affine (inverse ∘ forward = identity)', () => {
    const a: Affine = [0.8, -0.3, 40, 0.2, 1.1, -15]
    const inv = invertAffine(a)
    // round-trip a point
    const [x, y] = applyAffine(a, 12.5, -7.25)
    const [rx, ry] = applyAffine(inv, x, y)
    expect(Math.abs(rx - 12.5)).toBeLessThan(1e-9)
    expect(Math.abs(ry - -7.25)).toBeLessThan(1e-9)
    // inv ∘ a == identity affine
    expectClose(compose(inv, a), [1, 0, 0, 0, 1, 0])
  })

  it('inverts an ISOTROPIC 1e-7 scale (det≈1e-14) — NOT falsely rejected as singular', () => {
    // The old absolute floor `|det| < 1e-12` rejected this well-conditioned matrix (det = 1e-14).
    const s = 1e-7
    const a = scaleAffine(s)
    expect(() => invertAffine(a)).not.toThrow()
    const inv = invertAffine(a)
    // inverse of a scale-by-s is a scale-by-1/s
    expectClose(inv, scaleAffine(1 / s), 1e-3 * (1 / s)) // relative tolerance for the large 1e7 entries
    // round-trips a point through both directions
    const [px, py] = applyAffine(a, 3, 4) // (3e-7, 4e-7)
    const [bx, by] = applyAffine(inv, px, py)
    expect(Math.abs(bx - 3)).toBeLessThan(1e-6)
    expect(Math.abs(by - 4)).toBeLessThan(1e-6)
  })

  it('inverts a small-scale rotation+translation (small magnitude, well-conditioned)', () => {
    const a = composeAffine({ scale: 5e-6, rotation: 0.7, translate: [1e-5, -2e-5] })
    expect(() => invertAffine(a)).not.toThrow()
    expectClose(compose(invertAffine(a), a), [1, 0, 0, 0, 1, 0], 1e-4)
  })

  it('rejects a genuinely singular (rank-deficient) affine regardless of magnitude', () => {
    // rows proportional ⇒ det = 0 exactly
    expect(() => invertAffine([1, 2, 0, 2, 4, 0])).toThrow(/singular/)
    // a zero linear part
    expect(() => invertAffine([0, 0, 5, 0, 0, 5])).toThrow(/singular/)
    // near-singular relative to its own scale (rows nearly proportional at large magnitude)
    expect(() => invertAffine([1e6, 2e6, 3, 1e6 + 1e-9, 2e6, 4])).toThrow(/singular/)
  })

  it('rejects a non-finite affine', () => {
    expect(() => invertAffine([Number.NaN, 0, 0, 0, 1, 0])).toThrow(/singular/)
    expect(() => invertAffine([Number.POSITIVE_INFINITY, 0, 0, 0, 1, 0])).toThrow(/singular/)
  })
})
