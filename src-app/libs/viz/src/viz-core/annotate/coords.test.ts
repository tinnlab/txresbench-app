// coords.test.ts — TEST-A4 acceptance for the ImageCoordinateSystem facade (ITEM-14):
//   • inverse identity for a rotation+shear affine (invertAffine ∘ a ≈ I within eps),
//   • zoom-stable registration (a full-res point → the SAME physical point via every
//     level; a vertex authored at level 2, read at level 0, lands on the same feature),
//   • parity with the CPU `transformPositions` oracle (the folded facade affine == the
//     oracle-applied affine, per point).

import { describe, it, expect } from 'vitest'
import { createImageCoordinateSystem, type CoordSpace } from './coords'
import {
  type Affine,
  IDENTITY_AFFINE,
  applyAffine,
  invertAffine,
  transformPositions,
  composeAffine,
} from '../data/image'
import { composeAffine2, type NormalizedImageMeta } from '../spatial/imageMeta'

const EPS = 1e-9

function expectAffineClose(a: Affine, b: Affine, eps = EPS): void {
  for (let i = 0; i < 6; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
}
function expectPointClose(a: readonly [number, number], b: readonly [number, number], eps = 1e-6): void {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps)
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps)
}

// A 3-level pyramid: full-res 1000×800 at 0.5 µm/px offset (10,20); levels 2× / 4× down,
// SAME physical origin (shared micron space). downsample 1 / 2 / 4.
const META: NormalizedImageMeta = {
  levels: [
    { path: '0', width: 1000, height: 800, scale: [0.5, 0.5], translation: [10, 20], downsample: 1 },
    { path: '1', width: 500, height: 400, scale: [1.0, 1.0], translation: [10, 20], downsample: 2 },
    { path: '2', width: 250, height: 200, scale: [2.0, 2.0], translation: [10, 20], downsample: 4 },
  ],
  channels: [{ name: 'C0' }],
  dtype: 'Uint16',
  axisIndex: { y: 0, x: 1 },
}

describe('ImageCoordinateSystem — inverse identity (TEST-A4)', () => {
  it('invertAffine ∘ a ≈ I for a rotation+shear (non-diagonal) affine', () => {
    // A genuine rotation+shear (RFC-5 style) — NOT a naive diagonal scale.
    const a: Affine = [1.2, 0.3, 5, -0.4, 0.9, -7]
    expectAffineClose(composeAffine2(invertAffine(a), a), IDENTITY_AFFINE)
    expectAffineClose(composeAffine2(a, invertAffine(a)), IDENTITY_AFFINE)
  })

  it('facade physical↔fullRes is a mutual inverse (round-trips a point exactly)', () => {
    const cs = createImageCoordinateSystem(META)
    const p: [number, number] = [321.5, 654.25]
    const phys = cs.map(p, 'fullRes', 'physical')
    // 0.5·x + 10 ; 0.5·y + 20
    expectPointClose(phys, [0.5 * 321.5 + 10, 0.5 * 654.25 + 20])
    expectPointClose(cs.map(phys, 'physical', 'fullRes'), p)
  })
})

describe('ImageCoordinateSystem — zoom-stable registration (TEST-A4)', () => {
  it('a full-res point maps to the same physical point via every level', () => {
    const cs = createImageCoordinateSystem(META)
    const full: [number, number] = [400, 320]
    const physDirect = cs.map(full, 'fullRes', 'physical')
    for (const level of [0, 1, 2]) {
      const atLevel = cs.map(full, 'fullRes', { level })
      const physViaLevel = cs.map(atLevel, { level }, 'physical')
      expectPointClose(physViaLevel, physDirect)
    }
    // level-1 pixel = full/2, level-2 pixel = full/4 (shared origin ⇒ pure downsample).
    expectPointClose(cs.map(full, 'fullRes', { level: 1 }), [200, 160])
    expectPointClose(cs.map(full, 'fullRes', { level: 2 }), [100, 80])
  })

  it('a vertex authored at level 2, read at level 0, lands on the same feature', () => {
    const cs = createImageCoordinateSystem(META)
    const atL2: [number, number] = [60, 45] // authored in level-2 pixels
    const atL0 = cs.map(atL2, { level: 2 }, 'fullRes')
    // same physical feature whether measured from its level-2 or its level-0 coords
    expectPointClose(cs.map(atL2, { level: 2 }, 'physical'), cs.map(atL0, 'fullRes', 'physical'))
    expectPointClose(atL0, [240, 180]) // 60·4, 45·4
    // and reading it back down to level 2 returns the authored vertex
    expectPointClose(cs.map(atL0, 'fullRes', { level: 2 }), atL2)
  })
})

describe('ImageCoordinateSystem — CPU transformPositions oracle parity (TEST-A4)', () => {
  it('the folded facade affine matches applyAffine/transformPositions per point', () => {
    const cs = createImageCoordinateSystem(META)
    const pairs: Array<[CoordSpace, CoordSpace]> = [
      ['fullRes', { level: 2 }],
      [{ level: 2 }, 'fullRes'],
      ['fullRes', 'physical'],
      [{ level: 1 }, { level: 2 }],
    ]
    const positions = new Float32Array([0, 0, 400, 320, 999, 799, 123.5, 456.5])
    for (const [from, to] of pairs) {
      const aff = cs.affineBetween(from, to)
      // single-point map == applyAffine of the folded affine
      for (let i = 0; i < positions.length; i += 2) {
        const [x, y] = cs.map([positions[i], positions[i + 1]], from, to)
        const [ox, oy] = applyAffine(aff, positions[i], positions[i + 1])
        expect(Math.abs(x - ox)).toBeLessThan(1e-9)
        expect(Math.abs(y - oy)).toBeLessThan(1e-9)
      }
      // buffer map == CPU transformPositions oracle, byte-for-byte
      const viaFacade = cs.mapPositions(positions, from, to)
      const viaOracle = transformPositions(positions, aff)
      expect(Array.from(viaFacade)).toEqual(Array.from(viaOracle))
    }
  })
})

describe('ImageCoordinateSystem — world space via elementAffine (TEST-A4)', () => {
  it("'world' folds the element registration over the pixel→physical scale", () => {
    const elementAffine = composeAffine({ scale: 2, translate: [100, 50] })
    const cs = createImageCoordinateSystem(META, { elementAffine })
    const p: [number, number] = [321.5, 654.25]
    // reference: world = elementAffine ∘ pixelSize
    const pixToPhys: Affine = [0.5, 0, 10, 0, 0.5, 20]
    const fullToWorld = composeAffine2(elementAffine, pixToPhys)
    expectPointClose(cs.map(p, 'fullRes', 'world'), applyAffine(fullToWorld, p[0], p[1]))
    // world↔fullRes mutual inverse
    expectPointClose(cs.map(cs.map(p, 'fullRes', 'world'), 'world', 'fullRes'), p)
  })

  it("with identity elementAffine 'world' ≡ 'physical'", () => {
    const cs = createImageCoordinateSystem(META)
    const p: [number, number] = [12.5, 34.75]
    expectPointClose(cs.map(p, 'fullRes', 'world'), cs.map(p, 'fullRes', 'physical'))
  })

  it('an out-of-range pyramid level throws', () => {
    const cs = createImageCoordinateSystem(META)
    expect(() => cs.map([0, 0], 'fullRes', { level: 9 })).toThrow(/no pyramid level/)
  })
})
