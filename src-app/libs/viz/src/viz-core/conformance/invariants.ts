// invariants.ts — pure, reusable STRUCTURAL invariants the conformance battery
// (viewKindBattery.test.ts) asserts across randomized + degenerate inputs (ITEM-55/56).
//
// Every helper is a pure predicate that THROWS a descriptive `Error` on violation and
// returns `void` on success — so it composes both inside a `fast-check` property
// (fast-check catches the throw + reports the shrunk counterexample) and inside a plain
// `it()`. No GL, no DOM, no I/O; unit-testable in node.
//
// The recurring failure classes these guard against (the ones per-feature tests miss):
//   • a computed `[lo,hi]` range leaking `NaN` / `[Inf,-Inf]` instead of a finite
//     ordered pair or the documented empty sentinel;
//   • a matrix aggregation whose flat `values` length no longer equals rows×cols, or
//     whose row/col labels drift out of alignment;
//   • a facet partition that drops or double-counts a point index;
//   • non-monotone / non-finite axis ticks (bin edges);
//   • box quartiles that come back unordered (q1 > median > q3) on a degenerate group;
//   • a color/selection buffer whose length no longer matches N.

/** Format an optional context tag for an error message. */
function tag(ctx?: string): string {
  return ctx ? ` [${ctx}]` : ''
}

/** Every element is finite (rejects NaN AND ±Infinity). */
export function assertAllFinite(values: ArrayLike<number>, ctx?: string): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`assertAllFinite${tag(ctx)}: non-finite value ${values[i]} at index ${i}`)
    }
  }
}

/** No element is NaN (±Infinity is tolerated — use {@link assertAllFinite} to reject those too). */
export function assertNoNaN(values: ArrayLike<number>, ctx?: string): void {
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      throw new Error(`assertNoNaN${tag(ctx)}: NaN at index ${i}`)
    }
  }
}

/** Every element is ≥ 0 (and finite). */
export function assertNonNegative(values: ArrayLike<number>, ctx?: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!(Number.isFinite(v) && v >= 0)) {
      throw new Error(`assertNonNegative${tag(ctx)}: value ${v} at index ${i}`)
    }
  }
}

/** A `[lo, hi]` range is finite with `lo <= hi`. */
export function assertFiniteRange(range: readonly [number, number], ctx?: string): void {
  const [lo, hi] = range
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`assertFiniteRange${tag(ctx)}: non-finite range [${lo}, ${hi}]`)
  }
  if (lo > hi) {
    throw new Error(`assertFiniteRange${tag(ctx)}: inverted range [${lo}, ${hi}] (lo > hi)`)
  }
}

/**
 * A computed range is EITHER a finite ordered `[lo,hi]` OR exactly the documented empty
 * sentinel (default `[0,0]`, e.g. `faceting.sharedDomain`'s "no finite values" result) —
 * never a `NaN` / `[Inf,-Inf]` leak.
 */
export function assertFiniteOrSentinel(
  range: readonly [number, number],
  sentinel: readonly [number, number] = [0, 0],
  ctx?: string,
): void {
  if (range[0] === sentinel[0] && range[1] === sentinel[1]) return
  assertFiniteRange(range, ctx)
}

/** Options for {@link assertMatrixShape}: optional row/col label arrays to length-check. */
export interface MatrixShapeOpts {
  readonly rowLabels?: ArrayLike<unknown>
  readonly colLabels?: ArrayLike<unknown>
}

/**
 * A flat row-major matrix `values` has `length === rows*cols`, and (when supplied) the
 * row/col label arrays match `rows`/`cols`. Guards the class of bug where a matrix
 * aggregation's value buffer silently desyncs from its axis labels.
 */
export function assertMatrixShape(
  values: ArrayLike<number>,
  rows: number,
  cols: number,
  opts: MatrixShapeOpts = {},
  ctx?: string,
): void {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 0 || cols < 0) {
    throw new Error(`assertMatrixShape${tag(ctx)}: bad dims rows=${rows} cols=${cols}`)
  }
  if (values.length !== rows * cols) {
    throw new Error(
      `assertMatrixShape${tag(ctx)}: values.length ${values.length} !== rows*cols ${rows * cols}`,
    )
  }
  if (opts.rowLabels && opts.rowLabels.length !== rows) {
    throw new Error(
      `assertMatrixShape${tag(ctx)}: rowLabels.length ${opts.rowLabels.length} !== rows ${rows}`,
    )
  }
  if (opts.colLabels && opts.colLabels.length !== cols) {
    throw new Error(
      `assertMatrixShape${tag(ctx)}: colLabels.length ${opts.colLabels.length} !== cols ${cols}`,
    )
  }
}

/** A facet-like partition member exposing its member point indices. */
export interface PartitionMember {
  readonly indices: ArrayLike<number>
}

/**
 * The facets form a PARTITION of the in-range points: every point index whose `codes[i]`
 * is in `[0, nCat)` appears EXACTLY ONCE across all facets' `indices`, every out-of-range
 * point appears in NONE, and no index is duplicated or out of `[0, n)`. This is the
 * property `partitionByCategorical` documents ("union covers every in-range point exactly
 * once") — the guard against a facet dropping or double-counting a point.
 */
export function assertPartitionCoversAll(
  facets: readonly PartitionMember[],
  codes: ArrayLike<number>,
  nCat: number,
  ctx?: string,
): void {
  const n = codes.length
  const seen = new Uint8Array(n)
  for (let f = 0; f < facets.length; f++) {
    const idx = facets[f].indices
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]
      if (!Number.isInteger(i) || i < 0 || i >= n) {
        throw new Error(`assertPartitionCoversAll${tag(ctx)}: facet ${f} index ${i} out of [0, ${n})`)
      }
      if (seen[i]) {
        throw new Error(`assertPartitionCoversAll${tag(ctx)}: index ${i} appears in >1 facet`)
      }
      seen[i] = 1
    }
  }
  for (let i = 0; i < n; i++) {
    const inRange = codes[i] >= 0 && codes[i] < nCat
    if (inRange && !seen[i]) {
      throw new Error(`assertPartitionCoversAll${tag(ctx)}: in-range index ${i} covered by no facet`)
    }
    if (!inRange && seen[i]) {
      throw new Error(`assertPartitionCoversAll${tag(ctx)}: out-of-range index ${i} was covered`)
    }
  }
}

/** Options for {@link assertMonotoneTicks}. */
export interface MonotoneOpts {
  /** Require STRICTLY increasing (default: non-decreasing). */
  readonly strict?: boolean
}

/**
 * Axis ticks / bin edges are all finite and monotonically non-decreasing (or strictly
 * increasing with `{strict:true}`). An empty or single-element array is vacuously
 * monotone.
 */
export function assertMonotoneTicks(
  ticks: ArrayLike<number>,
  opts: MonotoneOpts = {},
  ctx?: string,
): void {
  assertAllFinite(ticks, ctx)
  for (let i = 1; i < ticks.length; i++) {
    const ok = opts.strict ? ticks[i] > ticks[i - 1] : ticks[i] >= ticks[i - 1]
    if (!ok) {
      throw new Error(
        `assertMonotoneTicks${tag(ctx)}: tick[${i}]=${ticks[i]} ${
          opts.strict ? '<=' : '<'
        } tick[${i - 1}]=${ticks[i - 1]}`,
      )
    }
  }
}

/**
 * A packed RGBA color buffer has `length === n*4` and is a `Uint8Array` (so every channel
 * is inherently a valid 0..255 byte — the array type enforces it).
 */
export function assertByteQuad(colors: unknown, n: number, ctx?: string): void {
  if (!(colors instanceof Uint8Array)) {
    throw new Error(`assertByteQuad${tag(ctx)}: colors is not a Uint8Array`)
  }
  if (colors.length !== n * 4) {
    throw new Error(`assertByteQuad${tag(ctx)}: colors.length ${colors.length} !== n*4 ${n * 4}`)
  }
}

/** A selection-like mask over N points exposes a `length === n`. */
export function assertMaskLength(mask: { readonly length: number }, n: number, ctx?: string): void {
  if (mask.length !== n) {
    throw new Error(`assertMaskLength${tag(ctx)}: mask.length ${mask.length} !== n ${n}`)
  }
}

/** A box statistic: the fields {@link assertQuartilesOrdered} validates. */
export interface QuartileLike {
  readonly q1: number
  readonly median: number
  readonly q3: number
  readonly lowerFence: number
  readonly upperFence: number
  readonly outliers: readonly number[]
}

/**
 * Tukey box statistics are internally consistent: all five summary numbers are finite,
 * `lowerFence <= q1 <= median <= q3 <= upperFence`, and every outlier is finite. Holds for
 * the degenerate verdicts too (empty → all-zero; single/flat → the value everywhere), so a
 * degenerate group can never emit an unordered / NaN box.
 */
export function assertQuartilesOrdered(stat: QuartileLike, ctx?: string): void {
  const { q1, median, q3, lowerFence, upperFence } = stat
  for (const [name, v] of [
    ['q1', q1],
    ['median', median],
    ['q3', q3],
    ['lowerFence', lowerFence],
    ['upperFence', upperFence],
  ] as const) {
    if (!Number.isFinite(v)) {
      throw new Error(`assertQuartilesOrdered${tag(ctx)}: non-finite ${name}=${v}`)
    }
  }
  if (!(lowerFence <= q1 && q1 <= median && median <= q3 && q3 <= upperFence)) {
    throw new Error(
      `assertQuartilesOrdered${tag(ctx)}: unordered [lF=${lowerFence}, q1=${q1}, med=${median}, q3=${q3}, uF=${upperFence}]`,
    )
  }
  assertAllFinite(stat.outliers, ctx ? `${ctx}.outliers` : 'outliers')
}

/**
 * The sum of `counts` equals `expected` (within an integer tolerance for float
 * accumulation) and every count is non-negative. Guards histogram / bar count conservation
 * (Σ bins == number of counted points).
 */
export function assertCountsSumTo(
  counts: ArrayLike<number>,
  expected: number,
  ctx?: string,
): void {
  assertNonNegative(counts, ctx)
  let sum = 0
  for (let i = 0; i < counts.length; i++) sum += counts[i]
  if (Math.abs(sum - expected) > 1e-6) {
    throw new Error(`assertCountsSumTo${tag(ctx)}: Σcounts ${sum} !== expected ${expected}`)
  }
}
