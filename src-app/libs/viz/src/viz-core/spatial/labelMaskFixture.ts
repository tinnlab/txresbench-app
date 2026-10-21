// labelMaskFixture.ts — a synthetic label-mask fixture for the label-mask layer
// (showcase + smoke). Generates a small raster of blobby, distinctly-labelled regions
// (a nearest-seed Voronoi carve, capped by a per-seed radius so regions are rounded
// blobs separated by background), plus a synthetic id→category assignment. Deterministic
// (seeded) so the story renders identically every time. Pure — no GL, no I/O.

export interface LabelMaskFixture {
  /** row-major label raster, id per pixel (0 = background). */
  readonly labelMask: Uint16Array
  readonly width: number
  readonly height: number
  /** number of distinct labels (ids 1..labelCount). */
  readonly labelCount: number
  /** number of distinct categories (codes 0..categoryCount-1). */
  readonly categoryCount: number
  /** id→category code (length labelCount+1; index 0 = background, unused). */
  readonly categoryForId: Uint16Array
}

/** mulberry32 — a tiny deterministic PRNG (seed → repeatable float stream). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface LabelMaskFixtureOpts {
  seed?: number
  width?: number
  height?: number
  labelCount?: number
  categoryCount?: number
}

/**
 * Build a synthetic label-mask fixture: ~`labelCount` blobby regions over a
 * `width`×`height` raster, each with a distinct id (1..labelCount) and a random category
 * (0..categoryCount-1). Pixels beyond every seed's radius stay background (0).
 */
export function makeLabelMaskFixture(opts: LabelMaskFixtureOpts = {}): LabelMaskFixture {
  const width = opts.width ?? 256
  const height = opts.height ?? 256
  const labelCount = opts.labelCount ?? 50
  const categoryCount = opts.categoryCount ?? 6
  const rand = mulberry32(opts.seed ?? 7)

  // Scatter seeds; each carries a blob radius. Regions are the nearest-seed areas,
  // clipped to that seed's radius so blobs are rounded and separated by background.
  const sx = new Float32Array(labelCount)
  const sy = new Float32Array(labelCount)
  const sr = new Float32Array(labelCount)
  const minDim = Math.min(width, height)
  for (let i = 0; i < labelCount; i++) {
    sx[i] = rand() * width
    sy[i] = rand() * height
    sr[i] = minDim * (0.035 + rand() * 0.03) // ~9–17 px on a 256 raster
  }

  const labelMask = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = -1
      let bestD2 = Infinity
      for (let i = 0; i < labelCount; i++) {
        const dx = x - sx[i]
        const dy = y - sy[i]
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) {
          bestD2 = d2
          best = i
        }
      }
      // inside the nearest seed's radius → that region; else background.
      labelMask[y * width + x] = best >= 0 && bestD2 <= sr[best] * sr[best] ? best + 1 : 0
    }
  }

  // id→category: index 0 = background (0, unused); ids 1..labelCount get a random category.
  const categoryForId = new Uint16Array(labelCount + 1)
  for (let id = 1; id <= labelCount; id++) {
    categoryForId[id] = Math.floor(rand() * categoryCount)
  }

  return { labelMask, width, height, labelCount, categoryCount, categoryForId }
}
