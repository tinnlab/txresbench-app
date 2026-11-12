// rng.ts — a small seeded PRNG so every stochastic step in a figure is REPRODUCIBLE (ITEM-7 /
// publication reproducibility). The viz already makes per-index jitter + adaptive sampling deterministic
// (violinJitter.ts is an index hash); the one remaining prod `Math.random` is the KLL quantile sketch's
// default rng (sketches.ts). Route that through a seeded generator whose seed is recorded in the figure
// manifest, and a violin/box/heatmap shape becomes bit-for-bit reproducible from the manifest.
//
// mulberry32: the same tiny generator the test suite already uses (sketches.test.ts) — 32-bit state, fast,
// well-distributed enough for jitter/subsampling/compaction. NOT cryptographic (never use for secrets).

/** A seeded `() => number` in [0,1). Deterministic for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a over a string → a 32-bit unsigned seed. Lets a stable id (a cell id, a column name) derive a
 *  stable seed, so the SAME figure always draws the same "random" layout without storing a number. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The default seed for a cell: derived from its id so a figure is reproducible-by-default (DEC-8) while a
 *  caller may still override with an explicit seed for a fresh draw. */
export function defaultCellSeed(cellId: string): number {
  return seedFromString(cellId || 'txresbench-viz')
}

/** A seeded rng bound to a cell (or an explicit override seed). The object it returns is passed straight to
 *  `new KllSketch(k, rng)` and any subsample step, and the numeric `seed` is what the manifest records. */
export function cellRng(cellId: string, overrideSeed?: number): { seed: number; rng: () => number } {
  const seed = overrideSeed !== undefined ? overrideSeed >>> 0 : defaultCellSeed(cellId)
  return { seed, rng: mulberry32(seed) }
}
