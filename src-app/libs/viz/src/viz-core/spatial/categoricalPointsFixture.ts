// categoricalPointsFixture.ts — a synthetic categorical-point-cloud fixture for the
// CategoricalPointsView showcase + smoke use. Generates N individual points, each with a
// category CODE, laid out so each category CLUSTERS in its own neighbourhood — so hiding
// a category visibly removes a blob from the plot (the whole point of the demo).
//
// Deterministic (seeded mulberry32) so a story renders identically every run. Pure
// typed-array output — no deck.gl / React — matching the binary-attribute contract the
// scatter path consumes (interleaved xy positions + a per-point Uint16 code).

/** Deterministic RNG (same generator the pointIndex test uses) — reproducible fixtures. */
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

/** A Box–Muller standard-normal draw from a uniform generator (for cluster scatter). */
function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export interface CategoricalPointsFixture {
  /** interleaved xy, length `count * 2`. */
  readonly positions: Float32Array
  /** per-point category code in `[0, categoryCount)`, length `count`. */
  readonly categoryCodes: Uint16Array
  /** display names, length `categoryCount` — `categoryNames[code]` names a category. */
  readonly categoryNames: string[]
  /** distinct category count. */
  readonly categoryCount: number
  /** number of points. */
  readonly count: number
}

export interface CategoricalPointsFixtureOpts {
  /** number of points (default 500k). */
  count?: number
  /** number of categories (default 30). */
  categoryCount?: number
  /** RNG seed (default 1). */
  seed?: number
  /** world half-extent the cluster centres are spread over (default 1000). */
  extent?: number
  /** per-cluster gaussian spread in world units (default 60). */
  spread?: number
}

/**
 * Build a clustered categorical-point fixture. Each category gets a random cluster centre
 * inside `[-extent, extent]²`; a point's position is its category's centre + a gaussian
 * jitter of `spread`. Category assignment is skewed (a Zipf-ish weighting) so counts
 * differ — which exercises `topCategoriesByCount` (a meaningful default view) and the
 * count readout.
 */
export function makeCategoricalPointsFixture(
  opts: CategoricalPointsFixtureOpts = {},
): CategoricalPointsFixture {
  const count = Math.max(0, Math.floor(opts.count ?? 500_000))
  const categoryCount = Math.max(1, Math.floor(opts.categoryCount ?? 30))
  const extent = opts.extent ?? 1000
  const spread = opts.spread ?? 60
  const rng = mulberry32(opts.seed ?? 1)

  // Per-category cluster centres + names.
  const centers = new Float32Array(categoryCount * 2)
  const categoryNames: string[] = []
  for (let g = 0; g < categoryCount; g++) {
    centers[g * 2] = (rng() * 2 - 1) * extent
    centers[g * 2 + 1] = (rng() * 2 - 1) * extent
    categoryNames.push(`Category ${String(g + 1).padStart(2, '0')}`)
  }

  // Skewed category-selection weights (∝ 1/(rank+1)) → a CDF for O(log K) sampling. This
  // makes some categories far denser than others so the default top-k view is non-trivial.
  const weights = new Float64Array(categoryCount)
  let wsum = 0
  for (let g = 0; g < categoryCount; g++) {
    weights[g] = 1 / (g + 1)
    wsum += weights[g]
  }
  const cdf = new Float64Array(categoryCount)
  let acc = 0
  for (let g = 0; g < categoryCount; g++) {
    acc += weights[g] / wsum
    cdf[g] = acc
  }
  const pickCategory = (u: number): number => {
    // binary search the CDF for the first entry >= u.
    let lo = 0
    let hi = categoryCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < u) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const positions = new Float32Array(count * 2)
  const categoryCodes = new Uint16Array(count)
  for (let i = 0; i < count; i++) {
    const g = pickCategory(rng())
    categoryCodes[i] = g
    positions[i * 2] = centers[g * 2] + gaussian(rng) * spread
    positions[i * 2 + 1] = centers[g * 2 + 1] + gaussian(rng) * spread
  }

  return { positions, categoryCodes, categoryNames, categoryCount, count }
}
