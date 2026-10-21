// sketches.ts — streaming, mergeable, approximate sketches for the progressive /
// streaming plan (STREAMING_PROGRESSIVE_PLAN.md item 12). Two non-additive summaries
// that a single-pass streaming pipeline needs but cannot compute additively:
//
//   • KllSketch     — approximate quantiles (color-scale p1/p99 of a continuous
//                     channel) without a second pass over the full point set.
//   • HyperLogLog   — approximate distinct count (how many distinct labels) in
//                     ~4 KB regardless of cardinality.
//
// Both are MERGEABLE: sketch a chunk, then `merge` the per-chunk sketches — the
// result approximates the sketch of the concatenated stream (associative +
// commutative). This is what lets 10M points at ~1M/sec be summarized as
// O(sketch) state, never a re-scan.
//
// PURE + domain-neutral (DEC-28): no GL, no DOM, no store, no I/O. Randomness in
// KLL is injectable via an `rng: () => number` constructor arg (default
// Math.random) so tests are deterministic. Typed-array internals where they help.

// ─────────────────────────────────────────────────────────────────────────────
// hash32 — a 32-bit integer finalizer (MurmurHash3 fmix32). Used to feed the HLL
// from integer label codes: a good avalanche means adjacent codes (0,1,2,…) land
// in well-spread registers. Returns an unsigned 32-bit int.
// ─────────────────────────────────────────────────────────────────────────────

/** MurmurHash3 32-bit finalizer (avalanche mixer). Non-finite / non-integer input
 *  is floored to a 32-bit integer first. Returns a uint32 in [0, 2^32). */
export function hash32(x: number): number {
  // Coerce to a 32-bit lane. `x | 0` truncates toward zero into int32; `>>> 0`
  // reinterprets as uint32.
  let h = (Number.isFinite(x) ? Math.trunc(x) : 0) | 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// ─────────────────────────────────────────────────────────────────────────────
// KllSketch — Karnin–Lang–Liberty streaming quantiles (arXiv 2102.09299 /
// DataSketches). A stack of "compactors": level 0 buffers raw items; when a
// compactor overflows it is sorted and HALVED — every other item is promoted to
// the next level, each promoted item carrying weight 2^level. The choice of even-
// vs-odd survivors is a fair coin per compaction (the randomness that bounds the
// error). Capacity per level shrinks geometrically from the top so total stored
// items are O(k); rank error is ~O(1/k) with high probability.
//
// Default k=200 → ~1–1.5% rank error, a few KB of state. Larger k → smaller error,
// linearly more memory.
// ─────────────────────────────────────────────────────────────────────────────

/** DataSketches KLL width-scaling constant (2/3). Level h keeps
 *  ceil(k · c^(H−h)) items, floored at a small minimum — the top level is widest. */
const KLL_C = 2 / 3
/** Floor on any compactor's capacity (matches the reference implementation). */
const KLL_MIN_LEVEL_CAP = 8

export class KllSketch {
  private readonly k: number
  private readonly rng: () => number
  /** One sorted-on-compaction buffer per level; `levels[0]` is the input buffer. */
  private compactors: number[][]
  /** Total weight of all retained items (== number of finite updates seen). */
  private n: number

  constructor(k = 200, rng: () => number = Math.random) {
    // Keep k sane: below the min-cap the compactors degenerate.
    this.k = Math.max(KLL_MIN_LEVEL_CAP, Math.floor(k))
    this.rng = rng
    this.compactors = [[]]
    this.n = 0
  }

  /** Number of items summarized (finite updates + merged weight). */
  get count(): number {
    return this.n
  }

  /** Capacity of level h given the current number of levels H (0-indexed top). */
  private levelCapacity(height: number, numLevels: number): number {
    const depth = numLevels - 1 - height // 0 at the top level, grows downward
    const cap = Math.ceil(this.k * Math.pow(KLL_C, depth))
    return Math.max(KLL_MIN_LEVEL_CAP, cap)
  }

  /** Add one value. NaN / ±Infinity are ignored (never counted). */
  update(x: number): void {
    if (!Number.isFinite(x)) return
    this.compactors[0].push(x)
    this.n += 1
    this.compressIfNeeded()
  }

  private compressIfNeeded(): void {
    let height = 0
    while (height < this.compactors.length) {
      const cap = this.levelCapacity(height, this.compactors.length)
      if (this.compactors[height].length < cap) {
        height += 1
        continue
      }
      // Ensure a destination level exists.
      if (height + 1 === this.compactors.length) this.compactors.push([])
      this.compact(height)
      // Re-scan from the bottom: a promotion can overflow a higher level.
      height = 0
    }
  }

  /** Sort level `height`, promote every-other item (fair coin) to `height+1`. */
  private compact(height: number): void {
    const buf = this.compactors[height]
    buf.sort((a, b) => a - b)
    // Keep an ODD leftover item in place so capacity math stays exact.
    let start = 0
    const keep: number[] = []
    if (buf.length % 2 === 1) {
      keep.push(buf[buf.length - 1])
      start = 0
    }
    const limit = buf.length - (buf.length % 2)
    const offset = this.rng() < 0.5 ? 0 : 1 // which coset survives
    const promoted = this.compactors[height + 1]
    for (let i = start + offset; i < limit; i += 2) {
      promoted.push(buf[i])
    }
    this.compactors[height] = keep
  }

  /** Merge another KLL into this one (associative + commutative, up to the RNG
   *  coin flips). The other sketch is not mutated. */
  merge(other: KllSketch): void {
    if (other.n === 0) return
    // Grow to cover the taller sketch.
    while (this.compactors.length < other.compactors.length) this.compactors.push([])
    for (let h = 0; h < other.compactors.length; h++) {
      const src = other.compactors[h]
      for (let i = 0; i < src.length; i++) this.compactors[h].push(src[i])
    }
    this.n += other.n
    this.compressIfNeeded()
  }

  /** Materialize the (value, cumulativeWeight) rank map, sorted by value. */
  private rankedItems(): { values: Float64Array; cumWeights: Float64Array; total: number } {
    const pairs: Array<[number, number]> = []
    let total = 0
    for (let h = 0; h < this.compactors.length; h++) {
      const w = 1 << h // weight of an item at level h
      const buf = this.compactors[h]
      for (let i = 0; i < buf.length; i++) {
        pairs.push([buf[i], w])
        total += w
      }
    }
    pairs.sort((a, b) => a[0] - b[0])
    const values = new Float64Array(pairs.length)
    const cumWeights = new Float64Array(pairs.length)
    let acc = 0
    for (let i = 0; i < pairs.length; i++) {
      values[i] = pairs[i][0]
      acc += pairs[i][1]
      cumWeights[i] = acc
    }
    return { values, cumWeights, total }
  }

  /** Approximate value at quantile q ∈ [0,1]. Empty sketch → NaN. q is clamped. */
  quantile(q: number): number {
    if (this.n === 0) return Number.NaN
    const { values, cumWeights, total } = this.rankedItems()
    if (values.length === 0) return Number.NaN
    const qc = q <= 0 ? 0 : q >= 1 ? 1 : q
    // Target cumulative weight; first item whose running weight reaches it.
    const target = qc * total
    // Binary search for the first cumWeights[i] >= target.
    let lo = 0
    let hi = cumWeights.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cumWeights[mid] < target) lo = mid + 1
      else hi = mid
    }
    return values[lo]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HyperLogLog — Flajolet et al. distinct-count estimator. m = 2^p registers; each
// item's hash splits into a p-bit register index and the remaining bits, whose
// leading-zero-run + 1 is stored as a max per register. The harmonic mean of
// 2^register across registers estimates cardinality, with small/large-range
// corrections (the classic HLL estimator). Standard error ≈ 1.04/√m.
//
// Default p=12 → m=4096 registers (~4 KB as a Uint8Array), ~1.6% standard error.
// p ∈ [4, 16]. Mergeable: register-wise max (associative + commutative, exact).
// ─────────────────────────────────────────────────────────────────────────────

export class HyperLogLog {
  private readonly p: number
  private readonly m: number
  private registers: Uint8Array

  constructor(p = 12) {
    this.p = Math.min(16, Math.max(4, Math.floor(p)))
    this.m = 1 << this.p
    this.registers = new Uint8Array(this.m)
  }

  /** Register bias-correction constant α_m. */
  private get alpha(): number {
    switch (this.m) {
      case 16:
        return 0.673
      case 32:
        return 0.697
      case 64:
        return 0.709
      default:
        return 0.7213 / (1 + 1.079 / this.m)
    }
  }

  /** Add a precomputed 32-bit hash (caller runs `hash32` on integer label codes). */
  add(hash: number): void {
    const h = hash >>> 0
    // Top p bits index the register; the remaining (32−p) bits give the run of
    // leading zeros (+1) that we record.
    const idx = h >>> (32 - this.p)
    const w = (h << this.p) >>> 0 // remaining bits, left-justified in 32
    const rank = w === 0 ? 32 - this.p + 1 : Math.clz32(w) + 1
    if (rank > this.registers[idx]) this.registers[idx] = rank
  }

  /** Merge another HLL (must share p) by register-wise max. Other is not mutated. */
  merge(other: HyperLogLog): void {
    if (other.p !== this.p) {
      throw new Error(`HyperLogLog.merge: precision mismatch (${this.p} vs ${other.p})`)
    }
    const a = this.registers
    const b = other.registers
    for (let i = 0; i < a.length; i++) {
      if (b[i] > a[i]) a[i] = b[i]
    }
  }

  /** Estimated distinct count. */
  estimate(): number {
    const m = this.m
    let sum = 0
    let zeros = 0
    for (let i = 0; i < m; i++) {
      const r = this.registers[i]
      sum += 1 / (1 << r) // 2^(-register)
      if (r === 0) zeros += 1
    }
    let est = (this.alpha * m * m) / sum
    // Small-range correction: linear counting when many registers are empty.
    if (est <= 2.5 * m && zeros > 0) {
      est = m * Math.log(m / zeros)
    } else if (est > (1 / 30) * 4294967296) {
      // Large-range correction (2^32).
      est = -4294967296 * Math.log(1 - est / 4294967296)
    }
    return est
  }
}
