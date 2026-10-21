// image.ts — the cell↔image-image alignment model (ITEM-10). Following the
// SpatialData model: cells align to the image by an AFFINE transform into a shared
// coordinate system, NOT a bare scalar. Visium's `image_hires_scalef` is the
// scale-only special case; Xenium/MERFISH micron↔pixel is the general affine.

export type Affine = readonly [number, number, number, number, number, number]
// row-major 2×3: [a, b, tx, c, d, ty]  →  x' = a·x + b·y + tx ;  y' = c·x + d·y + ty

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 0, 1, 0]

/** Visium scale-only alignment: multiply full-res coords by the hires scalefactor. */
export function scaleAffine(imageHiresScalef: number): Affine {
  return [imageHiresScalef, 0, 0, 0, imageHiresScalef, 0]
}

/** Compose scale + translation + rotation (radians) into one affine. */
export function composeAffine(opts: {
  scale?: number
  rotation?: number
  translate?: readonly [number, number]
}): Affine {
  const s = opts.scale ?? 1
  const r = opts.rotation ?? 0
  const [tx, ty] = opts.translate ?? [0, 0]
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [s * cos, -s * sin, tx, s * sin, s * cos, ty]
}

/** Apply an affine to a single point. */
export function applyAffine(a: Affine, x: number, y: number): [number, number] {
  return [a[0] * x + a[1] * y + a[2], a[3] * x + a[4] * y + a[5]]
}

/**
 * Invert a 2×3 affine. Needed by the coordinate facade (physical↔fullRes↔level,
 * ITEM-14): once NGFF RFC-5 admits rotation/shear the transform is no longer diagonal,
 * so inversion cannot be a naive reciprocal — invert the 2×2 linear part and re-map the
 * translation. Throws on a singular (non-invertible) transform, which a valid image
 * placement never is (surfacing a real bug rather than silently returning identity).
 */
export function invertAffine(a: Affine): Affine {
  const [m00, m01, tx, m10, m11, ty] = a
  const det = m00 * m11 - m01 * m10
  // Scale-invariant singularity test: `det` has the units of the linear-part entries
  // SQUARED, so an absolute floor (`< 1e-12`) falsely rejects a well-conditioned but
  // small-magnitude affine (e.g. an isotropic 1e-7 micron scale ⇒ det≈1e-14). Compare
  // `|det|` against the Frobenius norm² of the 2×2 linear part instead, so the test
  // measures conditioning (a relative reciprocal-condition proxy), not raw magnitude.
  const norm2 = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11
  if (!Number.isFinite(det) || Math.abs(det) <= norm2 * 1e-12) {
    throw new Error(`invertAffine: singular affine (det=${det})`)
  }
  const inv = 1 / det
  const i00 = m11 * inv
  const i01 = -m01 * inv
  const i10 = -m10 * inv
  const i11 = m00 * inv
  // inverse translation = -(inverseLinear · t)
  return [i00, i01, -(i00 * tx + i01 * ty), i10, i11, -(i10 * tx + i11 * ty)]
}

/**
 * Transform an interleaved xy `Float32Array` through an affine, returning a new
 * interleaved array in image/shared-coordinate space (the positions the spatial
 * `ScatterplotLayer` renders, aligned to the `BitmapLayer` underlay).
 */
export function transformPositions(positions: Float32Array, a: Affine): Float32Array {
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]
    const y = positions[i + 1]
    out[i] = a[0] * x + a[1] * y + a[2]
    out[i + 1] = a[3] * x + a[4] * y + a[5]
  }
  return out
}

/**
 * deck.gl `BitmapLayer` bounds for a image underlay of size W×H placed at the origin
 * in the shared coordinate space, with the image's top-left at world (0,0) and
 * y increasing DOWN (matched by `OrthographicView({flipY:true})`).
 * Returns `[left, bottom, right, top]` = `[0, H, W, 0]`.
 */
export function imageBounds(width: number, height: number): [number, number, number, number] {
  return [0, height, width, 0]
}
