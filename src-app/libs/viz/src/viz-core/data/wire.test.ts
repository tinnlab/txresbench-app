import { describe, it, expect } from 'vitest'
import {
  decodePositions,
  decodeSparseColumn,
  decodeCategorical,
  decodeContinuous,
  densify,
} from './wire'

// Encode helpers mirroring the fixture framing, to prove decode round-trips (TEST-1).
function f32buf(vals: number[]): ArrayBuffer {
  return new Float32Array(vals).buffer
}
function sparseBuf(row: number[], value: number[]): ArrayBuffer {
  const n = row.length
  const buf = new ArrayBuffer(4 + n * 4 + n * 4)
  const dv = new DataView(buf)
  dv.setUint32(0, n, true)
  new Uint32Array(buf, 4, n).set(row)
  new Float32Array(buf, 4 + n * 4, n).set(value)
  return buf
}

describe('wire decode (TEST-1)', () => {
  it('decodes interleaved positions', () => {
    const p = decodePositions(f32buf([1, 2, 3, 4, 5, 6]))
    expect(p.length).toBe(3)
    expect(Array.from(p.positions)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('rejects a positions payload not a multiple of 8 bytes', () => {
    expect(() => decodePositions(new Float32Array([1, 2, 3]).buffer)).toThrow()
  })

  it('decodes a sparse CSC column with correct row/value', () => {
    const col = decodeSparseColumn(sparseBuf([2, 5, 9], [1.5, 2.5, 3.5]), 10)
    expect(col.length).toBe(10)
    expect(Array.from(col.row)).toEqual([2, 5, 9])
    expect(Array.from(col.value)).toEqual([1.5, 2.5, 3.5])
  })

  it('densifies a sparse column with 0 default at the right indices', () => {
    const dense = densify(decodeSparseColumn(sparseBuf([1, 3], [7, 9]), 5))
    expect(Array.from(dense)).toEqual([0, 7, 0, 9, 0])
  })

  it('decodes categorical codes with control-plane categories', () => {
    const c = decodeCategorical(new Uint16Array([0, 1, 1, 2]).buffer, ['a', 'b', 'c'])
    expect(c.length).toBe(4)
    expect(Array.from(c.codes)).toEqual([0, 1, 1, 2])
    expect(c.categories).toEqual(['a', 'b', 'c'])
  })

  it('decodes a continuous column', () => {
    const c = decodeContinuous(f32buf([0.1, 0.2, 0.3]))
    expect(c.length).toBe(3)
    expect(c.value[1]).toBeCloseTo(0.2)
  })

  it('throws on a truncated sparse column', () => {
    const buf = new ArrayBuffer(4)
    new DataView(buf).setUint32(0, 5, true) // claims 5 entries, has none
    expect(() => decodeSparseColumn(buf, 10)).toThrow()
  })
})
