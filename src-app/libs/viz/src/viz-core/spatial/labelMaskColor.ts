// labelMaskColor.ts — PURE helpers for the GPU label-mask layer. A label mask is a
// single-channel raster where each pixel value IS an integer label id (0 = background).
// Coloring a label mask by category is a texture-lookup on the GPU, NOT a CPU polygon
// tessellation:
//
//   • `buildIdColorLut(categoryForId, …)` bakes the id→category→RGBA mapping into a
//     small, texture-ready `Uint8Array` (a packed 2-D LUT). The fragment shader
//     samples it by label id — so recolor-by-category = rebuild this O(numLabels) LUT,
//     never an O(pixels) pass. id 0 (background) is always transparent.
//   • `encodeLabelMaskRGBA(labelMask, w, h)` packs each integer id into the rgb bytes
//     of an RGBA raster (id = r + g·256 + b·65536), the form the label TEXTURE is
//     uploaded in (sampled NEAREST). `decodeIdFromRGB` is its inverse — the exact
//     GLSL the shader runs, in JS, so the encode/decode round-trip is unit-testable.
//   • `boundaryMask(labelMask, w, h)` is the CPU ORACLE for the in-shader stroke: a
//     non-background pixel is a boundary iff any 4-neighbour has a DIFFERENT id.
//     Out-of-image neighbours are treated as the pixel's own id (matching the GPU's
//     clamp-to-edge sampling), so the image border is not spuriously an edge.
//
// Framework-agnostic (viz-core): no GL, no I/O, no domain assumptions — a label is just a
// labelled region; the same layer overlays any integer-labelled raster.

import { CATEGORICAL_PALETTE } from '../data/color'

/** A categorical palette: stable RGB triple per category code (see data/color.ts). */
export type Palette = readonly (readonly [number, number, number])[]

/** The default categorical palette (the shared colorblind-safe one from data/color.ts). */
export const CATEGORICAL_PALETTE_DEFAULT: Palette = CATEGORICAL_PALETTE

/** Any integer label raster (id per pixel, row-major, 0 = background). */
export type LabelMask = Uint8Array | Uint16Array | Uint32Array | Int32Array

/** A texture-ready RGBA LUT: `data` (length width·height·4) + its packing dims. */
export interface IdColorLut {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** LUT packing width — ids wrap onto successive rows once they exceed this. */
export const LUT_PACK_WIDTH = 256

/** Pack an integer id into an `[r, g, b]` byte triple (id = r + g·256 + b·65536). */
export function packIdToRGB(id: number): [number, number, number] {
  const i = id | 0
  return [i & 255, (i >>> 8) & 255, (i >>> 16) & 255]
}

/** Decode an id from packed rgb bytes — the JS twin of the shader's `lm_decodeId`. */
export function decodeIdFromRGB(r: number, g: number, b: number): number {
  return (r | 0) + (g | 0) * 256 + (b | 0) * 65536
}

/** Options for {@link buildIdColorLut} — palette + the ITEM-11 class-visibility filters. */
export interface BuildIdColorLutOpts {
  /** categorical palette (default the shared categorical palette). */
  palette?: Palette
  /**
   * Categories to HIDE: every id whose `categoryForId[id]` is in this set gets LUT alpha 0
   * (invisible) while keeping every other id unchanged. A LUT-only edit — the id→pixel raster
   * is never touched, so a class toggle is an O(numLabels) rebuild, not an O(pixels) re-upload
   * (ITEM-11). Ignored when `soloCategory` is set (solo takes precedence).
   */
  hiddenCategories?: Set<number> | null
  /**
   * SOLO one category: when set (non-null), ONLY ids of this category are visible (alpha 255);
   * every other id gets alpha 0. Overrides `hiddenCategories`.
   */
  soloCategory?: number | null
}

/**
 * Build the id→RGBA color LUT for coloring each labelled region by its CATEGORY.
 *
 * `categoryForId[id]` is the category code of region `id` (index 0 = background, ignored).
 * Region `id` (≥1) gets `palette[categoryForId[id] % palette.length]` at full alpha; id 0
 * is transparent `[0,0,0,0]`. The result is packed row-major into a `LUT_PACK_WIDTH`-wide
 * 2-D texture so a per-pixel id addresses its color at
 * `(mod(id,width)+0.5)/width, (floor(id/width)+0.5)/height` with NEAREST filtering.
 *
 * ITEM-11 (additive, back-compat — callers passing only `{palette}` are unaffected): pass
 * `hiddenCategories` / `soloCategory` to make whole classes invisible by writing LUT alpha 0
 * for their ids. This is a class-visibility toggle done entirely in the color LUT, never in
 * the pixel raster.
 */
export function buildIdColorLut(
  categoryForId: Uint16Array,
  opts: BuildIdColorLutOpts = {},
): IdColorLut {
  const palette = opts.palette ?? CATEGORICAL_PALETTE
  const hidden = opts.hiddenCategories
  const solo = opts.soloCategory
  const soloActive = solo != null
  const n = Math.max(1, categoryForId.length)
  const width = Math.max(1, Math.min(LUT_PACK_WIDTH, n))
  const height = Math.max(1, Math.ceil(n / width))
  const data = new Uint8Array(width * height * 4)
  // id 0 stays background (all zero → transparent). Color ids 1..n-1 by their category.
  for (let id = 1; id < categoryForId.length; id++) {
    const category = categoryForId[id]
    const [r, g, b] = palette[category % palette.length]
    // Solo (if active) shows ONLY its category; otherwise hide any category in the hidden set.
    const visible = soloActive ? category === solo : !(hidden != null && hidden.has(category))
    const o = id * 4
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    data[o + 3] = visible ? 255 : 0
  }
  return { data, width, height }
}

/**
 * Encode a label mask into an RGBA raster (id packed into rgb; alpha 255). This is the
 * form uploaded as the label TEXTURE (NEAREST), from which the shader decodes the id per
 * pixel. Length of the returned array is `w·h·4`.
 */
export function encodeLabelMaskRGBA(labelMask: LabelMask, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const n = Math.min(labelMask.length, w * h)
  for (let i = 0; i < n; i++) {
    const [r, g, b] = packIdToRGB(labelMask[i])
    const o = i * 4
    out[o] = r
    out[o + 1] = g
    out[o + 2] = b
    out[o + 3] = 255
  }
  return out
}

/**
 * CPU oracle for the in-shader boundary/stroke. Returns a `0/1` mask (row-major, length
 * `w·h`): 1 where a NON-background pixel has a 4-neighbour with a different id. Neighbours
 * off the image edge are treated as the pixel's own id (clamp-to-edge), so a region touching
 * the image border is not falsely outlined there — matching the GPU texture sampling.
 */
export function boundaryMask(labelMask: LabelMask, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      const id = labelMask[idx]
      if (id === 0) continue // background is never a boundary
      const l = x > 0 ? labelMask[idx - 1] : id
      const r = x < w - 1 ? labelMask[idx + 1] : id
      const u = y > 0 ? labelMask[idx - w] : id
      const d = y < h - 1 ? labelMask[idx + w] : id
      if (l !== id || r !== id || u !== id || d !== id) out[idx] = 1
    }
  }
  return out
}
