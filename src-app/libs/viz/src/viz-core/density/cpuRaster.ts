// cpuRaster.ts — the A1 "bin-then-shade" CPU raster primitive (PERFORMANCE_PLAN.md Phase 1).
// On a SOFTWARE renderer, drawing N GL_POINTS is O(N × a huge per-point constant); binning
// those points into a W×H count grid on the CPU and drawing the shaded grid as ONE textured
// quad (a deck.gl `BitmapLayer`) is O(pixels) — independent of N. That swap is the whole
// software unlock; this module produces the shaded RGBA the quad samples.
//
// It is PURE + framework-agnostic (no deck.gl / React / DOM), so it unit-tests in node and the
// count grid is checkable against a hand oracle. It REUSES the existing spatial-histogram
// oracle `binDensity` (density/densityBin.ts) for the binning — NOT a new histogram — and the
// existing 256-entry colormap LUT (`buildColormapLUT`, gpu/colormapLut.ts) for the shading, so
// a raster cell's color is byte-consistent with a scatter point / the DOM colorbar of the same
// weight. (The Phase-1 plan text calls the binning oracle "densify"; the actual 2D
// spatial-histogram oracle in this codebase is `binDensity` — `data/wire.ts::densify` is the
// unrelated sparse→dense column projection. This module uses `binDensity`, the correct one.)

import { binDensity, binDensityPacked, cellForPoint, type DensityBounds } from './densityBin'
import { buildColormapLUT, LUT_SIZE } from '../gpu/colormapLut'
import {
  DEFAULT_CONTINUOUS_COLORMAP,
  CATEGORICAL_PALETTE,
  extendPalette,
  scaleLightness,
  type ContinuousColormap,
} from '../data/color'
import type { PackMeta } from './quantize'

/** How per-cell COUNTS are normalized to a [0,1] shade weight before the colormap. */
export type RasterNormalize = 'log' | 'linear' | 'histeq'

export const DEFAULT_RASTER_NORMALIZE: RasterNormalize = 'log'

/**
 * Normalize a per-cell COUNT array into a `[0,1]` shade weight (row-major, same order/length as
 * `counts`). EMPTY cells (count ≤ 0) always map to exactly `0`. Every mode is MONOTONIC
 * NON-DECREASING in the count, so a denser cell is never shaded lower than a sparser one:
 *   • `linear` — `count / maxCount`.
 *   • `log`    — `log1p(count) / log1p(maxCount)` (compresses the heavy tail so sparse
 *                structure is still visible next to a few very dense cells; the default).
 *   • `histeq` — histogram equalization over POPULATED cells: a count's weight is the fraction
 *                of populated cells with a count ≤ it (its CDF), spreading the used shade range
 *                evenly. Ties share a weight; the densest cell maps to `1`.
 * An all-empty grid returns all-zeros.
 */
export function normalizeCounts(
  counts: ArrayLike<number>,
  mode: RasterNormalize = DEFAULT_RASTER_NORMALIZE,
): Float32Array {
  const n = counts.length
  const out = new Float32Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const c = counts[i]
    if (c > max) max = c
  }
  if (max <= 0) return out

  if (mode === 'linear') {
    for (let i = 0; i < n; i++) {
      const c = counts[i]
      out[i] = c > 0 ? c / max : 0
    }
    return out
  }

  if (mode === 'log') {
    const denom = Math.log1p(max)
    for (let i = 0; i < n; i++) {
      const c = counts[i]
      out[i] = c > 0 ? Math.log1p(c) / denom : 0
    }
    return out
  }

  // histeq: CDF over populated cells' counts.
  const freq = new Map<number, number>()
  let populated = 0
  for (let i = 0; i < n; i++) {
    const c = counts[i]
    if (c > 0) {
      freq.set(c, (freq.get(c) ?? 0) + 1)
      populated++
    }
  }
  const uniq = Array.from(freq.keys()).sort((a, b) => a - b)
  const cdf = new Map<number, number>()
  let cum = 0
  for (const v of uniq) {
    cum += freq.get(v) as number
    cdf.set(v, cum / populated)
  }
  for (let i = 0; i < n; i++) {
    const c = counts[i]
    out[i] = c > 0 ? (cdf.get(c) as number) : 0
  }
  return out
}

/** Inputs to `binAndShade`. */
export interface BinAndShadeParams {
  /** interleaved xy Float32Array, length N*2. */
  readonly positions: Float32Array
  /** the world-space rectangle the grid tiles over (points outside are dropped). */
  readonly bounds: DensityBounds
  /** grid columns (guarded to ≥ 1). */
  readonly width: number
  /** grid rows (guarded to ≥ 1). */
  readonly height: number
  /** continuous colormap for the shading (default viridis). */
  readonly colormap?: ContinuousColormap
  /** count→weight normalization (default `log`). */
  readonly normalize?: RasterNormalize
  /** alpha for populated cells, 0-255 (default 255). Empty cells are always fully transparent. */
  readonly alpha?: number
  /**
   * Emit rows TOP-FIRST (row 0 → the `bounds.maxY` edge) so the buffer drops straight into a
   * deck.gl `BitmapLayer` (`bounds=[minX,minY,maxX,maxY]`, image drawn top-down) upright.
   * Default `true`. Pass `false` to keep the NATURAL bin order (row 0 → `bounds.minY`), which
   * matches the `binDensity` oracle row order for correctness testing.
   */
  readonly flipY?: boolean
}

/** A shaded raster ready for a `BitmapLayer.image` (raw RGBA, row-major, length width*height*4). */
export interface RasterImage {
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** The two shapes a deck.gl `BitmapLayer.image` accepts from this module: a browser `ImageData`
 *  (the reliable RGBA-texture upload) or, under SSR/node where `ImageData` is undefined, the raw
 *  `{ data, width, height }` object (never actually rendered off-DOM). */
export type BitmapLayerImage =
  | ImageData
  | { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }

/**
 * Wrap a shaded {@link RasterImage} into the `BitmapLayer.image` value.
 *
 * deck.gl v9's `BitmapLayer` uploads a raw `{ data, width, height }` object as a texture whose RGB
 * channels come out ZERO — the raster renders as a BLACK quad (only the alpha channel survives), even
 * though the source RGBA is a correct viridis shade. Wrapping the bytes in an `ImageData` uploads a
 * proper RGBA texture (the same fix `HeatmapView`/`heatmapExtras` already use for their bitmap tracks).
 * Under SSR/node (`ImageData` undefined) the raw object is returned unchanged — that path is never
 * rendered. The bytes are copied into a fresh `Uint8ClampedArray` (a plain-`ArrayBuffer`-backed copy,
 * the shape `ImageData` requires — the retained raster's buffer may be `ArrayBufferLike`), mirroring
 * `HeatmapView`'s proven bitmap upload.
 */
export function toBitmapImage(image: RasterImage): BitmapLayerImage {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height)
  }
  return { data: image.rgba, width: image.width, height: image.height }
}

/**
 * Bin `positions` into a `width × height` count grid over `bounds` (via `binDensity`), normalize
 * the counts to a shade weight, and map through the colormap LUT into an RGBA raster. Empty
 * cells render fully transparent (the density reads as bins-over-nothing, not a filled rect).
 * Pure — no allocation beyond the output + the (cheap) count grid; safe to call off the main
 * thread. Reuses `binDensity` + `buildColormapLUT`, so counts + colors match the GPU paths.
 */
export function binAndShade(params: BinAndShadeParams): RasterImage {
  const w = Math.max(1, Math.floor(params.width))
  const h = Math.max(1, Math.floor(params.height))
  const { count } = binDensity(params.positions, null, params.bounds, w, h)
  return shadeCounts(count, w, h, params)
}

/** Inputs to `binAndShadePacked` — `binAndShade` with the Float32 `positions` swapped for the
 *  16-bit `packed` codes + their decode `meta` (`quantize.ts`). Everything else is identical. */
export interface BinAndShadePackedParams extends Omit<BinAndShadeParams, 'positions'> {
  /** interleaved xy `Uint16` codes, length N*2. */
  readonly packed: Uint16Array
  /** the per-axis decode map the codes were packed with. */
  readonly meta: PackMeta
}

/**
 * The PACKED-position twin of {@link binAndShade}: bins the 16-bit `packed` cloud via
 * `binDensityPacked` (decoding coords on the fly — no 8 B/point unpack) and shades identically.
 * The output matches `binAndShade` on the Float32 source up to the quantization step
 * (`span / 65535`, invisible at the raster cell size). Halves the bytes the worker transfers.
 */
export function binAndShadePacked(params: BinAndShadePackedParams): RasterImage {
  const w = Math.max(1, Math.floor(params.width))
  const h = Math.max(1, Math.floor(params.height))
  const { count } = binDensityPacked(params.packed, params.meta, null, params.bounds, w, h)
  return shadeCounts(count, w, h, params)
}

/** Options for the shared shading tail. `prevRgba`/`ema` are the STREAMING_PROGRESSIVE_PLAN Wave-2a
 *  anti-flicker seam — ABSENT (the whole-array path) ⇒ byte-for-byte unchanged. */
export interface ShadeCountsOptions {
  readonly colormap?: ContinuousColormap
  readonly normalize?: RasterNormalize
  readonly alpha?: number
  readonly flipY?: boolean
  /** EMA blend: retention weight of `prevRgba`, `[0,1)`. `0`/undefined = exact current shade. */
  readonly ema?: number
  /** The previous frame's RGBA (same geometry) to EMA-blend toward. `null`/undefined = no blend. */
  readonly prevRgba?: Uint8ClampedArray | null
}

/** Shared shading tail: normalize a count grid → RGBA raster. Extracted so the Float32 and
 *  packed bin paths shade IDENTICALLY (the Float32 path is byte-for-byte unchanged). EXPORTED for
 *  the progressive accumulator (`density/accumulator.ts`), which shades the count grid it grows.
 *
 *  Anti-flicker: when `prevRgba` is supplied and `ema > 0`, each output channel is
 *  `round(prev*ema + cur*(1-ema))` — the image is damped toward the last frame so it does not
 *  re-level/flash on every batch. With no `prevRgba`/`ema` the output is the EXACT current shade
 *  (so a completed/one-shot raster is unchanged). Accepts a Float32 OR Float64 count grid (the
 *  accumulator uses float64; counts are integer-exact in both). */
export function shadeCounts(
  count: ArrayLike<number>,
  w: number,
  h: number,
  opts: ShadeCountsOptions,
): RasterImage {
  const colormap = opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP
  const normalize = opts.normalize ?? DEFAULT_RASTER_NORMALIZE
  const alpha = opts.alpha ?? 255
  const flipY = opts.flipY ?? true
  const prev = opts.prevRgba
  const ema = prev != null && opts.ema != null && opts.ema > 0 ? Math.min(1, opts.ema) : 0
  const keep = ema // retention of the previous frame
  const take = 1 - ema // weight of the current frame

  const weight = normalizeCounts(count, normalize)
  const lut = buildColormapLUT(colormap) // Uint8Array, LUT_SIZE*4 RGBA
  const kMax = LUT_SIZE - 1

  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcRowBase = row * w
    const dstRow = flipY ? h - 1 - row : row
    const dstRowBase = dstRow * w
    for (let col = 0; col < w; col++) {
      const src = srcRowBase + col
      const o = (dstRowBase + col) * 4
      if (count[src] <= 0) {
        // Empty CURRENT cell → transparent target (RGBA 0,0,0,0). Under EMA, decay a previously
        // painted pixel toward transparent instead of a hard cut (still ends at 0 as ema<1).
        if (ema > 0 && prev != null) {
          rgba[o] = prev[o] * keep
          rgba[o + 1] = prev[o + 1] * keep
          rgba[o + 2] = prev[o + 2] * keep
          rgba[o + 3] = prev[o + 3] * keep
        }
        continue // else leave transparent
      }
      let k = (weight[src] * kMax) | 0
      if (k < 0) k = 0
      else if (k > kMax) k = kMax
      const l = k * 4
      if (ema > 0 && prev != null) {
        rgba[o] = prev[o] * keep + lut[l] * take
        rgba[o + 1] = prev[o + 1] * keep + lut[l + 1] * take
        rgba[o + 2] = prev[o + 2] * keep + lut[l + 2] * take
        rgba[o + 3] = prev[o + 3] * keep + alpha * take
      } else {
        rgba[o] = lut[l]
        rgba[o + 1] = lut[l + 1]
        rgba[o + 2] = lut[l + 2]
        rgba[o + 3] = alpha
      }
    }
  }
  return { rgba, width: w, height: h }
}

// ── MULTI-CHANNEL shade (STREAMING_PROGRESSIVE_PLAN Wave 2b, items 5/6) ──────────────────────────
// The density path above (`shadeCounts`) is UNTOUCHED (byte-identical). These add two ADDITIONAL
// shade modes over the same additive grids the accumulator grows:
//   • `shadeValue`   — a CONTINUOUS channel: mean = Σvalue/count per cell, normalized by an explicit
//                      value `domain` ([p1,p99] from a KLL sketch at the call site), → the colormap.
//   • shadeCategory  — a CATEGORY channel: per-cell ARGMAX category → its palette hue, lightness-
//                      modulated by the (normalized) cell total so a sparse cell still shows its hue.
// Both share the EMA anti-flicker seam (`prevRgba`/`ema`) with `shadeCounts` (same pixel math), so a
// value/category stream damps identically; a `final` frame (ema absent) is the EXACT shade.

/** The channel a shade reads from the accumulator. `'density'` = the UNCHANGED count path. */
export type ShadeMode = 'density' | 'value' | 'category'

/** Options for {@link shadeValue}. `domain` is REQUIRED (the caller drives it from the channel's KLL
 *  sketch p1/p99); a degenerate/absent domain maps every populated cell to the colormap low end. */
export interface ShadeValueOptions {
  readonly colormap?: ContinuousColormap
  /** `[lo, hi]` value domain — typically the streaming KLL sketch's `[p1, p99]`. */
  readonly domain?: readonly [number, number]
  readonly alpha?: number
  readonly flipY?: boolean
  readonly ema?: number
  readonly prevRgba?: Uint8ClampedArray | null
}

/**
 * Shade a CONTINUOUS channel: each populated cell's MEAN (`sum/count`, matching `binDensity` +
 * `binWeight('mean')`) is normalized into `domain` (clamped `[0,1]`) and mapped through the colormap
 * LUT. Empty cells (count ≤ 0) render transparent (EMA-decayed under a blend). Accepts Float32 OR
 * Float64 grids (the accumulator uses float64). Reuses `buildColormapLUT` so a value cell's color is
 * byte-consistent with the point/colorbar path.
 */
export function shadeValue(
  sum: ArrayLike<number>,
  count: ArrayLike<number>,
  w: number,
  h: number,
  opts: ShadeValueOptions = {},
): RasterImage {
  const colormap = opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP
  const alpha = opts.alpha ?? 255
  const flipY = opts.flipY ?? true
  const prev = opts.prevRgba
  const ema = prev != null && opts.ema != null && opts.ema > 0 ? Math.min(1, opts.ema) : 0
  const keep = ema
  const take = 1 - ema
  let lo = opts.domain ? opts.domain[0] : 0
  let hi = opts.domain ? opts.domain[1] : 1
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  const span = hi > lo ? hi - lo : 0
  const lut = buildColormapLUT(colormap)
  const kMax = LUT_SIZE - 1

  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcRowBase = row * w
    const dstRow = flipY ? h - 1 - row : row
    const dstRowBase = dstRow * w
    for (let col = 0; col < w; col++) {
      const src = srcRowBase + col
      const o = (dstRowBase + col) * 4
      const c = count[src]
      if (c <= 0) {
        if (ema > 0 && prev != null) {
          rgba[o] = prev[o] * keep
          rgba[o + 1] = prev[o + 1] * keep
          rgba[o + 2] = prev[o + 2] * keep
          rgba[o + 3] = prev[o + 3] * keep
        }
        continue
      }
      const mean = sum[src] / c
      let t = span > 0 ? (mean - lo) / span : 0
      if (t < 0) t = 0
      else if (t > 1) t = 1
      let k = (t * kMax) | 0
      if (k < 0) k = 0
      else if (k > kMax) k = kMax
      const l = k * 4
      if (ema > 0 && prev != null) {
        rgba[o] = prev[o] * keep + lut[l] * take
        rgba[o + 1] = prev[o + 1] * keep + lut[l + 1] * take
        rgba[o + 2] = prev[o + 2] * keep + lut[l + 2] * take
        rgba[o + 3] = prev[o + 3] * keep + alpha * take
      } else {
        rgba[o] = lut[l]
        rgba[o + 1] = lut[l + 1]
        rgba[o + 2] = lut[l + 2]
        rgba[o + 3] = alpha
      }
    }
  }
  return { rgba, width: w, height: h }
}

/** The per-category RGB palette for `k` categories — the built-in colorblind-safe palette
 *  auto-extended (golden-angle) past 20, so a category code always has a stable, distinct hue. */
export function categoryPaletteFor(k: number): [number, number, number][] {
  return extendPalette(CATEGORICAL_PALETTE, Math.max(1, Math.floor(k)))
}

/** Options for {@link shadeCategory}. */
export interface ShadeCategoryOptions {
  /** per-category RGB (length ≥ K). Default = {@link categoryPaletteFor}(K). */
  readonly palette?: readonly (readonly [number, number, number])[]
  /** how the per-cell TOTAL count → a lightness weight (default `log`, like the density shade). */
  readonly normalize?: RasterNormalize
  /** minimum lightness factor for a populated cell so a sparse cell still shows its hue (default 0.4). */
  readonly minLightness?: number
  readonly alpha?: number
  readonly flipY?: boolean
  readonly ema?: number
  readonly prevRgba?: Uint8ClampedArray | null
}

/**
 * Shade a CATEGORY channel from per-category count grids. `catCount` is CATEGORY-MAJOR
 * (`catCount[k * cells + cell]`, `cells === w*h`). Per cell: the ARGMAX category (lowest index wins a
 * tie) picks the base palette hue; the cell TOTAL (Σ over categories), normalized like the density
 * shade, modulates lightness in `[minLightness, 1]` (reusing `scaleLightness` from color.ts). Empty
 * cells render transparent. Shares the EMA seam with `shadeCounts`/`shadeValue`.
 */
export function shadeCategory(
  catCount: ArrayLike<number>,
  K: number,
  w: number,
  h: number,
  opts: ShadeCategoryOptions = {},
): RasterImage {
  const cells = w * h
  const kk = Math.max(1, Math.floor(K))
  const palette = opts.palette ?? categoryPaletteFor(kk)
  const minL = opts.minLightness ?? 0.4
  const alpha = opts.alpha ?? 255
  const flipY = opts.flipY ?? true
  const prev = opts.prevRgba
  const ema = prev != null && opts.ema != null && opts.ema > 0 ? Math.min(1, opts.ema) : 0
  const keep = ema
  const take = 1 - ema

  // Per-cell total + argmax category (single pass over the K grids).
  const total = new Float64Array(cells)
  const argmax = new Int32Array(cells)
  for (let cell = 0; cell < cells; cell++) {
    let best = -1
    let bestV = 0
    let tot = 0
    for (let k = 0; k < kk; k++) {
      const v = catCount[k * cells + cell]
      tot += v
      if (v > bestV) {
        bestV = v
        best = k
      }
    }
    total[cell] = tot
    argmax[cell] = best
  }
  const weight = normalizeCounts(total, opts.normalize ?? DEFAULT_RASTER_NORMALIZE)

  const rgba = new Uint8ClampedArray(cells * 4)
  for (let row = 0; row < h; row++) {
    const srcRowBase = row * w
    const dstRow = flipY ? h - 1 - row : row
    const dstRowBase = dstRow * w
    for (let col = 0; col < w; col++) {
      const src = srcRowBase + col
      const o = (dstRowBase + col) * 4
      const best = argmax[src]
      if (best < 0 || total[src] <= 0) {
        if (ema > 0 && prev != null) {
          rgba[o] = prev[o] * keep
          rgba[o + 1] = prev[o + 1] * keep
          rgba[o + 2] = prev[o + 2] * keep
          rgba[o + 3] = prev[o + 3] * keep
        }
        continue
      }
      const base = palette[best] ?? palette[best % palette.length]
      const factor = minL + (1 - minL) * weight[src]
      const [r, g, b] = scaleLightness(base, factor)
      if (ema > 0 && prev != null) {
        rgba[o] = prev[o] * keep + r * take
        rgba[o + 1] = prev[o + 1] * keep + g * take
        rgba[o + 2] = prev[o + 2] * keep + b * take
        rgba[o + 3] = prev[o + 3] * keep + alpha * take
      } else {
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = alpha
      }
    }
  }
  return { rgba, width: w, height: h }
}

/** Exact `q`-quantile of the FINITE entries of `values` (sorted). Deterministic — the parity oracle
 *  the streaming KLL sketch approximates. Empty → NaN. */
export function exactQuantile(values: ArrayLike<number>, q: number): number {
  const finite: number[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) finite.push(v)
  }
  if (finite.length === 0) return Number.NaN
  finite.sort((a, b) => a - b)
  const qc = q <= 0 ? 0 : q >= 1 ? 1 : q
  const idx = Math.min(finite.length - 1, Math.floor(qc * finite.length))
  return finite[idx]
}

/** Inputs to {@link binAndShadeValue}. */
export interface BinAndShadeValueParams {
  readonly positions: Float32Array
  /** the per-point continuous value column (length N). Non-finite values COUNT the point but add 0. */
  readonly values: Float32Array
  readonly bounds: DensityBounds
  readonly width: number
  readonly height: number
  readonly colormap?: ContinuousColormap
  /** `[lo, hi]` value domain; default = exact `[p1, p99]` of the finite values (the KLL oracle). */
  readonly domain?: readonly [number, number]
  readonly alpha?: number
  readonly flipY?: boolean
}

/**
 * One-shot value raster: bin `positions` + `values` into per-cell `{count, sum}` (FLOAT64, in point
 * order) and {@link shadeValue} the mean. The progressive VALUE-channel oracle: an accumulator fed
 * the same cloud in any chunking, shaded (final) with the SAME `domain`, is BYTE-IDENTICAL to this —
 * both sum in float64 in the same global point order (float addition is order-sensitive, so the
 * oracle must NOT narrow to float32 the way the density `binDensity` does).
 */
export function binAndShadeValue(params: BinAndShadeValueParams): RasterImage {
  const w = Math.max(1, Math.floor(params.width))
  const h = Math.max(1, Math.floor(params.height))
  const cells = w * h
  const count = new Float64Array(cells)
  const sum = new Float64Array(cells)
  const { positions, values, bounds } = params
  const n = Math.min(positions.length >> 1, values.length)
  for (let i = 0; i < n; i++) {
    const cell = cellForPoint(positions[i * 2], positions[i * 2 + 1], bounds, w, h)
    if (cell < 0) continue
    count[cell] += 1
    const v = values[i]
    if (Number.isFinite(v)) sum[cell] += v
  }
  const domain: readonly [number, number] =
    params.domain ?? [exactQuantile(params.values, 0.01), exactQuantile(params.values, 0.99)]
  return shadeValue(sum, count, w, h, {
    colormap: params.colormap,
    domain,
    alpha: params.alpha,
    flipY: params.flipY,
  })
}
