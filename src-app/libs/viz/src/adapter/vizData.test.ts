import { describe, it, expect } from 'vitest'
import { normalizeVizData, type NormalizedBatch, type VizData } from './vizData'

// STREAMING_PROGRESSIVE_PLAN Wave 2a — the friendly `data` normalizer. These node tests prove the
// SAME uniform batch stream comes out of a `Float32Array`, a `ReadableStream`, an `AsyncIterable`,
// the packed object form, and a (mocked) URL — the whole point of the no-boilerplate API.

/** Little-endian bytes of a Float32Array (a fresh copy so `buffer` is 0-aligned). */
function f32Bytes(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.slice().buffer)
}

/** Split bytes into arbitrary-boundary chunks (exercises the carry-buffer reassembly). */
function chunkize(bytes: Uint8Array, chunkBytes: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let o = 0; o < bytes.length; o += chunkBytes) out.push(bytes.slice(o, o + chunkBytes))
  return out
}

function readableFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

async function* asyncFrom(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

async function collect(data: VizData, opts?: Parameters<typeof normalizeVizData>[1]): Promise<NormalizedBatch[]> {
  const out: NormalizedBatch[] = []
  for await (const b of normalizeVizData(data, opts)) out.push(b)
  return out
}

/** Concatenate all batch positions into one Float32Array. */
function concatPositions(batches: NormalizedBatch[]): Float32Array {
  const total = batches.reduce((n, b) => n + b.positions.length, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const b of batches) {
    out.set(b.positions, o)
    o += b.positions.length
  }
  return out
}

describe('normalizeVizData — Float32Array', () => {
  it('yields ONE batch at offset 0 whose positions ARE the input (instant render)', async () => {
    const pts = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    let total: number | null = -1
    const batches = await collect(pts, { onTotal: (t) => (total = t) })
    expect(batches).toHaveLength(1)
    expect(batches[0].offset).toBe(0)
    expect(batches[0].positions).toBe(pts) // same reference — zero copy
    expect(total).toBe(3) // 3 points
  })
})

describe('normalizeVizData — ReadableStream / AsyncIterable of bytes', () => {
  // A cloud big enough to reframe into >1 whole-row batch (default 65536 rows/batch).
  const N = 100_000
  const src = new Float32Array(N * 2)
  for (let i = 0; i < N; i++) {
    src[i * 2] = (i % 1000) / 1000
    src[i * 2 + 1] = ((i * 7) % 1000) / 1000
  }

  it('a ReadableStream split at arbitrary byte boundaries → correct point offsets + exact concat', async () => {
    const chunks = chunkize(f32Bytes(src), 7003) // 7003 not a multiple of stride 8 → straddling rows
    const batches = await collect(readableFrom(chunks))
    expect(batches.length).toBeGreaterThan(1)
    expect(batches[0].offset).toBe(0)
    // Offsets are in POINTS, strictly increasing, each = the sum of prior batch point counts.
    let acc = 0
    for (const b of batches) {
      expect(b.offset).toBe(acc)
      acc += b.positions.length >> 1
    }
    expect(acc).toBe(N)
    expect(Array.from(concatPositions(batches))).toEqual(Array.from(src))
  })

  it('an AsyncIterable<Uint8Array> normalizes identically to the ReadableStream', async () => {
    const chunks = chunkize(f32Bytes(src), 4096)
    const batches = await collect(asyncFrom(chunks))
    expect(concatPositions(batches).length).toBe(src.length)
    expect(Array.from(concatPositions(batches))).toEqual(Array.from(src))
  })
})

describe('normalizeVizData — packed object form (stride 4, Uint16 codes → identity Float32)', () => {
  it('decodes 16-bit codes to Float32 code-space and defaults stride to 4', async () => {
    const codes = new Uint16Array([0, 65535, 100, 200, 300, 400]) // 3 points
    const bytes = new Uint8Array(codes.slice().buffer)
    const data: VizData = { positions: readableFrom(chunkize(bytes, 5)), packed: true }
    const batches = await collect(data)
    const got = concatPositions(batches)
    expect(got.length).toBe(codes.length)
    expect(Array.from(got)).toEqual([0, 65535, 100, 200, 300, 400])
    // offset in points (stride 4 → 1 row = 1 point)
    expect(batches[0].offset).toBe(0)
  })

  it('object form total wins → onTotal fires once with it', async () => {
    const codes = new Uint16Array([1, 2, 3, 4])
    const bytes = new Uint8Array(codes.slice().buffer)
    const totals: (number | null)[] = []
    await collect(
      { positions: asyncFrom(chunkize(bytes, 3)), packed: true, total: 2 },
      { onTotal: (t) => totals.push(t) },
    )
    expect(totals).toEqual([2])
  })
})

describe('normalizeVizData — URL via injected fetch', () => {
  it('streams from a URL and surfaces Content-Length rows via onTotal', async () => {
    const pts = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) // 4 points, 32 bytes, stride 8
    const bytes = f32Bytes(pts)
    const fetchImpl = (async () =>
      new Response(readableFrom(chunkize(bytes, 9)), {
        status: 200,
        headers: { 'Content-Length': String(bytes.length) },
      })) as unknown as typeof fetch

    let total: number | null = -1
    const batches = await collect('https://example.test/positions.bin', {
      fetchImpl,
      onTotal: (t) => (total = t),
    })
    expect(total).toBe(4) // 32 bytes / stride 8
    expect(Array.from(concatPositions(batches))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(batches[0].offset).toBe(0)
  })
})
