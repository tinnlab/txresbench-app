import { describe, it, expect, beforeEach } from 'vitest'
import { handleMessage, __resetWorkerStateForTest } from './cpuRaster.worker'
import { binAndShade } from './cpuRaster'
import type { MainToWorker, WorkerToMain } from './cpuRasterClient'
import type { DensityBounds } from './densityBin'

// STREAMING_PROGRESSIVE_PLAN A-H2 — the worker's retain-raw vs base-grid memory decision. The worker
// reducer (`handleMessage`) is driven directly in node (no `Worker`/`self`), capturing its posts:
//   • retainRaw:false (base-grid) → NO raw chunks kept; a post-stream `bin` over `retained` is BLANK
//     (nothing folded → memory bounded), but `binFromBase` (the coarse base grid) is NON-blank + zooms.
//   • retainRaw:true (default)    → the streamed cloud is folded into `retained`, so a `bin` re-bins it
//     EXACTLY (byte-identical to a one-shot binAndShade — the sound terminal==one-shot invariant).

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

function makeCloud(n: number, seed = 5): Float32Array {
  const xy = new Float32Array(n * 2)
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  for (let i = 0; i < n; i++) {
    xy[i * 2] = rnd()
    xy[i * 2 + 1] = rnd()
  }
  return xy
}

/** Drive a full stream (begin → append batches → end) through the reducer, capturing every post. */
function runStream(
  batches: Float32Array[],
  geometry: { width: number; height: number; retainRaw?: boolean; baseGrid?: { width: number; height: number } },
): WorkerToMain[] {
  const posts: WorkerToMain[] = []
  const post = (m: WorkerToMain) => posts.push(m)
  const epoch = 1
  handleMessage(
    { type: 'beginStream', streamEpoch: epoch, geometry: { bounds: UNIT, ...geometry } } as MainToWorker,
    post,
  )
  for (const b of batches) {
    handleMessage({ type: 'append', streamEpoch: epoch, positions: b } as MainToWorker, post)
  }
  handleMessage({ type: 'endStream', streamEpoch: epoch } as MainToWorker, post)
  return posts
}

/** Number of pixels with a non-zero alpha in a shaded RGBA raster. */
function nonBlank(rgba: Uint8ClampedArray): number {
  let n = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) n++
  return n
}

function bin(epoch: number, w: number, h: number): MainToWorker {
  return { type: 'bin', epoch, bounds: UNIT, width: w, height: h, normalize: 'log' } as MainToWorker
}
function binFromBase(epoch: number, w: number, h: number): MainToWorker {
  return { type: 'binFromBase', epoch, bounds: UNIT, width: w, height: h, normalize: 'log' } as MainToWorker
}

describe('cpuRaster.worker handleMessage — retainRaw memory bound (A-H2)', () => {
  beforeEach(() => __resetWorkerStateForTest())

  it('retainRaw:false (base-grid) keeps NO raw cloud — a post-stream `bin` is blank, `binFromBase` is not', () => {
    const cloud = makeCloud(2000, 7)
    const batches = [cloud.slice(0, 800), cloud.slice(800, 2400), cloud.slice(2400)]
    runStream(batches, { width: 12, height: 12, retainRaw: false, baseGrid: { width: 32, height: 32 } })

    // `bin` re-bins the RETAINED cloud — empty on the base-grid path (nothing folded) → fully blank.
    const posts: WorkerToMain[] = []
    handleMessage(bin(10, 12, 12), (m) => posts.push(m))
    const binImg = posts.find((m) => m.type === 'binResult')!
    if (binImg.type !== 'binResult') throw new Error('no binResult')
    expect(nonBlank(binImg.rgba)).toBe(0) // memory bounded: no O(N) retained cloud

    // `binFromBase` rolls up the coarse base grid — NON-blank (the base grid alone answers zooms).
    const posts2: WorkerToMain[] = []
    handleMessage(binFromBase(11, 12, 12), (m) => posts2.push(m))
    const baseImg = posts2.find((m) => m.type === 'binResult')!
    if (baseImg.type !== 'binResult') throw new Error('no binResult')
    expect(nonBlank(baseImg.rgba)).toBeGreaterThan(0)

    // A TIGHTER base-grid re-bin still produces a raster (zoom-in over the base grid).
    const posts3: WorkerToMain[] = []
    handleMessage(
      { type: 'binFromBase', epoch: 12, bounds: { minX: 0.25, minY: 0.25, maxX: 0.75, maxY: 0.75 }, width: 12, height: 12, normalize: 'log' } as MainToWorker,
      (m) => posts3.push(m),
    )
    expect(posts3.some((m) => m.type === 'binResult')).toBe(true)
  })

  it('retainRaw:true (default) folds the cloud → a post-stream `bin` re-bins it EXACTLY (terminal==one-shot)', () => {
    const cloud = makeCloud(1500, 9)
    const batches = [cloud.slice(0, 600), cloud.slice(600, 1800), cloud.slice(1800)]
    const posts = runStream(batches, { width: 16, height: 16 }) // retainRaw defaults true

    // The terminal streamFrame is byte-identical to a one-shot binAndShade (sound invariant, unchanged).
    const finalFrame = posts.filter((m) => m.type === 'streamFrame').at(-1)
    if (!finalFrame || finalFrame.type !== 'streamFrame') throw new Error('no terminal frame')
    expect(finalFrame.final).toBe(true)

    // A post-stream `bin` over the RETAINED (folded) cloud equals a direct binAndShade of the whole cloud.
    const binPosts: WorkerToMain[] = []
    handleMessage(bin(20, 16, 16), (m) => binPosts.push(m))
    const binImg = binPosts.find((m) => m.type === 'binResult')!
    if (binImg.type !== 'binResult') throw new Error('no binResult')
    const oneShot = binAndShade({ positions: cloud, bounds: UNIT, width: 16, height: 16, normalize: 'log' })
    expect(nonBlank(binImg.rgba)).toBeGreaterThan(0)
    expect(Array.from(binImg.rgba)).toEqual(Array.from(oneShot.rgba))
  })
})

// ── color-by-label/value zoom re-bin (regression: coloring reverted to DENSITY on zoom/drag) ──────
// Before the fix, `endStream` folded only positions into `retained`, so a post-stream `bin`/`binFromBase`
// re-shaded as DENSITY — a color-by-value/label raster snapped to density on the first zoom. The worker
// now retains the per-point channel and re-shades it exactly on a zoom re-bin.
import { ChannelAccumulator, type ChannelConfig } from './accumulator'

/** Drive a full CHANNEL stream (begin → append batches carrying labels/value → end). */
function runChannelStream(
  channels: ChannelConfig,
  mode: 'category' | 'value',
  batches: { positions: Float32Array; labels?: Uint16Array; value?: Float32Array }[],
  w: number,
  h: number,
): WorkerToMain[] {
  const posts: WorkerToMain[] = []
  const post = (m: WorkerToMain) => posts.push(m)
  handleMessage(
    { type: 'beginStream', streamEpoch: 1, geometry: { bounds: UNIT, width: w, height: h, channels, mode, retainRaw: true } } as MainToWorker,
    post,
  )
  for (const b of batches) {
    handleMessage({ type: 'append', streamEpoch: 1, positions: b.positions, labels: b.labels, value: b.value } as MainToWorker, post)
  }
  handleMessage({ type: 'endStream', streamEpoch: 1 } as MainToWorker, post)
  return posts
}

describe('cpuRaster.worker — color-by channel survives a zoom re-bin', () => {
  beforeEach(() => __resetWorkerStateForTest())

  it('a post-stream `bin` re-shades by LABEL exactly (category palette, deterministic)', () => {
    const cloud = makeCloud(400, 9)
    const labels = new Uint16Array(cloud.length / 2)
    for (let i = 0; i < labels.length; i++) labels[i] = i % 4 // 4 categories

    const posts = runChannelStream({ categories: 4 }, 'category', [{ positions: cloud, labels }], 16, 16)
    expect(posts.some(p => p.type === 'streamFrame' && p.final)).toBe(true)

    // A zoom re-bin over the full extent must re-shade by CATEGORY (not density).
    const bins: WorkerToMain[] = []
    handleMessage(bin(2, 16, 16), m => bins.push(m))
    const binImg = bins.find(p => p.type === 'binResult')
    if (!binImg || binImg.type !== 'binResult') throw new Error('no binResult')

    // Category shading is palette-driven (no KLL sketch) ⇒ deterministic, so this is an EXACT match.
    const ref = new ChannelAccumulator({ bounds: UNIT, width: 16, height: 16 }, { categories: 4 })
    ref.append(cloud, { labels })
    const refImg = ref.shade({ mode: 'category', normalize: 'log', final: true })
    const densityImg = binAndShade({ positions: cloud, bounds: UNIT, width: 16, height: 16, normalize: 'log' })

    expect(nonBlank(binImg.rgba)).toBeGreaterThan(0)
    expect(Array.from(binImg.rgba)).toEqual(Array.from(refImg.rgba)) // re-shaded by CATEGORY
    expect(Array.from(binImg.rgba)).not.toEqual(Array.from(densityImg.rgba)) // NOT density (the bug)
  })

  it('a post-stream `bin` re-shades by VALUE, NOT density (the reported regression)', () => {
    const cloud = makeCloud(400, 7)
    const value = new Float32Array(cloud.length / 2)
    for (let i = 0; i < value.length; i++) value[i] = cloud[i * 2] // value = x, a left→right gradient

    runChannelStream({ value: true }, 'value', [{ positions: cloud, value }], 16, 16)
    const bins: WorkerToMain[] = []
    handleMessage(bin(2, 16, 16), m => bins.push(m))
    const binImg = bins.find(p => p.type === 'binResult')
    if (!binImg || binImg.type !== 'binResult') throw new Error('no binResult')

    // Value shading uses a KLL value-domain sketch (approximate across instances), so assert the
    // MEANINGFUL invariant: the zoom re-bin is NOT the density raster (the bug) and is non-blank.
    const densityImg = binAndShade({ positions: cloud, bounds: UNIT, width: 16, height: 16, normalize: 'log' })
    expect(nonBlank(binImg.rgba)).toBeGreaterThan(0)
    expect(Array.from(binImg.rgba)).not.toEqual(Array.from(densityImg.rgba))
  })

  it('a DENSITY stream leaves no retained channel — a `bin` still equals density (unchanged path)', () => {
    const cloud = makeCloud(300, 3)
    runStream([cloud], { width: 16, height: 16, retainRaw: true })
    const bins: WorkerToMain[] = []
    handleMessage(bin(2, 16, 16), m => bins.push(m))
    const binImg = bins.find(p => p.type === 'binResult')
    if (!binImg || binImg.type !== 'binResult') throw new Error('no binResult')
    const density = binAndShade({ positions: cloud, bounds: UNIT, width: 16, height: 16, normalize: 'log' })
    expect(Array.from(binImg.rgba)).toEqual(Array.from(density.rgba))
  })
})
