// imageMeta.ts — PURE parsing of OME-NGFF-style `multiscales` metadata into a
// normalized shape the Viv spatial view consumes, plus the affine composition that
// places a full-resolution image into GLOBAL micron space as a deck.gl `modelMatrix`.
//
// Framework-agnostic (viz-core): no @deck.gl / react / @ziee imports — just the
// existing 2×3 `Affine` model (`../data/image`) and its GPU flattening
// (`../data/affineMatrix`). DEC-28 generic naming: this file knows about
// images/channels/levels, nothing about biology.
//
// OME-NGFF background (spec 0.4): a multiscale image is a group whose `.zattrs`
// carries a `multiscales` block — an ordered list of `datasets` (index 0 = highest
// resolution) each with a per-level `coordinateTransformations` (a `scale` and/or
// `translation` mapping ARRAY indices → PHYSICAL coordinates in the axes' units,
// typically microns), plus a shared `axes` ordering (a permutation of t/c/z/y/x).
// Per-level pixel dimensions live in each level's `.zarray` `shape` — NOT in the
// multiscales block — so callers pass an `arrays` map (path → {shape, dtype}); this
// mirrors exactly what Viv's own `loadOmeZarr` assembles. `omero.channels` (when
// present) carries per-channel label / hex color / default intensity window.

import { affineToModelMatrix } from '../data/affineMatrix'
import type { Affine } from '../data/image'

// ── NGFF input shapes (the subset we read) ───────────────────────────────────

export interface NgffAxis {
  /** axis name — 't' | 'c' | 'z' | 'y' | 'x' by NGFF convention. */
  name: string
  type?: 'time' | 'channel' | 'space' | string
  unit?: string
}

export type NgffTransform =
  | { type: 'scale'; scale: number[] }
  | { type: 'translation'; translation: number[] }
  | { type: 'identity' }

export interface NgffDataset {
  /** the level's array path within the group (e.g. "0", "1", …). */
  path: string
  /** array-index → physical mapping for THIS level (scale/translation). */
  coordinateTransformations?: NgffTransform[]
}

export interface NgffMultiscale {
  version?: string
  name?: string
  axes: NgffAxis[]
  /** highest-resolution first. */
  datasets: NgffDataset[]
  /** transforms applied to EVERY dataset (composed after the per-dataset one). */
  coordinateTransformations?: NgffTransform[]
}

export interface NgffOmeroChannel {
  label?: string
  /** 6-hex RGB, no leading '#'. */
  color?: string
  window?: { start: number; end: number; min?: number; max?: number }
}

export interface NgffOmero {
  channels: NgffOmeroChannel[]
}

/** Per-level array metadata, from each dataset's `.zarray`. */
export interface NgffArrayMeta {
  shape: number[]
  /** a Viv `SupportedDtype`: 'Uint8' | 'Uint16' | 'Uint32' | 'Float32' | 'Int8' | … */
  dtype: string
}

/** A whole multiscale image: the `multiscales` attrs + optional omero + per-level arrays. */
export interface NgffImage {
  multiscales: NgffMultiscale[]
  omero?: NgffOmero
  /** array metadata keyed by dataset `path`. */
  arrays: Record<string, NgffArrayMeta>
}

// ── normalized output ────────────────────────────────────────────────────────

export interface ImageLevel {
  path: string
  width: number
  height: number
  /** physical size per pixel at THIS level, `[sx, sy]` (units-per-pixel; usually microns). */
  scale: readonly [number, number]
  /**
   * physical translation of this level's origin, `[tx, ty]` (same units as `scale`).
   * NGFF `translation` transforms; 0 when absent.
   */
  translation: readonly [number, number]
  /** integer downsample factor vs level 0, by width (1, 2, 4, …). */
  downsample: number
}

export interface ImageChannel {
  name: string
  /** default RGB 0-255 (from `omero.channels[].color`), if given. */
  color?: readonly [number, number, number]
  /** default contrast window `[begin, end]` (from `omero.channels[].window`), if given. */
  window?: readonly [number, number]
}

export interface AxisIndex {
  t?: number
  c?: number
  z?: number
  /** required — an image has y and x. */
  y: number
  x: number
}

export interface NormalizedImageMeta {
  /** index 0 = full resolution (largest). */
  levels: ImageLevel[]
  channels: ImageChannel[]
  dtype: string
  /** axis name → index into each level's `shape` / a transform's `scale`/`translation`. */
  axisIndex: AxisIndex
}

// ── parse ─────────────────────────────────────────────────────────────────────

function indexAxes(axes: NgffAxis[]): AxisIndex {
  const idx: Record<string, number> = {}
  axes.forEach((a, i) => {
    idx[a.name] = i
  })
  if (idx.y == null || idx.x == null) {
    throw new Error('imageMeta: `axes` must include both "y" and "x"')
  }
  return { t: idx.t, c: idx.c, z: idx.z, y: idx.y, x: idx.x }
}

/** Product of all `scale` transforms at `axisI` (default 1 — identity). */
function scaleAt(transforms: NgffTransform[] | undefined, axisI: number): number {
  if (!transforms) return 1
  let s = 1
  for (const t of transforms) {
    if (t.type === 'scale') s *= t.scale[axisI] ?? 1
  }
  return s
}

/** Sum of all `translation` transforms at `axisI` (default 0 — no shift). */
function translationAt(transforms: NgffTransform[] | undefined, axisI: number): number {
  if (!transforms) return 0
  let tr = 0
  for (const t of transforms) {
    if (t.type === 'translation') tr += t.translation[axisI] ?? 0
  }
  return tr
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function parseChannels(img: NgffImage, ms: NgffMultiscale, axisIndex: AxisIndex): ImageChannel[] {
  const omeroChannels = img.omero?.channels
  if (omeroChannels && omeroChannels.length > 0) {
    return omeroChannels.map((ch, i) => ({
      name: ch.label ?? `Channel ${i}`,
      color: ch.color ? hexToRgb(ch.color) : undefined,
      window: ch.window ? ([ch.window.start, ch.window.end] as const) : undefined,
    }))
  }
  // No omero: derive the channel count from the 'c' axis size of level 0 (or 1).
  const cIdx = axisIndex.c
  const level0 = img.arrays[ms.datasets[0]?.path ?? '']
  const count = cIdx != null ? (level0?.shape[cIdx] ?? 1) : 1
  return Array.from({ length: count }, (_, i) => ({ name: `Channel ${i}` }))
}

/**
 * Parse an NGFF-style multiscale image into `NormalizedImageMeta`. Reads the FIRST
 * `multiscales` entry (the standard single-image case). Throws on a missing
 * multiscales entry, missing y/x axes, or a dataset with no matching array metadata
 * (a malformed pyramid — better to fail loudly than mis-place the image).
 */
export function parseMultiscales(img: NgffImage): NormalizedImageMeta {
  const ms = img.multiscales?.[0]
  if (!ms) throw new Error('imageMeta: no `multiscales` entry')
  const axisIndex = indexAxes(ms.axes)

  const arrayFor = (path: string): NgffArrayMeta => {
    const arr = img.arrays[path]
    if (!arr) throw new Error(`imageMeta: no array metadata for dataset path "${path}"`)
    return arr
  }

  const width0 = arrayFor(ms.datasets[0].path).shape[axisIndex.x]

  const levels: ImageLevel[] = ms.datasets.map(ds => {
    const arr = arrayFor(ds.path)
    const width = arr.shape[axisIndex.x]
    const height = arr.shape[axisIndex.y]
    // per-dataset transform composed with the shared multiscale-level transform.
    const sx = scaleAt(ds.coordinateTransformations, axisIndex.x) * scaleAt(ms.coordinateTransformations, axisIndex.x)
    const sy = scaleAt(ds.coordinateTransformations, axisIndex.y) * scaleAt(ms.coordinateTransformations, axisIndex.y)
    const tx = translationAt(ds.coordinateTransformations, axisIndex.x) + translationAt(ms.coordinateTransformations, axisIndex.x)
    const ty = translationAt(ds.coordinateTransformations, axisIndex.y) + translationAt(ms.coordinateTransformations, axisIndex.y)
    return {
      path: ds.path,
      width,
      height,
      scale: [sx, sy] as const,
      translation: [tx, ty] as const,
      downsample: width0 / width,
    }
  })

  const dtype = arrayFor(ms.datasets[0].path).dtype
  const channels = parseChannels(img, ms, axisIndex)
  return { levels, channels, dtype, axisIndex }
}

// ── affine composition (element pixel → global microns) ──────────────────────

/**
 * The level-0 pixel → element-local-micron affine: the full-resolution physical
 * scale + translation as a 2×3 `Affine` (`x' = sx·x + tx ; y' = sy·y + ty`). This is
 * the NGFF `coordinateTransformations` of the finest level expressed in OUR affine
 * model, so it flows through `affineToModelMatrix` exactly like a registration affine.
 */
export function pixelSizeAffine(meta: NormalizedImageMeta): Affine {
  const lvl0 = meta.levels[0]
  const [sx, sy] = lvl0.scale
  const [tx, ty] = lvl0.translation
  return [sx, 0, tx, 0, sy, ty]
}

/**
 * Compose two 2×3 affines as `outer ∘ inner` — apply `inner` first, then `outer`
 * (matrix product `outer · inner` on the homogeneous 3×3 form). Used to fold an
 * element→global registration affine over the pixel→element scale so a single
 * modelMatrix carries full-res pixels all the way into global micron space.
 */
export function composeAffine2(outer: Affine, inner: Affine): Affine {
  const [a0, a1, a2, a3, a4, a5] = outer
  const [b0, b1, b2, b3, b4, b5] = inner
  return [
    a0 * b0 + a1 * b3,
    a0 * b1 + a1 * b4,
    a0 * b2 + a1 * b5 + a2,
    a3 * b0 + a4 * b3,
    a3 * b1 + a4 * b4,
    a3 * b2 + a4 * b5 + a5,
  ]
}

/**
 * The deck.gl `modelMatrix` (16-element **column-major**) placing this image's
 * full-resolution pixel grid into GLOBAL micron space. `elementAffine` (default
 * identity) is the element-local-micron → global-micron registration — the same
 * layout↔image affine model used elsewhere in viz-core — composed OVER the level-0
 * pixel→micron scale from the NGFF metadata. Viv's multiscale layer handles the
 * per-level downsample internally, so this matrix is expressed for level 0 only.
 */
export function imageModelMatrix(meta: NormalizedImageMeta, elementAffine?: Affine): number[] {
  const pixToMicron = pixelSizeAffine(meta)
  const full = elementAffine ? composeAffine2(elementAffine, pixToMicron) : pixToMicron
  return affineToModelMatrix(full)
}
