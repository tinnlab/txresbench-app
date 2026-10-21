import { describe, it, expect } from 'vitest'
import {
  createCpuRasterClient,
  type NormalizedRasterBatch,
  type ValueColumnBatch,
  type RasterStreamFrameMeta,
} from './cpuRasterClient'
import { ChannelAccumulator } from './accumulator'
import type { RasterImage } from './cpuRaster'
import type { DensityBounds } from './densityBin'

// STREAMING_PROGRESSIVE_PLAN Wave 2b — the client's MULTI-CHANNEL `streamRaster` + `bindValueColumn`.
// Node vitest has no `Worker`, so these drive the MAIN-THREAD channel accumulator fallback (byte-
// identical to the worker path) with `throttleMs: 0`. They prove: a value/category stream emits
// progressive frames whose TERMINAL frame == a one-shot ChannelAccumulator, and a value-column bind
// re-accumulates over the RESIDENT positions (never re-streaming them).

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const K = 6
const SEED = 4242

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff
}
function makeCloud(n: number, seed = 7) {
  const xy = new Float32Array(n * 2)
  const labels = new Uint16Array(n)
  const values = new Float32Array(n)
  const r = prng(seed)
  for (let i = 0; i < n; i++) {
    xy[i * 2] = r()
    xy[i * 2 + 1] = r()
    labels[i] = Math.floor(r() * K)
    values[i] = r() * 200 - 50
  }
  return { xy, labels, values }
}
async function* chunkStream(
  xy: Float32Array,
  labels: Uint16Array | null,
  values: Float32Array | null,
  chunkPoints: number,
): AsyncIterable<NormalizedRasterBatch> {
  let offset = 0
  const n = xy.length >> 1
  for (let o = 0; o < n; o += chunkPoints) {
    const end = Math.min(n, o + chunkPoints)
    yield {
      offset,
      positions: xy.slice(o * 2, end * 2),
      labels: labels ? labels.slice(o, end) : undefined,
      value: values ? values.slice(o, end) : undefined,
    }
    offset = end
  }
}
async function* valueStream(values: Float32Array, chunk: number): AsyncIterable<ValueColumnBatch> {
  for (let o = 0; o < values.length; o += chunk) {
    yield { offset: o, value: values.slice(o, o + chunk) }
  }
}

interface Cap {
  frames: Array<{ image: RasterImage; meta: RasterStreamFrameMeta }>
  done: boolean
}
function driveStream(
  source: AsyncIterable<NormalizedRasterBatch>,
  geometry: Parameters<ReturnType<typeof createCpuRasterClient>['streamRaster']>[1],
): Promise<Cap> {
  const client = createCpuRasterClient({ forceMainThread: true })
  return new Promise<Cap>((resolve) => {
    const cap: Cap = { frames: [], done: false }
    client.streamRaster(
      source,
      geometry,
      {
        onFrame: (image, meta) => cap.frames.push({ image, meta }),
        onDone: () => {
          cap.done = true
          resolve(cap)
        },
        onError: () => resolve(cap),
      },
      { throttleMs: 0 },
    )
  })
}

describe('streamRaster — VALUE channel (progressive mean; terminal == one-shot)', () => {
  it('emits progressive frames and the terminal frame equals a one-shot value accumulator', async () => {
    const { xy, values } = makeCloud(6000, 11)
    const W = 24
    const H = 18
    const cap = await driveStream(chunkStream(xy, null, values, 300), {
      bounds: UNIT,
      width: W,
      height: H,
      channels: { value: true, rng: prng(SEED) },
      mode: 'value',
    })
    expect(cap.done).toBe(true)
    expect(cap.frames.length).toBeGreaterThan(1) // progressive
    const last = cap.frames[cap.frames.length - 1]
    expect(last.meta.final).toBe(true)
    // Reference: a one-shot channel accumulator (same rng seed → same KLL scale).
    const ref = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { value: true, rng: prng(SEED) })
    ref.append(xy, { values })
    const refFinal = ref.shade({ mode: 'value', final: true })
    expect(Array.from(last.image.rgba)).toEqual(Array.from(refFinal.rgba))
  })
})

describe('streamRaster — CATEGORY channel (argmax hue; terminal == one-shot)', () => {
  it('the terminal category frame equals a one-shot channel accumulator', async () => {
    const { xy, labels } = makeCloud(6000, 23)
    const W = 20
    const H = 20
    const cap = await driveStream(chunkStream(xy, labels, null, 250), {
      bounds: UNIT,
      width: W,
      height: H,
      channels: { categories: K },
      mode: 'category',
    })
    expect(cap.done).toBe(true)
    const last = cap.frames[cap.frames.length - 1]
    expect(last.meta.final).toBe(true)
    const ref = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { categories: K })
    ref.append(xy, { labels })
    const refFinal = ref.shade({ mode: 'category', final: true })
    expect(Array.from(last.image.rgba)).toEqual(Array.from(refFinal.rgba))
  })
})

describe('bindValueColumn — re-bind a column over RESIDENT positions (item 14)', () => {
  it('binds a value column against init()-retained positions; terminal == one-shot value shade', async () => {
    const { xy, values } = makeCloud(5000, 31)
    const W = 22
    const H = 16
    const client = createCpuRasterClient({ forceMainThread: true })
    client.init(xy) // positions resident — the matrix column is bound WITHOUT re-streaming them

    const cap = await new Promise<Cap>((resolve) => {
      const c: Cap = { frames: [], done: false }
      client.bindValueColumn(
        valueStream(values, 400),
        { bounds: UNIT, width: W, height: H, rng: prng(SEED) },
        {
          onFrame: (image, meta) => c.frames.push({ image, meta }),
          onDone: () => {
            c.done = true
            resolve(c)
          },
          onError: () => resolve(c),
        },
        { throttleMs: 0 },
      )
    })
    expect(cap.done).toBe(true)
    expect(cap.frames.length).toBeGreaterThan(1)
    const last = cap.frames[cap.frames.length - 1]
    expect(last.meta.final).toBe(true)

    // Reference: a value accumulator fed the RESIDENT positions + the column (same rng seed).
    const ref = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { value: true, rng: prng(SEED) })
    ref.append(xy, { values })
    const refFinal = ref.shade({ mode: 'value', final: true })
    expect(Array.from(last.image.rgba)).toEqual(Array.from(refFinal.rgba))
  })

  it('switching the bound column (a second bindValueColumn) supersedes the first', async () => {
    const { xy, values } = makeCloud(3000, 41)
    const values2 = values.map((v) => v * -3 + 10)
    const W = 18
    const H = 14
    const client = createCpuRasterClient({ forceMainThread: true })
    client.init(xy)

    // Bind column 1, then IMMEDIATELY bind column 2 — only the latest wins (positions stay resident).
    let done2 = false
    const frames2: RasterImage[] = []
    client.bindValueColumn(valueStream(values, 400), { bounds: UNIT, width: W, height: H, rng: prng(1) }, { onFrame: () => {} })
    await new Promise<void>((resolve) => {
      client.bindValueColumn(
        valueStream(values2, 400),
        { bounds: UNIT, width: W, height: H, rng: prng(SEED) },
        {
          onFrame: (image) => frames2.push(image),
          onDone: () => {
            done2 = true
            resolve()
          },
          onError: () => resolve(),
        },
        { throttleMs: 0 },
      )
    })
    expect(done2).toBe(true)
    const ref = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { value: true, rng: prng(SEED) })
    ref.append(xy, { values: values2 })
    const refFinal = ref.shade({ mode: 'value', final: true })
    expect(Array.from(frames2[frames2.length - 1].rgba)).toEqual(Array.from(refFinal.rgba))
  })
})
