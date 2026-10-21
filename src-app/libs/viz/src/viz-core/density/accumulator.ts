// accumulator.ts — the PROGRESSIVE density accumulator (STREAMING_PROGRESSIVE_PLAN Wave 2a,
// items 1-2). The additive count grid is an incrementally-maintainable materialized view: a
// histogram is `COUNT … GROUP BY (binX,binY)`, so a new batch is a pure `+=` into the grid — we
// never recompute. Progressive rendering, for us, = shade the accumulator-SO-FAR after each batch.
//
// This module is the PURE, testable unit the worker (and the client's main-thread fallback) drive:
// it holds a FIXED-geometry count grid and grows it batch by batch, then shades on demand with an
// optional EMA blend toward the previous frame (anti-flicker). It reuses `cellForPoint` for the
// binning (byte-consistent with the `binDensity` oracle) and `shadeCounts` for the shade tail
// (byte-consistent with `binAndShade`).
//
// ── THE FINAL-EQUALS-ONE-SHOT INVARIANT (the hard guarantee) ──────────────────────
// `append` does exactly `count[cellForPoint(x,y)] += 1` — the SAME loop as `binDensity` (values
// null). So after feeding every batch, `counts()` is byte-identical to `binDensity(concat, bounds,
// w, h).count`, and `shade({ final:true })` (no EMA) is byte-identical to `binAndShade(concat,
// { bounds, width, height, … })` — regardless of how the points were chunked. Progressive load
// converges to the exact one-shot raster.

import { cellForPoint, type DensityBounds } from './densityBin'
import {
  shadeCounts,
  shadeValue,
  shadeCategory,
  type RasterImage,
  type RasterNormalize,
  type ShadeMode,
} from './cpuRaster'
import { KllSketch, HyperLogLog, hash32 } from '../data/sketches'
import { kllDomain } from '../data/progressiveDomain'
import type { ContinuousColormap } from '../data/color'
import type { PackMeta } from './quantize'

/** The fixed binning geometry an accumulator grows over (bounds + grid dims). */
export interface AccumulatorGeometry {
  readonly bounds: DensityBounds
  readonly width: number
  readonly height: number
}

/** Shade options for {@link DensityAccumulator.shade}. */
export interface AccumulatorShadeOptions {
  readonly colormap?: ContinuousColormap
  readonly normalize?: RasterNormalize
  readonly alpha?: number
  readonly flipY?: boolean
  /** Retention weight of the PREVIOUS frame, `[0,1)` (anti-flicker). `0`/undefined = exact current
   *  shade (no blend). Ignored when there is no previous frame (the first shade is always exact). */
  readonly ema?: number
  /** Force an EXACT shade (`ema` treated as 0) and do NOT retain it as the blend base — used for the
   *  terminal frame so the completed raster equals the one-shot `binAndShade`. */
  readonly final?: boolean
}

/**
 * A fixed-geometry additive count grid that shades the accumulator-so-far. Feed batches with
 * {@link append} / {@link appendPacked}; call {@link shade} for a progressive frame. Out-of-bounds
 * points are dropped (same rule as `binDensity`). Counts accumulate in float64 (integer-exact),
 * mirroring `binDensity`'s internal accumulation.
 */
export class DensityAccumulator {
  readonly width: number
  readonly height: number
  readonly bounds: DensityBounds
  private readonly count: Float64Array
  private rowsSeen = 0
  /** A retained COPY of the last shaded RGBA (the shade output is transferred, so we can't keep it
   *  directly) — the EMA blend base. `null` until the first non-final shade. */
  private prevRgba: Uint8ClampedArray | null = null

  constructor(geom: AccumulatorGeometry) {
    this.width = Math.max(1, Math.floor(geom.width))
    this.height = Math.max(1, Math.floor(geom.height))
    this.bounds = geom.bounds
    this.count = new Float64Array(this.width * this.height)
  }

  /** Points binned so far (in-bounds + out-of-bounds; matches `positions.length/2` fed). */
  get rows(): number {
    return this.rowsSeen
  }

  /** Additive `+=` for an interleaved xy `Float32Array` (length points*2). Returns points added. */
  append(positions: Float32Array): number {
    const n = positions.length >> 1
    const { bounds, width: w, height: h, count } = this
    for (let i = 0; i < n; i++) {
      const cell = cellForPoint(positions[i * 2], positions[i * 2 + 1], bounds, w, h)
      if (cell >= 0) count[cell] += 1
    }
    this.rowsSeen += n
    return n
  }

  /** Additive `+=` for a 16-bit PACKED cloud (decodes each code on the fly, mirrors
   *  `binDensityPacked`). Returns points added. */
  appendPacked(packed: Uint16Array, meta: PackMeta): number {
    const n = packed.length >> 1
    const { bounds, width: w, height: h, count } = this
    for (let i = 0; i < n; i++) {
      const x = meta.originX + packed[i * 2] * meta.scaleX
      const y = meta.originY + packed[i * 2 + 1] * meta.scaleY
      const cell = cellForPoint(x, y, bounds, w, h)
      if (cell >= 0) count[cell] += 1
    }
    this.rowsSeen += n
    return n
  }

  /** The current count grid (row-major, length width*height) — for tests / final-equality proofs. */
  counts(): Float64Array {
    return this.count
  }

  /**
   * Shade the accumulator-so-far into an RGBA raster (reusing the shared `shadeCounts` tail, so a
   * final shade is byte-identical to `binAndShade`). With a non-zero `ema` and a retained previous
   * frame, the result is EMA-blended toward the last frame (anti-flicker); a `final` shade is always
   * exact and does not update the blend base.
   */
  shade(opts: AccumulatorShadeOptions = {}): RasterImage {
    const isFinal = opts.final === true
    const ema = isFinal ? 0 : (opts.ema ?? 0)
    const image = shadeCounts(this.count, this.width, this.height, {
      colormap: opts.colormap,
      normalize: opts.normalize,
      alpha: opts.alpha,
      flipY: opts.flipY,
      ema,
      prevRgba: this.prevRgba,
    })
    // Retain the blended output as the next blend base (skip on the terminal frame — nothing follows).
    if (!isFinal) this.prevRgba = Uint8ClampedArray.from(image.rgba)
    return image
  }
}

// ── MULTI-CHANNEL accumulator (STREAMING_PROGRESSIVE_PLAN Wave 2b, item 5) ───────────────────────
// A SUPERSET of `DensityAccumulator`: besides the additive `count` grid it optionally maintains, per
// batch and additively:
//   • a CONTINUOUS value channel — `sum[cell] += v` (+ optional `sumSq` for variance) + a KLL sketch
//     of the values (its p1/p99 drives the value color scale, no second pass).
//   • a CATEGORY channel — per-category count grids `catCount[k*cells+cell] += 1` (+ optional HLL of
//     the distinct label codes). The shade takes the per-cell ARGMAX category's hue.
// `count` is ALWAYS maintained, so a `'density'` shade is byte-identical to `DensityAccumulator`
// (same `count += 1` loop, same `shadeCounts` tail). The channels that are live are fixed at
// construction (mirrors the worker's `beginStream`). Domain-neutral: value/category/label only.

/** Which channels a {@link ChannelAccumulator} maintains (fixed at construction). */
export interface ChannelConfig {
  /** number of category slots K (label codes `0..K-1` tracked) — enables the category channel. */
  readonly categories?: number
  /** maintain the continuous value channel (`sum` + KLL sketch). */
  readonly value?: boolean
  /** also maintain `sumSq` (→ per-cell variance). Implies {@link ChannelConfig.value}. */
  readonly variance?: boolean
  /** maintain a HyperLogLog of distinct label codes (approx distinct-label count). */
  readonly distinctLabels?: boolean
  /** KLL `k` for the value sketch (default 200). */
  readonly sketchK?: number
  /** injectable RNG for the KLL (tests pass a seeded PRNG for determinism). */
  readonly rng?: () => number
  /** HLL precision p (default 12). */
  readonly hllPrecision?: number
}

/** Per-batch channel payloads, aligned 1:1 with the batch's points (index `i` = point `i`). */
export interface ChannelAppend {
  /** label code per point (category channel). Values `≥ K` (or `< 0`) are ignored for the grids. */
  readonly labels?: Uint16Array | Int32Array | Int16Array
  /** continuous value per point (value channel). Non-finite counts the point but adds 0 to the sum. */
  readonly values?: Float32Array | Float64Array
}

/** Shade options for {@link ChannelAccumulator.shade}. Superset of {@link AccumulatorShadeOptions}
 *  plus the channel `mode` + per-mode extras. */
export interface ChannelShadeOptions extends AccumulatorShadeOptions {
  /** which channel to shade (default `'density'`). */
  readonly mode?: ShadeMode
  /** value mode: override the sketch-derived `[p1,p99]` domain. */
  readonly valueDomain?: readonly [number, number]
  /** category mode: an explicit per-category RGB palette (default the built-in extended palette). */
  readonly palette?: readonly (readonly [number, number, number])[]
  /** category mode: minimum lightness factor for a populated cell (default 0.4). */
  readonly minLightness?: number
}

/**
 * A fixed-geometry additive accumulator with optional CONTINUOUS + CATEGORY channels alongside the
 * density `count` grid. Feed batches with {@link append} / {@link appendPacked} (each carrying the
 * present channel payloads); {@link shade} renders any channel (`density` byte-identical to
 * `DensityAccumulator`, `value` = mean via the KLL-derived scale, `category` = per-cell argmax hue).
 * {@link resetValueChannel} + {@link accumulateValueOnly} re-bind a NEW value column over resident
 * positions WITHOUT touching `count`/`catCount` (the matrix "bind-a-column" primitive, item 14).
 */
export class ChannelAccumulator {
  readonly width: number
  readonly height: number
  readonly bounds: DensityBounds
  private readonly cells: number
  private readonly count: Float64Array
  private rowsSeen = 0
  private prevRgba: Uint8ClampedArray | null = null

  // Value channel (null when not configured).
  private sum: Float64Array | null = null
  private sumSq: Float64Array | null = null
  private sketch: KllSketch | null = null
  private readonly sketchK: number
  private readonly rng: () => number

  // Category channel (null when not configured).
  private catCount: Float64Array | null = null // category-major: catCount[k*cells + cell]
  private readonly K: number
  private hll: HyperLogLog | null = null

  constructor(geom: AccumulatorGeometry, channels: ChannelConfig = {}) {
    this.width = Math.max(1, Math.floor(geom.width))
    this.height = Math.max(1, Math.floor(geom.height))
    this.bounds = geom.bounds
    this.cells = this.width * this.height
    this.count = new Float64Array(this.cells)
    this.sketchK = channels.sketchK ?? 200
    this.rng = channels.rng ?? Math.random

    const wantValue = channels.value === true || channels.variance === true
    if (wantValue) {
      this.sum = new Float64Array(this.cells)
      if (channels.variance) this.sumSq = new Float64Array(this.cells)
      this.sketch = new KllSketch(this.sketchK, this.rng)
    }
    this.K = channels.categories && channels.categories > 0 ? Math.floor(channels.categories) : 0
    if (this.K > 0) this.catCount = new Float64Array(this.K * this.cells)
    if (channels.distinctLabels) this.hll = new HyperLogLog(channels.hllPrecision ?? 12)
  }

  /** Points binned so far (in-bounds + out-of-bounds; matches `positions.length/2` fed). */
  get rows(): number {
    return this.rowsSeen
  }

  /** True when a continuous value channel is configured. */
  get hasValue(): boolean {
    return this.sum !== null
  }

  /** Number of category slots (0 when no category channel). */
  get categoryCount(): number {
    return this.K
  }

  /** Additive `+=` for interleaved xy positions + the present channel payloads (aligned by index). */
  append(positions: Float32Array, ch?: ChannelAppend): number {
    const n = positions.length >> 1
    const { bounds, width: w, height: h, count, cells, sum, sumSq, sketch, catCount, K, hll } = this
    const labels = ch?.labels
    const values = ch?.values
    for (let i = 0; i < n; i++) {
      const cell = cellForPoint(positions[i * 2], positions[i * 2 + 1], bounds, w, h)
      if (cell < 0) continue
      count[cell] += 1
      if (sum && values) {
        const v = values[i]
        if (Number.isFinite(v)) {
          sum[cell] += v
          if (sumSq) sumSq[cell] += v * v
        }
        if (sketch) sketch.update(v)
      }
      if (catCount && labels) {
        const c = labels[i]
        if (c >= 0 && c < K) catCount[c * cells + cell] += 1
        if (hll && c >= 0) hll.add(hash32(c))
      }
    }
    this.rowsSeen += n
    return n
  }

  /** Additive `+=` for a 16-bit PACKED cloud + the present channel payloads (aligned by index). */
  appendPacked(packed: Uint16Array, meta: PackMeta, ch?: ChannelAppend): number {
    const n = packed.length >> 1
    const { bounds, width: w, height: h, count, cells, sum, sumSq, sketch, catCount, K, hll } = this
    const labels = ch?.labels
    const values = ch?.values
    for (let i = 0; i < n; i++) {
      const x = meta.originX + packed[i * 2] * meta.scaleX
      const y = meta.originY + packed[i * 2 + 1] * meta.scaleY
      const cell = cellForPoint(x, y, bounds, w, h)
      if (cell < 0) continue
      count[cell] += 1
      if (sum && values) {
        const v = values[i]
        if (Number.isFinite(v)) {
          sum[cell] += v
          if (sumSq) sumSq[cell] += v * v
        }
        if (sketch) sketch.update(v)
      }
      if (catCount && labels) {
        const c = labels[i]
        if (c >= 0 && c < K) catCount[c * cells + cell] += 1
        if (hll && c >= 0) hll.add(hash32(c))
      }
    }
    this.rowsSeen += n
    return n
  }

  /**
   * Re-bind a NEW continuous column over RESIDENT positions WITHOUT touching `count`/`catCount` —
   * the matrix "bind-a-column" primitive (item 14). Bins `positions` into the value grids
   * (`sum`/`sumSq`) + feeds the KLL, leaving the density `count` grid object untouched (mean =
   * `sum/count` still divides by the resident count). Call {@link resetValueChannel} first to swap
   * columns. No-op when no value channel is configured.
   */
  accumulateValueOnly(positions: Float32Array, values: Float32Array | Float64Array): void {
    const { sum } = this
    if (!sum) return
    const { bounds, width: w, height: h, sumSq, sketch } = this
    const n = Math.min(positions.length >> 1, values.length)
    for (let i = 0; i < n; i++) {
      const cell = cellForPoint(positions[i * 2], positions[i * 2 + 1], bounds, w, h)
      if (cell < 0) continue
      const v = values[i]
      if (Number.isFinite(v)) {
        sum[cell] += v
        if (sumSq) sumSq[cell] += v * v
      }
      if (sketch) sketch.update(v)
    }
  }

  /** Zero the value channel (`sum`/`sumSq` + a fresh KLL) so a NEW column can be re-accumulated over
   *  the resident positions/count. No-op when no value channel is configured. */
  resetValueChannel(): void {
    if (!this.sum) return
    this.sum.fill(0)
    if (this.sumSq) this.sumSq.fill(0)
    this.sketch = new KllSketch(this.sketchK, this.rng)
  }

  /** The current count grid (row-major, length width*height). */
  counts(): Float64Array {
    return this.count
  }

  /** The value SUM grid (Σ finite values per cell), or `null` when no value channel. */
  sums(): Float64Array | null {
    return this.sum
  }

  /** The value SUM-OF-SQUARES grid, or `null` when variance is not tracked. */
  sumSquares(): Float64Array | null {
    return this.sumSq
  }

  /** The category-major count grids (`catCount[k*cells+cell]`), or `null` when no category channel. */
  categoryCounts(): Float64Array | null {
    return this.catCount
  }

  /** Per-cell ARGMAX category index (row-major, `-1` for an empty cell), or `null` when no category
   *  channel. Ties resolve to the lowest index (matches {@link shadeCategory}). */
  categoryArgmax(): Int32Array | null {
    if (!this.catCount) return null
    const out = new Int32Array(this.cells).fill(-1)
    for (let cell = 0; cell < this.cells; cell++) {
      let best = -1
      let bestV = 0
      for (let k = 0; k < this.K; k++) {
        const v = this.catCount[k * this.cells + cell]
        if (v > bestV) {
          bestV = v
          best = k
        }
      }
      out[cell] = best
    }
    return out
  }

  /** Approximate `q`-quantile of the value channel (from the KLL sketch). NaN with no value channel. */
  valueQuantile(q: number): number {
    return this.sketch ? this.sketch.quantile(q) : Number.NaN
  }

  /** The value color-scale domain `[p1, p99]` from the KLL sketch (`[0,1]` fallback when empty).
   *  Delegates to the shared `kllDomain` so the raster + the GRID progressive path (ITEM-11) derive
   *  a byte-identical domain from a sketch. */
  valueDomain(): [number, number] {
    return this.sketch ? kllDomain(this.sketch) : [0, 1]
  }

  /** Approximate distinct-label count (from the HLL), or `null` when not tracked. */
  distinctLabels(): number | null {
    return this.hll ? this.hll.estimate() : null
  }

  /**
   * Shade the accumulator-so-far for a channel `mode` (default `'density'`). `density` reuses
   * `shadeCounts` (byte-identical to `DensityAccumulator`); `value` shades the mean over the
   * sketch-derived `[p1,p99]` scale; `category` shades the per-cell argmax hue. EMA/`final` behave
   * exactly as `DensityAccumulator.shade` (a `final` frame is EXACT + not retained as the blend base).
   */
  shade(opts: ChannelShadeOptions = {}): RasterImage {
    const isFinal = opts.final === true
    const ema = isFinal ? 0 : (opts.ema ?? 0)
    const mode = opts.mode ?? 'density'
    let image: RasterImage
    if (mode === 'value') {
      const domain = opts.valueDomain ?? this.valueDomain()
      image = shadeValue(this.sum ?? new Float64Array(this.cells), this.count, this.width, this.height, {
        colormap: opts.colormap,
        domain,
        alpha: opts.alpha,
        flipY: opts.flipY,
        ema,
        prevRgba: this.prevRgba,
      })
    } else if (mode === 'category') {
      image = shadeCategory(
        this.catCount ?? new Float64Array(this.cells),
        Math.max(1, this.K),
        this.width,
        this.height,
        {
          palette: opts.palette,
          normalize: opts.normalize,
          minLightness: opts.minLightness,
          alpha: opts.alpha,
          flipY: opts.flipY,
          ema,
          prevRgba: this.prevRgba,
        },
      )
    } else {
      image = shadeCounts(this.count, this.width, this.height, {
        colormap: opts.colormap,
        normalize: opts.normalize,
        alpha: opts.alpha,
        flipY: opts.flipY,
        ema,
        prevRgba: this.prevRgba,
      })
    }
    if (!isFinal) this.prevRgba = Uint8ClampedArray.from(image.rgba)
    return image
  }
}
