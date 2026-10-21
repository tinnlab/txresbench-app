import { describe, it, expect } from 'vitest'
import { DensityAccumulator } from './accumulator'
import { binAndShade } from './cpuRaster'
import { binDensity, binDensityPacked, type DensityBounds } from './densityBin'
import { packPositions } from './quantize'

// STREAMING_PROGRESSIVE_PLAN Wave 2a — the progressive accumulator. The HARD guarantee: feeding a
// cloud in ANY chunking and then shading (final, no EMA) is BYTE-IDENTICAL to a one-shot
// `binAndShade` of the concatenation. Proven here as pure logic (no Worker needed).

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

// A deterministic pseudo-random cloud across the unit square.
function makeCloud(n: number, seed = 7): Float32Array {
  const xy = new Float32Array(n * 2)
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  for (let i = 0; i < n; i++) {
    xy[i * 2] = rnd()
    xy[i * 2 + 1] = rnd()
  }
  return xy
}

function splitIntoChunks(xy: Float32Array, chunkPoints: number): Float32Array[] {
  const chunks: Float32Array[] = []
  for (let o = 0; o < xy.length; o += chunkPoints * 2) chunks.push(xy.slice(o, o + chunkPoints * 2))
  return chunks
}

describe('DensityAccumulator — additive count grid', () => {
  it('accumulated counts equal binDensity of the concatenation, regardless of chunking', () => {
    const xy = makeCloud(5000)
    const W = 24
    const H = 18
    const acc = new DensityAccumulator({ bounds: UNIT, width: W, height: H })
    for (const chunk of splitIntoChunks(xy, 137)) acc.append(chunk)
    const oracle = binDensity(xy, null, UNIT, W, H)
    expect(Array.from(acc.counts())).toEqual(Array.from(oracle.count))
    expect(acc.rows).toBe(5000)
  })

  it('progressive final shade is BYTE-IDENTICAL to a one-shot binAndShade of the whole array', () => {
    const xy = makeCloud(8000, 42)
    const W = 40
    const H = 30
    const acc = new DensityAccumulator({ bounds: UNIT, width: W, height: H })
    for (const chunk of splitIntoChunks(xy, 251)) acc.append(chunk)
    const finalFrame = acc.shade({ normalize: 'log', final: true, ema: 0.5 /* ignored on final */ })
    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: W, height: H, normalize: 'log' })
    expect(finalFrame.width).toBe(oneShot.width)
    expect(finalFrame.height).toBe(oneShot.height)
    expect(Array.from(finalFrame.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('the FIRST partial shade (no prior frame) is exact — a whole-array input renders instantly', () => {
    const xy = makeCloud(3000, 5)
    const W = 20
    const H = 20
    const acc = new DensityAccumulator({ bounds: UNIT, width: W, height: H })
    acc.append(xy) // one batch = the whole array
    const partial = acc.shade({ normalize: 'linear', ema: 0.5 }) // ema ignored: no previous frame
    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: W, height: H, normalize: 'linear' })
    expect(Array.from(partial.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('EMA partial frames differ from exact, then the terminal frame converges to exact', () => {
    const xy = makeCloud(6000, 9)
    const W = 32
    const H = 32
    const acc = new DensityAccumulator({ bounds: UNIT, width: W, height: H })
    const chunks = splitIntoChunks(xy, 500)
    let midFrame = acc.shade({ normalize: 'log' }) // empty so far
    for (const c of chunks) {
      acc.append(c)
      midFrame = acc.shade({ normalize: 'log', ema: 0.6 }) // blended toward the previous frame
    }
    const finalFrame = acc.shade({ normalize: 'log', final: true })
    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: W, height: H, normalize: 'log' })
    // A blended mid frame need not equal exact; the terminal frame MUST.
    expect(Array.from(finalFrame.rgba)).toEqual(Array.from(oneShot.rgba))
    // sanity: EMA actually damped (some channel differs from exact on the blended frame)
    expect(Array.from(midFrame.rgba)).not.toEqual(Array.from(oneShot.rgba))
  })

  it('appendPacked accumulates byte-identically to the binDensityPacked oracle', () => {
    const xy = makeCloud(4000, 3)
    const W = 16
    const H = 16
    const packed = packPositions(xy)
    const accP = new DensityAccumulator({ bounds: UNIT, width: W, height: H })
    accP.appendPacked(packed.packed, packed)
    const oracleP = binDensityPacked(packed.packed, packed, null, UNIT, W, H)
    expect(Array.from(accP.counts())).toEqual(Array.from(oracleP.count))
  })
})
