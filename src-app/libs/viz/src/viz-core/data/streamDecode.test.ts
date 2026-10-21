import { describe, it, expect } from 'vitest'
import {
  decodeSparseColumnStream,
  decodePositionsStream,
  decodeContinuousStream,
  decodeCategoricalStream,
  decodeUint32Stream,
} from './streamDecode'
import { decodeSparseColumn } from './wire'

// TEST-11 (ITEM-9): per-channel stream decode. The fixed-stride channels view the bytes; the sparse-CSC
// value channel is decoded by a byte-level incremental state machine that must be BYTE-IDENTICAL to the
// bulk `decodeSparseColumn` oracle regardless of chunk boundaries.

/** Build a sparse-CSC ArrayBuffer: `u32 n | u32[n] row | f32[n] value`. */
function buildCsc(row: number[], value: number[]): ArrayBuffer {
  const n = row.length
  const buf = new ArrayBuffer(4 + n * 4 + n * 4)
  const dv = new DataView(buf)
  dv.setUint32(0, n, true)
  const r = new Uint32Array(buf, 4, n)
  const v = new Float32Array(buf, 4 + n * 4, n)
  r.set(row)
  v.set(value)
  return buf
}

/** Yield a byte buffer in chunks of the given sizes (to exercise splits mid-element). */
async function* chunked(buf: ArrayBuffer, sizes: number[]): AsyncIterable<Uint8Array> {
  const bytes = new Uint8Array(buf)
  let off = 0
  for (const s of sizes) {
    if (off >= bytes.length) break
    yield bytes.subarray(off, off + s)
    off += s
  }
  if (off < bytes.length) yield bytes.subarray(off)
}

describe('decodeSparseColumnStream — incremental CSC parity vs the bulk oracle', () => {
  const row = [1, 3, 7, 8]
  const value = [4.5, -2, 0.25, 100]
  const N = 20

  it('matches decodeSparseColumn for a one-shot chunk', async () => {
    const buf = buildCsc(row, value)
    const oracle = decodeSparseColumn(buf, N)
    const streamed = await decodeSparseColumnStream(chunked(buf, [buf.byteLength]), N)
    expect(Array.from(streamed.row)).toEqual(Array.from(oracle.row))
    expect(Array.from(streamed.value)).toEqual(Array.from(oracle.value))
    expect(streamed.length).toBe(N)
  })

  it('matches the oracle when chunks split the header / row / value mid-element', async () => {
    const buf = buildCsc(row, value)
    const oracle = decodeSparseColumn(buf, N)
    // pathological boundaries: 1 byte (mid-header), 5 (crosses header→row), 3 (mid-u32), then dribs.
    for (const sizes of [[1], [2, 2], [5, 3, 1, 7], [1, 1, 1, 1, 1, 1, 1, 1], [buf.byteLength - 1]]) {
      const streamed = await decodeSparseColumnStream(chunked(buf, sizes), N)
      expect(Array.from(streamed.row), `sizes=${sizes}`).toEqual(Array.from(oracle.row))
      expect(Array.from(streamed.value), `sizes=${sizes}`).toEqual(Array.from(oracle.value))
    }
  })

  it('an empty column (n=0) round-trips', async () => {
    const buf = buildCsc([], [])
    const streamed = await decodeSparseColumnStream(chunked(buf, [4]), N)
    expect(streamed.row.length).toBe(0)
    expect(streamed.value.length).toBe(0)
    expect(streamed.length).toBe(N)
  })

  it('throws on a truncated stream', async () => {
    const buf = buildCsc(row, value)
    const short = buf.slice(0, buf.byteLength - 3)
    await expect(decodeSparseColumnStream(chunked(short, [4, 4, 4]), N)).rejects.toThrow(/truncated/)
  })

  it('throws on a truncated HEADER (1-3 bytes) — NOT masked as an empty column', async () => {
    // A 2-byte stream is an incomplete u32 header; it must throw, distinct from a genuinely empty
    // (0-byte) stream which yields an empty column. (Regression: the &lt;4-byte case silently returned [].)
    const buf = buildCsc(row, value)
    await expect(decodeSparseColumnStream(chunked(buf.slice(0, 2), [2]), N)).rejects.toThrow(/truncated header/)
    // The 0-byte (genuinely empty) stream still returns an empty column, not a throw.
    const empty = await decodeSparseColumnStream(chunked(new ArrayBuffer(0), []), N)
    expect(empty.row.length).toBe(0)
    expect(empty.length).toBe(N)
  })

  it('throws when the header nnz exceeds the column length (corrupt) — bounds the eager allocation', async () => {
    // n=5 non-zeros declared but the column is only length 3 → impossible (nnz ≤ rows); reject before
    // allocating ~8n from the untrusted header.
    const buf = buildCsc([0, 1, 2, 3, 4], [1, 2, 3, 4, 5])
    await expect(decodeSparseColumnStream(chunked(buf, [buf.byteLength]), 3)).rejects.toThrow(/exceeds column length/)
  })
})

describe('fixed-stride channel decoders', () => {
  async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
    yield bytes
  }

  it('decodePositionsStream f32 → interleaved xy', async () => {
    const xy = Float32Array.from([0, 0, 1, 2, 3, 4])
    const pos = await decodePositionsStream(one(new Uint8Array(xy.buffer)))
    expect(Array.from(pos.positions)).toEqual([0, 0, 1, 2, 3, 4])
    expect(pos.length).toBe(3)
  })

  it('decodePositionsStream packed-u16 identity → codes as coords', async () => {
    const codes = Uint16Array.from([10, 20, 30, 40])
    const pos = await decodePositionsStream(one(new Uint8Array(codes.buffer)), { kind: 'packed-u16', stride: 4 })
    expect(Array.from(pos.positions)).toEqual([10, 20, 30, 40])
  })

  it('decodePositionsStream packed-u16 + packMeta → world coords', async () => {
    const codes = Uint16Array.from([0, 0, 100, 200])
    const pos = await decodePositionsStream(one(new Uint8Array(codes.buffer)), {
      kind: 'packed-u16',
      stride: 4,
      packMeta: { originX: 5, scaleX: 0.1, originY: -3, scaleY: 0.5 },
    })
    // (0,0)->(5,-3); (100,200)->(5+10, -3+100) = (15, 97)
    expect(Array.from(pos.positions)).toEqual([5, -3, 15, 97])
  })

  it('decodeContinuousStream / decodeCategoricalStream / decodeUint32Stream', async () => {
    const cont = await decodeContinuousStream(one(new Uint8Array(Float32Array.from([1.5, 2.5]).buffer)))
    expect(Array.from(cont.value)).toEqual([1.5, 2.5])
    const cat = await decodeCategoricalStream(one(new Uint8Array(Uint16Array.from([0, 1, 0]).buffer)), ['a', 'b'])
    expect(Array.from(cat.codes)).toEqual([0, 1, 0])
    expect(cat.categories).toEqual(['a', 'b'])
    const ids = await decodeUint32Stream(one(new Uint8Array(Uint32Array.from([7, 8, 9]).buffer)))
    expect(Array.from(ids)).toEqual([7, 8, 9])
  })
})
