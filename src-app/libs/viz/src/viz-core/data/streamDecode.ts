// streamDecode.ts — per-channel decode of a `StreamingSource` byte stream into the complete typed
// value a chart/grid consumer needs (Part B, ITEM-9). The RASTER path emits progressive BATCHES via
// `fetchStream.ts::reframeBytes`; the GRID/chart path needs the WHOLE decoded column (to compute
// colors/domains), so these `decode*Stream` helpers consume a channel stream to completion.
//
// Fixed-stride channels (positions f32 / packed-u16, continuous, categorical codes, pointIds,
// tableColumn, image pixels) just collect + view the little-endian bytes. The one non-fixed-stride
// channel — a VALUE column (sparse CSC: `u32 n | u32[n] row | f32[n] value`) — is decoded by a genuine
// byte-level INCREMENTAL state machine (`decodeSparseColumnStream`) that fills the row/value arrays as
// chunks arrive across arbitrary boundaries, byte-identical to the bulk `wire.ts::decodeSparseColumn`.

import type { LayoutEncoding } from './wire'
import type { Positions, SparseColumn, CategoricalColumn, ContinuousColumn } from './wire'
import { collectStream } from './streamingSource'

/** Collect a stream then view it as a `Float32Array` (continuous / tableColumn / dense value). */
export async function decodeFloat32Stream(stream: AsyncIterable<Uint8Array>): Promise<Float32Array> {
  const bytes = await collectStream(stream)
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`decodeFloat32Stream: ${bytes.byteLength} bytes not a multiple of 4`)
  }
  // copy into a fresh 0-aligned buffer so the view is safe regardless of the collected byteOffset.
  return new Float32Array(bytes.slice().buffer)
}

/** Collect a stream then view it as a `Uint16Array` (categorical codes / packed-u16 positions). */
export async function decodeUint16Stream(stream: AsyncIterable<Uint8Array>): Promise<Uint16Array> {
  const bytes = await collectStream(stream)
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`decodeUint16Stream: ${bytes.byteLength} bytes not a multiple of 2`)
  }
  return new Uint16Array(bytes.slice().buffer)
}

/** Collect a stream then view it as a `Uint32Array` (canonical pointIds). */
export async function decodeUint32Stream(stream: AsyncIterable<Uint8Array>): Promise<Uint32Array> {
  const bytes = await collectStream(stream)
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`decodeUint32Stream: ${bytes.byteLength} bytes not a multiple of 4`)
  }
  return new Uint32Array(bytes.slice().buffer)
}

/** Decode a categorical channel stream (u16 codes) + its catalog-supplied category names. */
export async function decodeCategoricalStream(
  stream: AsyncIterable<Uint8Array>,
  categories: readonly string[],
): Promise<CategoricalColumn> {
  const codes = await decodeUint16Stream(stream)
  return { codes, categories, length: codes.length }
}

/** Decode a continuous channel stream (dense f32). */
export async function decodeContinuousStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<ContinuousColumn> {
  const value = await decodeFloat32Stream(stream)
  return { value, length: value.length }
}

/**
 * Decode a positions channel stream honoring the catalog {@link LayoutEncoding} (DEC-10). `f32` yields
 * interleaved xy directly; `packed-u16` yields u16 codes decoded to world coords (identity when no
 * `packMeta`, else `origin + code*scale` per axis — the true-world form).
 */
export async function decodePositionsStream(
  stream: AsyncIterable<Uint8Array>,
  encoding?: LayoutEncoding,
): Promise<Positions> {
  if (!encoding || encoding.kind === 'f32') {
    const positions = await decodeFloat32Stream(stream)
    return { positions, length: positions.length / 2 }
  }
  // packed-u16: codes → world coords.
  const codes = await decodeUint16Stream(stream)
  const positions = new Float32Array(codes.length)
  const pm = encoding.packMeta
  if (!pm) {
    for (let i = 0; i < codes.length; i++) positions[i] = codes[i] // identity code-space
  } else {
    for (let i = 0; i < codes.length; i += 2) {
      positions[i] = pm.originX + codes[i] * pm.scaleX
      positions[i + 1] = pm.originY + codes[i + 1] * pm.scaleY
    }
  }
  return { positions, length: positions.length / 2 }
}

/**
 * Decode a VALUE column (sparse CSC) from a byte stream, INCREMENTALLY. The wire is
 * `u32 n | u32[n] row | f32[n] value` (little-endian). Chunks may split any field at any byte; we
 * place each incoming byte into the header / row-segment / value-segment by ABSOLUTE offset, so the
 * result is byte-identical to the bulk `wire.ts::decodeSparseColumn`. `length` (total N) comes from
 * the catalog `pointCount`.
 */
export async function decodeSparseColumnStream(
  stream: AsyncIterable<Uint8Array>,
  length: number,
): Promise<SparseColumn> {
  const HEADER = 4
  let n = -1
  let rowSeg: Uint8Array | null = null // byte view over the Uint32Array row buffer
  let valSeg: Uint8Array | null = null // byte view over the Float32Array value buffer
  let rowBuf: Uint32Array | null = null
  let valBuf: Float32Array | null = null
  const header = new Uint8Array(HEADER)
  let headerFilled = 0
  let abs = 0 // total bytes consumed across the whole wire

  for await (const chunk of stream) {
    let pos = 0 // read cursor within this chunk
    // 1. header (first 4 bytes → n)
    while (n < 0 && pos < chunk.length) {
      const take = Math.min(HEADER - headerFilled, chunk.length - pos)
      header.set(chunk.subarray(pos, pos + take), headerFilled)
      headerFilled += take
      pos += take
      abs += take
      if (headerFilled === HEADER) {
        n = new DataView(header.buffer).getUint32(0, true)
        // Bound the eager allocation by the column length: a sparse column has at most `length`
        // non-zeros (nnz ≤ rows), so a wire header claiming n > length is corrupt. Guarding here caps
        // the `new Uint32Array(n)`/`new Float32Array(n)` below to the legitimate max, so a malformed/
        // truncated stream declaring a huge n throws cleanly instead of forcing an ~8n OOM.
        if (n > length) {
          throw new Error(`decodeSparseColumnStream: nnz ${n} exceeds column length ${length} (corrupt header)`)
        }
        rowBuf = new Uint32Array(n)
        valBuf = new Float32Array(n)
        rowSeg = new Uint8Array(rowBuf.buffer)
        valSeg = new Uint8Array(valBuf.buffer)
      }
    }
    if (n < 0) continue
    // 2. place the rest of the chunk into the row segment then the value segment, by absolute offset.
    const rowStart = HEADER
    const valStart = HEADER + n * 4
    const end = HEADER + n * 4 * 2
    while (pos < chunk.length && abs < end) {
      if (abs < valStart) {
        // into row segment
        const take = Math.min(valStart - abs, chunk.length - pos)
        rowSeg!.set(chunk.subarray(pos, pos + take), abs - rowStart)
        pos += take
        abs += take
      } else {
        const take = Math.min(end - abs, chunk.length - pos)
        valSeg!.set(chunk.subarray(pos, pos + take), abs - valStart)
        pos += take
        abs += take
      }
    }
  }

  if (n < 0) {
    // Distinguish a genuinely EMPTY stream (0 bytes ⇒ an empty sparse column) from a TRUNCATED header
    // (1–3 bytes arrived but never completed the u32). The bulk `decodeSparseColumn` throws on a
    // <4-byte buffer; masking truncation as "empty" would silently yield an all-zero column with no
    // error (headerFilled counts exactly the header bytes seen, since n<0 means we never left the header).
    if (headerFilled === 0) {
      return { row: new Uint32Array(0), value: new Float32Array(0), length }
    }
    throw new Error(`decodeSparseColumnStream: truncated header — got ${headerFilled} of ${HEADER} header bytes`)
  }
  const expected = HEADER + n * 4 * 2
  if (abs !== expected) {
    throw new Error(`decodeSparseColumnStream: truncated — got ${abs} bytes, need ${expected} for n=${n}`)
  }
  return { row: rowBuf!, value: valBuf!, length }
}
