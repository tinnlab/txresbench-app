import { describe, it, expect } from 'vitest'
import {
  packLevelToRG,
  coverageByte,
  pickLevel,
  decodePickedCell,
  decodePickTexel,
  MAX_TEXTURE_DIM,
} from './matrixLevelTexture'
import { matrixIndex, type MatrixLevel } from './matrixTypes'

// A tiny 2-row × 3-col level, column-major (values[col*rows+row]), with one EMPTY bin
// (counts === 0) at (row=1, col=1). Hand-laid so the packed bytes are checkable exactly.
//
//   layout (idx = col*rows + row):
//     idx0 = (r0,c0)  idx1 = (r1,c0)
//     idx2 = (r0,c1)  idx3 = (r1,c1) ← EMPTY (count 0)
//     idx4 = (r0,c2)  idx5 = (r1,c2)
function makeTinyLevel(): MatrixLevel {
  const rows = 2
  const cols = 3
  const values = new Uint8Array(rows * cols)
  const counts = new Uint32Array(rows * cols)
  const set = (row: number, col: number, v: number, c: number) => {
    const i = matrixIndex(row, col, rows)
    values[i] = v
    counts[i] = c
  }
  set(0, 0, 10, 1)
  set(1, 0, 20, 2)
  set(0, 1, 30, 5)
  set(1, 1, 40, 0) // EMPTY bin: value present but count 0
  set(0, 2, 50, 300) // count > 255 → saturates
  set(1, 2, 60, 1)
  return { rows, cols, values, counts }
}

describe('coverageByte — G channel = min(counts,255); 0 ⟺ empty', () => {
  it('0 → 0 (empty), saturates at 255, passes small counts through', () => {
    expect(coverageByte(0)).toBe(0)
    expect(coverageByte(1)).toBe(1)
    expect(coverageByte(254)).toBe(254)
    expect(coverageByte(255)).toBe(255)
    expect(coverageByte(300)).toBe(255)
    expect(coverageByte(-5)).toBe(0)
  })
})

describe('packLevelToRG — RG8 value+coverage texture (empty bin ⇒ G=0)', () => {
  it('packs the whole level to exact RG bytes; the empty bin has G=0', () => {
    const level = makeTinyLevel()
    const rg = packLevelToRG(level, 0, 3)
    // width=3, height=2, 2 channels → 12 bytes. Row-major texel order (y outer, x inner):
    //   (x0,y0)=v10/c1  (x1,y0)=v30/c5  (x2,y0)=v50/c255
    //   (x0,y1)=v20/c2  (x1,y1)=v40/c0  (x2,y1)=v60/c1
    expect(Array.from(rg)).toEqual([
      10, 1, 30, 5, 50, 255,
      20, 2, 40, 0, 60, 1,
    ])
    // the EMPTY bin (row1,col1) is texel (x=1,y=1) → offset (1*3+1)*2 = 8; G at +1 = 0.
    expect(rg[8 + 1]).toBe(0)
  })

  it('packs a column sub-window [1,3) → width 2', () => {
    const level = makeTinyLevel()
    const rg = packLevelToRG(level, 1, 3)
    // cols 1,2 only. (x0=col1,y0)=v30/c5  (x1=col2,y0)=v50/c255
    //                (x0=col1,y1)=v40/c0  (x1=col2,y1)=v60/c1
    expect(Array.from(rg)).toEqual([30, 5, 50, 255, 40, 0, 60, 1])
  })

  it('clamps an out-of-bounds range and yields empty for a degenerate one', () => {
    const level = makeTinyLevel()
    expect(packLevelToRG(level, -2, 100).length).toBe(3 * 2 * 2) // clamped to [0,3)
    expect(packLevelToRG(level, 2, 2).length).toBe(0) // empty range
    expect(packLevelToRG(level, 3, 1).length).toBe(0) // inverted → clamped empty
  })
})

describe('pickLevel — ~1 texel per pixel level selection', () => {
  it('matches the hand-worked boundary cases', () => {
    const N = 6 // levelCount → top index 5
    expect(pickLevel(0.5, N)).toBe(0)
    expect(pickLevel(1, N)).toBe(0)
    expect(pickLevel(2, N)).toBe(1)
    expect(pickLevel(4, N)).toBe(2)
    expect(pickLevel(8, N)).toBe(3)
    expect(pickLevel(1_000_000, N)).toBe(5) // huge → clamped to top
  })

  it('rounds at the log2 midpoints and never returns out of range', () => {
    const N = 4
    expect(pickLevel(3, N)).toBe(2) // log2(3)=1.58 → round 2
    expect(pickLevel(2.9, N)).toBe(2) // log2(2.9)=1.54 → round 2
    expect(pickLevel(2.7, N)).toBe(1) // log2(2.7)=1.43 → round 1
    // single-level pyramid clamps everything to 0.
    expect(pickLevel(999, 1)).toBe(0)
  })
})

describe('decodePickedCell — texel → (level,row,col) round-trip', () => {
  it('adds tileColStart to texelX and maps texelY→row', () => {
    expect(decodePickedCell(2, 4, 3, 1)).toEqual({ level: 2, col: 7, row: 1 })
    expect(decodePickedCell(0, 0, 0, 0)).toEqual({ level: 0, col: 0, row: 0 })
    // base level: col === base column.
    expect(decodePickedCell(0, 100, 25, 7)).toEqual({ level: 0, col: 125, row: 7 })
  })
})

describe('MAX_TEXTURE_DIM', () => {
  it('is the 32768 GPU cap', () => {
    expect(MAX_TEXTURE_DIM).toBe(32768)
  })
})

describe('decodePickTexel — linear encode mirrors the shader, correct for rows ≥ 256', () => {
  // Mirror the layer shader's encode: enc = texelY*texWidth + texelX → little-endian 24-bit rgb.
  const encode = (texelX: number, texelY: number, texW: number): number[] => {
    const enc = texelY * texW + texelX
    return [enc & 255, (enc >> 8) & 255, (enc >> 16) & 255]
  }

  it('round-trips texels including rows well past 256 (the old scheme broke here)', () => {
    const texW = 100
    for (const [x, y] of [
      [0, 0],
      [50, 300], // row 300 ≥ 256 — the old `enc % 256` decoded this to row 44
      [99, 511],
      [7, 12345],
    ]) {
      const c = encode(x, y, texW)
      expect(decodePickTexel(c, texW)).toEqual({ texelX: x, texelY: y })
    }
  })

  it('the OLD texelX*256+texelY scheme is what this replaces (demonstration)', () => {
    // Under the old encode, a texel at (col 5, row 300) would pack enc = 5*256 + 300 = 1580,
    // and the old decode `texelY = enc % 256 = 44` mis-reports row 44. The new linear scheme
    // (encode enc = 300*texW + 5) decodes back to row 300 exactly.
    const texW = 100
    expect(decodePickTexel(encode(5, 300, texW), texW)).toEqual({ texelX: 5, texelY: 300 })
  })

  it('guards a zero/degenerate width', () => {
    expect(decodePickTexel([0, 0, 0], 0)).toEqual({ texelX: 0, texelY: 0 })
  })
})
