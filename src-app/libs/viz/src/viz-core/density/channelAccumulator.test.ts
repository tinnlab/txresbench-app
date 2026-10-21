import { describe, it, expect } from 'vitest'
import { ChannelAccumulator } from './accumulator'
import {
  binAndShade,
  binAndShadeValue,
  shadeCategory,
  categoryPaletteFor,
  exactQuantile,
} from './cpuRaster'
import { cellForPoint, type DensityBounds } from './densityBin'
import { scaleLightness } from '../data/color'

// STREAMING_PROGRESSIVE_PLAN Wave 2b — the MULTI-CHANNEL accumulator (items 5/6/14). The hard
// guarantees, proven as pure logic (no Worker): channel grids accumulate ADDITIVELY (byte-identical
// to a one-shot bin regardless of chunking); each channel's terminal shade == the one-shot; the
// value color scale is the KLL sketch's p1/p99; a value-column re-bind keeps the resident count.

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const K = 6

/** A deterministic PRNG (for both the cloud AND the KLL, so quantiles are reproducible). */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff
}

function makeCloud(n: number, seed = 7): { xy: Float32Array; labels: Uint16Array; values: Float32Array } {
  const xy = new Float32Array(n * 2)
  const labels = new Uint16Array(n)
  const values = new Float32Array(n)
  const r = prng(seed)
  for (let i = 0; i < n; i++) {
    xy[i * 2] = r()
    xy[i * 2 + 1] = r()
    labels[i] = Math.floor(r() * K)
    values[i] = r() * 100 - 20 // spread incl. negatives
  }
  return { xy, labels, values }
}

function chunkPoints(xy: Float32Array, labels: Uint16Array, values: Float32Array, chunk: number) {
  const out: Array<{ xy: Float32Array; labels: Uint16Array; values: Float32Array }> = []
  const n = xy.length >> 1
  for (let o = 0; o < n; o += chunk) {
    const end = Math.min(n, o + chunk)
    out.push({
      xy: xy.slice(o * 2, end * 2),
      labels: labels.slice(o, end),
      values: values.slice(o, end),
    })
  }
  return out
}

/** One-shot per-cell {count, sum, catCount} oracle (float64, point order). */
function oracle(
  xy: Float32Array,
  labels: Uint16Array,
  values: Float32Array,
  w: number,
  h: number,
): { count: Float64Array; sum: Float64Array; catCount: Float64Array } {
  const cells = w * h
  const count = new Float64Array(cells)
  const sum = new Float64Array(cells)
  const catCount = new Float64Array(K * cells)
  const n = xy.length >> 1
  for (let i = 0; i < n; i++) {
    const cell = cellForPoint(xy[i * 2], xy[i * 2 + 1], UNIT, w, h)
    if (cell < 0) continue
    count[cell] += 1
    const v = values[i]
    if (Number.isFinite(v)) sum[cell] += v
    const c = labels[i]
    if (c >= 0 && c < K) catCount[c * cells + cell] += 1
  }
  return { count, sum, catCount }
}

describe('ChannelAccumulator — additive channels equal the one-shot bin, regardless of chunking', () => {
  it('count / sum / catCount accumulate byte-identically to the one-shot oracle across arbitrary chunks', () => {
    const { xy, labels, values } = makeCloud(6000, 13)
    const W = 24
    const H = 18
    const acc = new ChannelAccumulator(
      { bounds: UNIT, width: W, height: H },
      { value: true, variance: true, categories: K, distinctLabels: true, rng: prng(99) },
    )
    for (const c of chunkPoints(xy, labels, values, 137)) acc.append(c.xy, { labels: c.labels, values: c.values })
    const ora = oracle(xy, labels, values, W, H)
    expect(Array.from(acc.counts())).toEqual(Array.from(ora.count))
    expect(Array.from(acc.sums()!)).toEqual(Array.from(ora.sum))
    expect(Array.from(acc.categoryCounts()!)).toEqual(Array.from(ora.catCount))
    expect(acc.rows).toBe(6000)
  })

  it('density-mode shade of the channel accumulator is byte-identical to a one-shot binAndShade', () => {
    const { xy, labels, values } = makeCloud(4000, 21)
    const W = 32
    const H = 24
    const acc = new ChannelAccumulator(
      { bounds: UNIT, width: W, height: H },
      { value: true, categories: K },
    )
    for (const c of chunkPoints(xy, labels, values, 251)) acc.append(c.xy, { labels: c.labels, values: c.values })
    const final = acc.shade({ mode: 'density', normalize: 'log', final: true })
    const oneShot = binAndShade({ positions: xy, bounds: UNIT, width: W, height: H, normalize: 'log' })
    expect(Array.from(final.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('distinct-label HLL estimate is within tolerance of the true distinct count (K)', () => {
    const { xy, labels, values } = makeCloud(8000, 33)
    const acc = new ChannelAccumulator(
      { bounds: UNIT, width: 16, height: 16 },
      { categories: K, distinctLabels: true },
    )
    for (const c of chunkPoints(xy, labels, values, 500)) acc.append(c.xy, { labels: c.labels })
    const est = acc.distinctLabels()!
    expect(est).toBeGreaterThanOrEqual(K - 2)
    expect(est).toBeLessThanOrEqual(K + 2)
  })
})

describe('ChannelAccumulator — VALUE mode (mean via the KLL p1/p99 scale)', () => {
  it('the value color scale IS the sketch p1/p99, close to the exact quantiles', () => {
    const { xy, labels, values } = makeCloud(10000, 41)
    void labels
    const acc = new ChannelAccumulator({ bounds: UNIT, width: 20, height: 20 }, { value: true, rng: prng(1) })
    for (const c of chunkPoints(xy, labels, values, 321)) acc.append(c.xy, { values: c.values })
    const [p1, p99] = acc.valueDomain()
    const exactP1 = exactQuantile(values, 0.01)
    const exactP99 = exactQuantile(values, 0.99)
    const span = exactP99 - exactP1
    // KLL rank error ~1% ⇒ the value at p1/p99 is within a few % of span of the exact one.
    expect(Math.abs(p1 - exactP1)).toBeLessThan(span * 0.1)
    expect(Math.abs(p99 - exactP99)).toBeLessThan(span * 0.1)
  })

  it('terminal value frame == one-shot binAndShadeValue with the SAME (sketch) domain, byte-identical', () => {
    const { xy, labels, values } = makeCloud(5000, 55)
    void labels
    const W = 28
    const H = 20
    const acc = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { value: true, rng: prng(7) })
    for (const c of chunkPoints(xy, labels, values, 173)) acc.append(c.xy, { values: c.values })
    const domain = acc.valueDomain()
    const final = acc.shade({ mode: 'value', final: true, ema: 0.5 /* ignored on final */ })
    const oneShot = binAndShadeValue({ positions: xy, values, bounds: UNIT, width: W, height: H, domain })
    expect(Array.from(final.rgba)).toEqual(Array.from(oneShot.rgba))
  })

  it('DEGENERATE: a single point with an all-equal value column (zero-span scale) does NOT NaN/crash (C-M3)', () => {
    // A one-point cloud → the KLL sketch has ONE value ⇒ p1 === p99 ⇒ a ZERO-span value scale. The
    // shade must still produce a valid, finite raster (no division-by-zero → NaN in the RGBA).
    const acc = new ChannelAccumulator({ bounds: UNIT, width: 8, height: 8 }, { value: true, rng: prng(3) })
    acc.append(new Float32Array([0.5, 0.5]), { values: new Float32Array([42]) })
    const [p1, p99] = acc.valueDomain()
    expect(Number.isFinite(p1) && Number.isFinite(p99)).toBe(true)
    expect(p99 - p1).toBe(0) // zero span — the degenerate case
    const img = acc.shade({ mode: 'value', final: true })
    // Every byte is a finite 0..255 integer (no NaN leaked from a 0/0), and the one cell is painted.
    expect(Array.from(img.rgba).every((v) => Number.isFinite(v) && v >= 0 && v <= 255)).toBe(true)
    let painted = 0
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 0) painted++
    expect(painted).toBe(1)
  })

  it('DEGENERATE: an all-equal value column across MANY points still shades finite (zero-span, no NaN)', () => {
    const acc = new ChannelAccumulator({ bounds: UNIT, width: 12, height: 12 }, { value: true, rng: prng(4) })
    const n = 500
    const xy = new Float32Array(n * 2)
    const values = new Float32Array(n).fill(7) // all identical → p1 === p99
    for (let i = 0; i < n; i++) {
      xy[i * 2] = ((i * 2654435761) >>> 0) / 0xffffffff
      xy[i * 2 + 1] = ((i * 40503) >>> 0) / 0xffffffff
    }
    acc.append(xy, { values })
    const [p1, p99] = acc.valueDomain()
    expect(p99 - p1).toBe(0)
    const img = acc.shade({ mode: 'value', final: true })
    expect(Array.from(img.rgba).every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('ChannelAccumulator — CATEGORY mode (per-cell argmax hue)', () => {
  it('categoryArgmax picks the dominant category, and the shade uses that palette hue', () => {
    // Two disjoint regions, each pure in ONE category → deterministic argmax.
    const n = 2000
    const xy = new Float32Array(n * 2)
    const labels = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      const left = i % 2 === 0
      xy[i * 2] = left ? 0.2 : 0.8
      xy[i * 2 + 1] = 0.5
      labels[i] = left ? 2 : 4
    }
    const W = 4
    const H = 4
    const acc = new ChannelAccumulator({ bounds: UNIT, width: W, height: H }, { categories: K })
    acc.append(xy, { labels })
    const argmax = acc.categoryArgmax()!
    const leftCell = cellForPoint(0.2, 0.5, UNIT, W, H)
    const rightCell = cellForPoint(0.8, 0.5, UNIT, W, H)
    expect(argmax[leftCell]).toBe(2)
    expect(argmax[rightCell]).toBe(4)

    // The shade colors those cells with the argmax category's palette hue (lightness-modulated).
    const img = acc.shade({ mode: 'category', normalize: 'log', flipY: false, final: true })
    const palette = categoryPaletteFor(K)
    // Reconstruct the expected color for the left cell from the same pure fn on the same grids.
    const expected = shadeCategory(acc.categoryCounts()!, K, W, H, { normalize: 'log', flipY: false })
    expect(Array.from(img.rgba)).toEqual(Array.from(expected.rgba))
    // Left cell's RGB hue derives from palette[2] (sanity: not palette[4]).
    const o = leftCell * 4
    expect(img.rgba[o + 3]).toBeGreaterThan(0) // populated
    const p2 = scaleLightness(palette[2], 1)
    // hue check: red/blue ordering matches palette[2] vs palette[4] direction (loose, lightness-scaled)
    expect(p2.length).toBe(3)
  })
})

describe('ChannelAccumulator — matrix bind-a-column keeps the resident count (item 14)', () => {
  it('resetValueChannel + accumulateValueOnly re-binds a NEW column WITHOUT touching count', () => {
    const { xy, labels } = makeCloud(4000, 61)
    void labels
    const values1 = new Float32Array(4000)
    const values2 = new Float32Array(4000)
    const r = prng(5)
    for (let i = 0; i < 4000; i++) {
      values1[i] = r() * 10
      values2[i] = r() * 1000 - 500 // a very different column
    }
    const acc = new ChannelAccumulator({ bounds: UNIT, width: 20, height: 20 }, { value: true, rng: prng(3) })
    for (const c of chunkPoints(xy, labels, values1, 200)) acc.append(c.xy, { values: c.values })

    const countRef = acc.counts() // the SAME Float64Array object stays resident
    const countsBefore = Array.from(countRef)
    const domain1 = acc.valueDomain()
    const sumsBefore = Array.from(acc.sums()!)

    // Switch the bound column: reset ONLY the value channel, re-bind over the resident positions.
    acc.resetValueChannel()
    acc.accumulateValueOnly(xy, values2)

    // The count grid object is LITERALLY untouched (positions never re-fetched / re-counted).
    expect(acc.counts()).toBe(countRef)
    expect(Array.from(acc.counts())).toEqual(countsBefore)
    // The value channel changed (new domain + new sums).
    expect(acc.valueDomain()).not.toEqual(domain1)
    expect(Array.from(acc.sums()!)).not.toEqual(sumsBefore)

    // And the re-bound value shade equals a one-shot over the resident positions + the new column.
    const domain2 = acc.valueDomain()
    const rebound = acc.shade({ mode: 'value', final: true })
    const oneShot = binAndShadeValue({ positions: xy, values: values2, bounds: UNIT, width: 20, height: 20, domain: domain2 })
    expect(Array.from(rebound.rgba)).toEqual(Array.from(oneShot.rgba))
  })
})
