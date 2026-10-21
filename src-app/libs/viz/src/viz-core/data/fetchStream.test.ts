// fetchStream.test.ts — the pure stream-reframing logic (no network, no DOM beyond the Web
// Streams + fetch types node provides). A known Float32 sequence is split at ADVERSARIAL byte
// boundaries (1 byte at a time, mid-float, mid-row) and must reassemble byte-identically;
// `offset` must accumulate in rows; `rowsPerBatch` coalescing; alignment (asFloat32/asUint16
// never throw); a mocked `fetchImpl` returning a ReadableStream drives streamBinaryColumn
// end-to-end; AbortSignal stops it.

import { describe, it, expect } from 'vitest'
import {
  reframeBytes,
  streamBinaryColumn,
  asFloat32,
  asUint16,
  type ReframedBatch,
} from './fetchStream'
// TEST-19 leg (c): the RIPPLE control. `normalizeVizData` is the `<Viz data={url}>` entry point the
// required-transport change propagates through, so it is exercised here rather than asserted about.
import { normalizeVizData } from '../../adapter/vizData'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build interleaved-xy Float32 bytes for `n` points (STRIDE 8). */
function makeF32Bytes(values: number[]): Uint8Array {
  const f = Float32Array.from(values)
  return new Uint8Array(f.buffer.slice(0)) // fresh, 0-aligned
}

/** An AsyncIterable that yields `src` split at the given cut points (byte lengths). */
function chunkedBy(src: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      let pos = 0
      for (const size of sizes) {
        if (pos >= src.length) break
        yield src.subarray(pos, pos + size)
        pos += size
      }
      if (pos < src.length) yield src.subarray(pos)
    },
  }
}

/** Split into fixed-size chunks of `size` bytes. */
function fixedChunks(src: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  const sizes: number[] = []
  for (let i = 0; i < src.length; i += size) sizes.push(size)
  return chunkedBy(src, sizes)
}

async function collect(it: AsyncIterable<ReframedBatch>): Promise<ReframedBatch[]> {
  const out: ReframedBatch[] = []
  for await (const b of it) out.push(b)
  return out
}

/** Concatenate all batch bytes back into one buffer, and assert offsets are contiguous. */
function reassemble(batches: ReframedBatch[]): Uint8Array {
  let total = 0
  for (const b of batches) total += b.bytes.byteLength
  const out = new Uint8Array(total)
  let pos = 0
  let expectedOffset = 0
  for (const b of batches) {
    expect(b.offset).toBe(expectedOffset)
    expect(b.bytes.byteOffset).toBe(0) // 0-aligned guarantee
    expect(b.bytes.byteLength).toBe(b.rows * 8) // rows * STRIDE
    out.set(b.bytes, pos)
    pos += b.bytes.byteLength
    expectedOffset += b.rows
  }
  return out
}

// A known sequence: 10 rows of 2×Float32 (STRIDE 8) → 80 bytes.
const VALUES = [
  1.5, -2.25, 3.125, 4, -5.5, 6.75, 7, 8.5, -9.0, 10.125, 11, 12.5, 13.25, -14, 15.5, 16,
  17.75, 18, -19.5, 20.0625,
]
const STRIDE = 8
const N_ROWS = VALUES.length / 2 // 10

describe('reframeBytes — adversarial chunk boundaries', () => {
  it('reassembles byte-identically when fed 1 byte at a time', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(fixedChunks(src, 1), { bytesPerRow: STRIDE, rowsPerBatch: 3 }))
    const back = reassemble(batches)
    expect(back).toEqual(src)
    // Values decode identically.
    expect(Array.from(new Float32Array(back.buffer))).toEqual(Array.from(Float32Array.from(VALUES)))
  })

  it('handles mid-float and mid-row boundaries (chunk size 3, coprime with stride 8)', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(fixedChunks(src, 3), { bytesPerRow: STRIDE, rowsPerBatch: 4 }))
    expect(reassemble(batches)).toEqual(src)
  })

  it('handles a single giant chunk (no straddle)', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(chunkedBy(src, [src.length]), { bytesPerRow: STRIDE, rowsPerBatch: 4 }))
    expect(reassemble(batches)).toEqual(src)
  })

  it('handles empty chunks interspersed', async () => {
    const src = makeF32Bytes(VALUES)
    const iter: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(0)
        yield src.subarray(0, 5)
        yield new Uint8Array(0)
        yield src.subarray(5, 22)
        yield new Uint8Array(0)
        yield src.subarray(22)
      },
    }
    const batches = await collect(reframeBytes(iter, { bytesPerRow: STRIDE, rowsPerBatch: 2 }))
    expect(reassemble(batches)).toEqual(src)
  })
})

describe('reframeBytes — offset accumulation + coalescing', () => {
  it('offset accumulates in ROWS across batches', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(fixedChunks(src, 7), { bytesPerRow: STRIDE, rowsPerBatch: 3 }))
    // 10 rows, rowsPerBatch 3 → 3,3,3,1
    expect(batches.map((b) => b.rows)).toEqual([3, 3, 3, 1])
    expect(batches.map((b) => b.offset)).toEqual([0, 3, 6, 9])
    // total rows
    expect(batches.reduce((a, b) => a + b.rows, 0)).toBe(N_ROWS)
  })

  it('coalesces small chunks into rowsPerBatch-sized batches', async () => {
    const src = makeF32Bytes(VALUES)
    // Feed 1-byte chunks but ask for batches of 5 rows → 5,5 exactly.
    const batches = await collect(reframeBytes(fixedChunks(src, 1), { bytesPerRow: STRIDE, rowsPerBatch: 5 }))
    expect(batches.map((b) => b.rows)).toEqual([5, 5])
    expect(batches.map((b) => b.offset)).toEqual([0, 5])
  })

  it('default rowsPerBatch yields a single batch for a small stream', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(fixedChunks(src, 4), { bytesPerRow: STRIDE }))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ offset: 0, rows: N_ROWS })
  })
})

describe('reframeBytes — validation + malformed streams', () => {
  it('throws on a non-whole-row trailing remainder', async () => {
    const src = makeF32Bytes(VALUES).subarray(0, 78) // 78 bytes = 9 rows + 6 trailing bytes
    await expect(collect(reframeBytes(fixedChunks(src, 5), { bytesPerRow: STRIDE }))).rejects.toThrow(
      /malformed stream/,
    )
  })

  it('rejects a bad bytesPerRow', async () => {
    const src = makeF32Bytes(VALUES)
    await expect(collect(reframeBytes(fixedChunks(src, 4), { bytesPerRow: 0 }))).rejects.toThrow(
      /bytesPerRow/,
    )
    await expect(collect(reframeBytes(fixedChunks(src, 4), { bytesPerRow: 3.5 }))).rejects.toThrow(
      /bytesPerRow/,
    )
  })

  it('rejects a bad rowsPerBatch', async () => {
    const src = makeF32Bytes(VALUES)
    await expect(
      collect(reframeBytes(fixedChunks(src, 4), { bytesPerRow: STRIDE, rowsPerBatch: 0 })),
    ).rejects.toThrow(/rowsPerBatch/)
  })

  it('an empty stream yields nothing', async () => {
    const batches = await collect(reframeBytes(chunkedBy(new Uint8Array(0), []), { bytesPerRow: STRIDE }))
    expect(batches).toEqual([])
  })
})

describe('typed-view helpers — alignment never throws', () => {
  it('asFloat32 views the 0-aligned batch across every 1-byte split', async () => {
    const src = makeF32Bytes(VALUES)
    const batches = await collect(reframeBytes(fixedChunks(src, 1), { bytesPerRow: STRIDE, rowsPerBatch: 2 }))
    const decoded: number[] = []
    for (const b of batches) {
      const view = asFloat32(b) // must not throw (byteOffset 0, length divisible by 4)
      decoded.push(...Array.from(view))
    }
    expect(decoded).toEqual(Array.from(Float32Array.from(VALUES)))
  })

  it('asUint16 views a Uint16 (STRIDE 2) stream', async () => {
    const codes = Uint16Array.from([0, 1, 2, 65535, 7, 42])
    const src = new Uint8Array(codes.buffer.slice(0))
    const batches = await collect(reframeBytes(fixedChunks(src, 1), { bytesPerRow: 2, rowsPerBatch: 4 }))
    const decoded: number[] = []
    for (const b of batches) decoded.push(...Array.from(asUint16(b)))
    expect(decoded).toEqual(Array.from(codes))
  })
})

// ── streamBinaryColumn (mocked fetch) ─────────────────────────────────────────

/** A mock fetch whose body is a ReadableStream emitting `src` in `chunkSize`-byte pieces. */
function mockFetch(
  src: Uint8Array,
  opts: { chunkSize?: number; contentLength?: string | null; status?: number } = {},
): typeof fetch {
  const chunkSize = opts.chunkSize ?? 3
  const status = opts.status ?? 200
  const headers = new Headers()
  if (opts.contentLength !== null) {
    headers.set('Content-Length', opts.contentLength ?? String(src.byteLength))
  }
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < src.length; i += chunkSize) {
          if (signal?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'))
            return
          }
          controller.enqueue(src.subarray(i, i + chunkSize))
        }
        controller.close()
      },
    })
    return new Response(body, { status, headers })
  }) as unknown as typeof fetch
}

describe('streamBinaryColumn — end-to-end over a mocked ReadableStream', () => {
  it('drives reframing through a real Response body reader', async () => {
    const src = makeF32Bytes(VALUES)
    let total: { totalBytes: number | null; totalRows: number | null } | undefined
    const batches = await collect(
      streamBinaryColumn('http://x/col', {
        bytesPerRow: STRIDE,
        rowsPerBatch: 3,
        fetchImpl: mockFetch(src, { chunkSize: 3 }),
        onTotal: (t) => {
          total = t
        },
      }),
    )
    expect(reassemble(batches)).toEqual(src)
    expect(total).toEqual({ totalBytes: 80, totalRows: 10 })
  })

  it('surfaces null totals when Content-Length is absent', async () => {
    const src = makeF32Bytes(VALUES)
    let total: { totalBytes: number | null; totalRows: number | null } | undefined
    await collect(
      streamBinaryColumn('http://x/col', {
        bytesPerRow: STRIDE,
        fetchImpl: mockFetch(src, { contentLength: null }),
        onTotal: (t) => {
          total = t
        },
      }),
    )
    expect(total).toEqual({ totalBytes: null, totalRows: null })
  })

  it('throws on a non-ok response', async () => {
    const src = makeF32Bytes(VALUES)
    await expect(
      collect(
        streamBinaryColumn('http://x/col', {
          bytesPerRow: STRIDE,
          fetchImpl: mockFetch(src, { status: 500 }),
        }),
      ),
    ).rejects.toThrow(/HTTP 500/)
  })

  it('stops when the AbortSignal is already aborted', async () => {
    const src = makeF32Bytes(VALUES)
    const ac = new AbortController()
    ac.abort()
    await expect(
      collect(
        streamBinaryColumn('http://x/col', {
          bytesPerRow: STRIDE,
          signal: ac.signal,
          fetchImpl: mockFetch(src),
        }),
      ),
    ).rejects.toThrow(/aborted/i)
  })

  it('stops mid-stream when aborted after the first batch', async () => {
    // A large source so there are many batches; abort after the first is consumed.
    const big = Float32Array.from({ length: 4000 }, (_, i) => i)
    const src = new Uint8Array(big.buffer.slice(0))
    const ac = new AbortController()
    const it = streamBinaryColumn('http://x/col', {
      bytesPerRow: STRIDE,
      rowsPerBatch: 8,
      signal: ac.signal,
      fetchImpl: mockFetch(src, { chunkSize: 16 }),
    })
    const seen: ReframedBatch[] = []
    let threw = false
    try {
      for await (const b of it) {
        seen.push(b)
        ac.abort() // abort right after the first batch
      }
    } catch (e) {
      threw = true
      expect((e as Error).name).toBe('AbortError')
    }
    expect(threw).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // We stopped well before the full 500 rows (4000 f32 / 2 per row).
    expect(seen.reduce((a, b) => a + b.rows, 0)).toBeLessThan(2000)
  })
})

// ── TEST-19 (ITEM-16 / DEC-15 (a)) — the transport is NAMED, never ambient ────────────────────
//
// What this does when the defect is present: with `fetchImpl` optional again, leg (a)'s
// `@ts-expect-error` becomes an UNUSED directive and `tsc` fails the build — which is the point of
// putting the guarantee in the type rather than only in a runtime throw. Leg (c) is the ripple
// control DEC-15 (a) demands: the propagated `<Viz data={url}>` path must still WORK, not merely
// still compile, so it drives real bytes through `normalizeVizData` and compares them.
describe('streamBinaryColumn — the transport is required (TEST-19)', () => {
  it('omitting the transport is a TYPE error, and a runtime throw for a caller that evades the type', async () => {
    const src = makeF32Bytes(VALUES)
    await expect(
      collect(
        // @ts-expect-error — `fetchImpl` is REQUIRED (ITEM-16): an ambient-`fetch` read can only ever
        // be unauthenticated. If this directive ever reports as UNUSED, the requirement was relaxed
        // back to optional and `tsc` — not the runtime — is what says so.
        streamBinaryColumn('http://x/col', { bytesPerRow: STRIDE }),
      ),
    ).rejects.toThrow(/`fetchImpl` is required/)
    // The positive control: named transport, normal stream, unchanged behaviour.
    const batches = await collect(
      streamBinaryColumn('http://x/col', { bytesPerRow: STRIDE, fetchImpl: mockFetch(src) }),
    )
    expect(reassemble(batches)).toEqual(src)
  })

  it('the <Viz data={url}> path still streams when a transport IS named — the ripple control', async () => {
    const src = makeF32Bytes(VALUES)
    const out: number[] = []
    for await (const batch of normalizeVizData('http://x/pos', { fetchImpl: mockFetch(src, { chunkSize: 5 }) })) {
      out.push(...batch.positions)
    }
    // Non-vacuity: bytes really flowed (an empty stream would satisfy "did not throw").
    expect(out.length).toBe(VALUES.length)
    expect(out).toEqual([...VALUES])
  })

  it('the <Viz data={url}> path FAILS LOUD without a transport — the accepted public-API break', async () => {
    await expect(
      (async () => {
        for await (const _ of normalizeVizData('http://x/pos', {})) void _
      })(),
    ).rejects.toThrow(/positions source is a URL .* no `fetchImpl` was supplied/)
    // The forms that need no transport are UNAFFECTED — this is what keeps the break scoped to URLs.
    const inline: number[] = []
    for await (const batch of normalizeVizData(Float32Array.from(VALUES), {})) {
      inline.push(...batch.positions)
    }
    expect(inline).toEqual([...VALUES])
  })

  it('a channel URL needs its own transport too, and says which channel', async () => {
    await expect(
      (async () => {
        for await (const _ of normalizeVizData(
          { positions: Float32Array.from(VALUES), labels: 'http://x/labels' },
          {},
        )) void _
      })(),
    ).rejects.toThrow(/labels source is a URL/)
  })
})
