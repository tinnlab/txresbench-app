import { describe, it, expect } from 'vitest'
import { createCpuRasterClient, type RasterStreamFrameMeta } from './cpuRasterClient'
import { binAndShade, type RasterImage } from './cpuRaster'
import type { DensityBounds } from './densityBin'
import type { NormalizedRasterBatch } from './cpuRasterClient'

// STREAMING_PROGRESSIVE_PLAN Wave 2a — the client's progressive `streamRaster`. Node vitest has no
// `Worker`, so these exercise the MAIN-THREAD accumulator fallback (byte-identical output) with
// `throttleMs: 0` (a frame per batch, deterministic). They prove: progressive frames emit, the
// terminal frame equals a one-shot `binAndShade`, and a superseding stream drops the stale one.

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

function makeCloud(n: number, seed = 11): Float32Array {
  const xy = new Float32Array(n * 2)
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  for (let i = 0; i < n; i++) {
    xy[i * 2] = rnd()
    xy[i * 2 + 1] = rnd()
  }
  return xy
}

/** An async iterable of normalized batches (chunks of `chunkPoints` points). */
async function* chunkStream(xy: Float32Array, chunkPoints: number): AsyncIterable<NormalizedRasterBatch> {
  let offset = 0
  for (let o = 0; o < xy.length; o += chunkPoints * 2) {
    const positions = xy.slice(o, o + chunkPoints * 2)
    yield { offset, positions }
    offset += positions.length >> 1
  }
}

interface Captured {
  frames: Array<{ image: RasterImage; meta: RasterStreamFrameMeta }>
  done: boolean
  lastRowsSeen: number
}

function driveStream(
  source: AsyncIterable<NormalizedRasterBatch>,
  geometry: { bounds?: DensityBounds; width: number; height: number; normalize?: 'log' | 'linear' | 'histeq'; ema?: number },
  opts?: { throttleMs?: number; signal?: AbortSignal },
): Promise<Captured> {
  const client = createCpuRasterClient({ forceMainThread: true })
  return new Promise<Captured>((resolve) => {
    const cap: Captured = { frames: [], done: false, lastRowsSeen: 0 }
    client.streamRaster(
      source,
      geometry,
      {
        onFrame: (image, meta) => cap.frames.push({ image, meta }),
        onProgress: (rowsSeen) => (cap.lastRowsSeen = rowsSeen),
        onDone: () => {
          cap.done = true
          resolve(cap)
        },
        onError: () => resolve(cap),
      },
      { throttleMs: 0, ...opts },
    )
  })
}

describe('createCpuRasterClient.streamRaster — main-thread fallback', () => {
  it('emits >1 frame for a chunked stream and a final frame equal to the one-shot binAndShade', async () => {
    const xy = makeCloud(2000)
    const cap = await driveStream(chunkStream(xy, 200), { bounds: UNIT, width: 24, height: 18, normalize: 'log' })
    expect(cap.done).toBe(true)
    // 10 chunks → 10 partials + 1 terminal.
    expect(cap.frames.length).toBeGreaterThan(1)
    const finals = cap.frames.filter((f) => f.meta.final)
    expect(finals).toHaveLength(1)
    expect(cap.lastRowsSeen).toBe(2000)
    expect(finals[0].meta.rowsSeen).toBe(2000)

    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: 24, height: 18, normalize: 'log' })
    expect(Array.from(finals[0].image.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('a whole-array (single batch) stream still yields a final frame equal to one-shot (instant)', async () => {
    const xy = makeCloud(1500, 3)
    const cap = await driveStream(chunkStream(xy, 100_000), { bounds: UNIT, width: 30, height: 30, normalize: 'linear' })
    expect(cap.done).toBe(true)
    const final = cap.frames.find((f) => f.meta.final)!
    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: 30, height: 30, normalize: 'linear' })
    expect(Array.from(final.image.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('seeds bin bounds from the first batch when geometry.bounds is omitted', async () => {
    const xy = makeCloud(1000, 2)
    const cap = await driveStream(chunkStream(xy, 250), { width: 16, height: 16 })
    const final = cap.frames.find((f) => f.meta.final)!
    // bounds were derived from the data (not the unit square) — finite + non-degenerate.
    expect(final.meta.bounds.maxX).toBeGreaterThan(final.meta.bounds.minX)
    expect(Number.isFinite(final.meta.bounds.minX)).toBe(true)
  })

  it('a SUPERSEDING stream on the SAME client drops the stale stream — its frames stop landing', async () => {
    // Supersession is per-client (one shared epoch counter), so both streams run on ONE client.
    const client = createCpuRasterClient({ forceMainThread: true })
    const staleFrames: RasterStreamFrameMeta[] = []
    let staleDone = false

    // Slow source: pauses between chunks so a second stream can supersede mid-flight.
    async function* slow(): AsyncIterable<NormalizedRasterBatch> {
      const xy = makeCloud(800, 1)
      let offset = 0
      for (let o = 0; o < xy.length; o += 200 * 2) {
        const positions = xy.slice(o, o + 200 * 2)
        yield { offset, positions }
        offset += positions.length >> 1
        await new Promise((r) => setTimeout(r, 5))
      }
    }

    client.streamRaster(
      slow(),
      { bounds: UNIT, width: 12, height: 12 },
      {
        onFrame: (_img, meta) => staleFrames.push(meta),
        onDone: () => (staleDone = true),
      },
      { throttleMs: 0 },
    )

    // Start a second stream on the SAME client — bumps the shared epoch, superseding the first.
    let winnerDone = false
    await new Promise<void>((resolve) => {
      client.streamRaster(
        chunkStream(makeCloud(600, 4), 150),
        { bounds: UNIT, width: 12, height: 12 },
        {
          onFrame: () => {},
          onDone: () => {
            winnerDone = true
            resolve()
          },
        },
        { throttleMs: 0 },
      )
    })
    expect(winnerDone).toBe(true)

    // Give the stale (slow) stream time to try to finish; it must NOT deliver a terminal frame.
    await new Promise((r) => setTimeout(r, 60))
    expect(staleDone).toBe(false)
    expect(staleFrames.some((m) => m.final)).toBe(false)
  })

  it('calls onError when the source THROWS mid-stream (surfaced, not silently swallowed)', async () => {
    // A-H1: a broken source (a 404 that threw, a dropped connection, a malformed stream that
    // `reframeBytes` rejects on) must reach `handlers.onError` — never a silent hang / blank.
    const client = createCpuRasterClient({ forceMainThread: true })
    let errored: unknown = null
    let done = false
    async function* boom(): AsyncIterable<NormalizedRasterBatch> {
      yield { offset: 0, positions: makeCloud(100) }
      throw new Error('stream exploded')
    }
    await new Promise<void>((resolve) => {
      client.streamRaster(
        boom(),
        { bounds: UNIT, width: 8, height: 8 },
        {
          onFrame: () => {},
          onDone: () => {
            done = true
            resolve()
          },
          onError: (e) => {
            errored = e
            resolve()
          },
        },
        { throttleMs: 0 },
      )
    })
    expect(done).toBe(false) // a failed stream does NOT complete
    expect(errored).toBeInstanceOf(Error)
    expect((errored as Error).message).toBe('stream exploded')
  })

  it('cancel() stops a stream: no terminal frame after cancellation', async () => {
    const client = createCpuRasterClient({ forceMainThread: true })
    let done = false
    async function* slow(): AsyncIterable<NormalizedRasterBatch> {
      const xy = makeCloud(1000, 8)
      let offset = 0
      for (let o = 0; o < xy.length; o += 100 * 2) {
        const positions = xy.slice(o, o + 100 * 2)
        yield { offset, positions }
        offset += positions.length >> 1
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const handle = client.streamRaster(
      slow(),
      { bounds: UNIT, width: 10, height: 10 },
      { onFrame: () => {}, onDone: () => (done = true) },
      { throttleMs: 0 },
    )
    await new Promise((r) => setTimeout(r, 8))
    handle.cancel()
    await new Promise((r) => setTimeout(r, 60))
    expect(done).toBe(false)
  })
})
