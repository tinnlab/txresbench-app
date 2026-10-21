import { describe, it, expect } from 'vitest'
import { affineToModelMatrix } from './affineMatrix'
import { applyAffine, composeAffine, IDENTITY_AFFINE, scaleAffine, type Affine } from './image'

// Apply a flat COLUMN-MAJOR 4×4 matrix to a homogeneous point (x, y, 0, 1) and
// return the transformed (x', y'). This is the exact operation deck.gl performs
// per-vertex on the GPU, so if it agrees with `applyAffine` the modelMatrix is the
// GPU parity of the CPU `transformPositions` pass it replaces.
function applyMat4(m: number[], x: number, y: number): [number, number] {
  const z = 0
  const w = 1
  const xp = m[0] * x + m[4] * y + m[8] * z + m[12] * w
  const yp = m[1] * x + m[5] * y + m[9] * z + m[13] * w
  return [xp, yp]
}

const AFFINES: Record<string, Affine> = {
  identity: IDENTITY_AFFINE,
  scale: scaleAffine(2.5),
  rotateScale: composeAffine({ scale: 1.7, rotation: 0.6, translate: [12, -4] }),
  general: [0.8, -0.3, 40, 0.2, 1.1, -15],
}

const POINTS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [3.5, -2.25],
  [-7, 9],
  [123.4, -56.7],
]

describe('affineToModelMatrix (TASK 1 — GPU spatial transform)', () => {
  it('produces a 16-element column-major matrix', () => {
    const m = affineToModelMatrix(AFFINES.general)
    expect(m).toHaveLength(16)
    // third row/column is the untouched-z identity, w-column carries the translation
    expect(m.slice(8, 12)).toEqual([0, 0, 1, 0])
    expect([m[12], m[13], m[14], m[15]]).toEqual([40, -15, 0, 1])
  })

  it('maps every point identically to applyAffine (GPU == CPU oracle)', () => {
    for (const [name, a] of Object.entries(AFFINES)) {
      const m = affineToModelMatrix(a)
      for (const [x, y] of POINTS) {
        const cpu = applyAffine(a, x, y)
        const gpu = applyMat4(m, x, y)
        expect(gpu[0], `${name} x @(${x},${y})`).toBeCloseTo(cpu[0], 10)
        expect(gpu[1], `${name} y @(${x},${y})`).toBeCloseTo(cpu[1], 10)
      }
    }
  })

  it('the identity affine yields the identity matrix', () => {
    expect(affineToModelMatrix(IDENTITY_AFFINE)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ])
  })
})
