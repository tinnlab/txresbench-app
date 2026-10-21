// coords.ts — the `ImageCoordinateSystem` facade (ITEM-14). ONE call surface that
// maps a point between the image coordinate spaces the editor speaks, so no consumer
// ever inlines `×downsample` level math (the F-FMT-2 drift anti-pattern). Annotations
// are stored canonically in FULL-RESOLUTION pixels (INV-4); every other space is a
// pure affine hop away, folded ONCE per (from→to) pair via `data/image.ts` primitives.
//
// PURITY (INV-1): this file imports only the pure `data/image` affine algebra and the
// pure `spatial/imageMeta` NGFF interpreter — NO deck.gl / react / store / backend.
// The hot render path multiplies the folded affine on the GPU (`affineToModelMatrix`);
// the CPU `transformPositions` here is used only as the test oracle.
//
// The four spaces (`CoordSpace`):
//   • 'fullRes'   — level-0 image pixels; the CANONICAL stored space (INV-4).
//   • { level:n } — pyramid level-n pixels (n=0 ≡ fullRes).
//   • 'physical'  — the NGFF physical space (microns) of the level-0 transform.
//   • 'world'     — global shared space: the element→global registration `elementAffine`
//                   composed over the pixel→physical scale (matches `imageModelMatrix`).
//
// Every hop is composed THROUGH full-res pixels: `affineBetween(from,to)` folds
// `(fullRes→to) ∘ (from→fullRes)` into a single 2×3 affine, so a level→physical or a
// rotation+shear physical→level round-trip is exact and translation-aware (not a naive
// reciprocal — RFC-5 admits rotation/shear, hence `invertAffine`).

import {
  type Affine,
  IDENTITY_AFFINE,
  applyAffine,
  invertAffine,
  transformPositions,
} from '../data/image'
import {
  type NormalizedImageMeta,
  type ImageLevel,
  pixelSizeAffine,
  composeAffine2,
} from '../spatial/imageMeta'

/** A point in whichever `CoordSpace` names it — flat `[x, y]`. */
export type Vec2 = readonly [number, number]

/** The image coordinate spaces the facade maps between. `{ level:n }` is a pyramid
 *  level's pixel grid; `'fullRes'` (= `{ level:0 }`) is the canonical stored space. */
export type CoordSpace = 'physical' | 'fullRes' | 'world' | { readonly level: number }

/** Options for `createImageCoordinateSystem`. */
export interface ImageCoordinateSystemOptions {
  /** element-local(-physical) → global registration affine, folded to define `'world'`
   *  (identity ⇒ `'world'` ≡ `'physical'`). Same layout↔image affine model used across
   *  viz-core; mirrors `imageModelMatrix`'s `elementAffine`. */
  readonly elementAffine?: Affine
}

/** The pure coordinate facade for one image. All methods are level-independent and
 *  fold their affine ONCE — no per-vertex CPU math on the hot path. */
export interface ImageCoordinateSystem {
  /** The single folded 2×3 affine mapping a point from `from`-space to `to`-space. */
  affineBetween(from: CoordSpace, to: CoordSpace): Affine
  /** Map one point `from`→`to`. */
  map(pt: Vec2, from: CoordSpace, to: CoordSpace): [number, number]
  /** Map an interleaved `[x0,y0,x1,y1,…]` position buffer `from`→`to` (the CPU oracle
   *  path; the GPU applies `affineBetween` as a `modelMatrix` instead). */
  mapPositions(positions: Float32Array, from: CoordSpace, to: CoordSpace): Float32Array
}

function isLevel(s: CoordSpace): s is { readonly level: number } {
  return typeof s === 'object' && s !== null && 'level' in s
}

/** A pyramid level's pixel → NGFF-physical affine (`x' = sx·x + tx`). */
function levelToPhysical(level: ImageLevel): Affine {
  const [sx, sy] = level.scale
  const [tx, ty] = level.translation
  return [sx, 0, tx, 0, sy, ty]
}

/**
 * Build the coordinate facade for one image from its normalized NGFF metadata. The
 * facade is pure + reusable — construct once per image cell, then `map`/`affineBetween`
 * are pure lookups over the precomputed base affines.
 */
export function createImageCoordinateSystem(
  meta: NormalizedImageMeta,
  opts?: ImageCoordinateSystemOptions,
): ImageCoordinateSystem {
  const elementAffine = opts?.elementAffine ?? IDENTITY_AFFINE
  // Base hops (all folded through full-res pixels, the canonical space).
  const fullToPhysical = pixelSizeAffine(meta) // fullRes → physical
  const physicalToFull = invertAffine(fullToPhysical) // physical → fullRes
  const fullToWorld = composeAffine2(elementAffine, fullToPhysical) // fullRes → world
  const worldToFull = invertAffine(fullToWorld) // world → fullRes

  /** Affine mapping a point in `space` INTO full-res pixels (the canonical space). */
  function toFullRes(space: CoordSpace): Affine {
    if (space === 'fullRes') return IDENTITY_AFFINE
    if (space === 'physical') return physicalToFull
    if (space === 'world') return worldToFull
    // { level:n } — level pixels → physical → full-res (translation-aware).
    const n = space.level
    const lvl = meta.levels[n]
    if (!lvl) {
      throw new Error(`coords: no pyramid level ${n} (image has ${meta.levels.length} levels)`)
    }
    return composeAffine2(physicalToFull, levelToPhysical(lvl))
  }

  function affineBetween(from: CoordSpace, to: CoordSpace): Affine {
    // (fullRes → to) ∘ (from → fullRes), folded into one 2×3.
    return composeAffine2(invertAffine(toFullRes(to)), toFullRes(from))
  }

  return {
    affineBetween,
    map(pt, from, to) {
      return applyAffine(affineBetween(from, to), pt[0], pt[1])
    },
    mapPositions(positions, from, to) {
      return transformPositions(positions, affineBetween(from, to))
    },
  }
}

/** Serialize a `CoordSpace` for the GeoJSON `ziee:crs` member (ITEM-7). */
export function coordSpaceToString(space: CoordSpace): string {
  if (isLevel(space)) return `level:${space.level}`
  return space
}

/** Parse a `ziee:crs` string back into a `CoordSpace` (permissive; defaults to fullRes). */
export function coordSpaceFromString(s: string | undefined): CoordSpace {
  if (!s) return 'fullRes'
  if (s === 'physical' || s === 'world' || s === 'fullRes') return s
  const m = /^level:(\d+)$/.exec(s)
  if (m) return { level: Number(m[1]) }
  return 'fullRes'
}
