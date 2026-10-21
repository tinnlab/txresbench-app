// missing.ts — the NaN/NA + degenerate-stats contract (ITEM-58). The wire contract
// produces NA BY DESIGN (a point not covered by a sample-scoped analysis;
// DATA_STORAGE_REDESIGN §3.6), so every kernel + layer must have defined behavior for
// missing / empty / single / zero-variance inputs. These helpers are the single source
// of that policy, threaded through decode → kernels → layers.

/** Sentinel: a point with no valid position (NaN coord) is CULLED, not drawn at (0,0). */
export function isFinitePoint(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y)
}

/** Iterate the finite (drawable) point indices of an interleaved positions array. */
export function forEachFinitePoint(
  positions: Float32Array,
  fn: (index: number, x: number, y: number) => void,
): void {
  const n = positions.length / 2
  for (let i = 0; i < n; i++) {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (isFinitePoint(x, y)) fn(i, x, y)
  }
}

/** Finite values only (skip NaN/±Inf) — for KDE/quartile/mean/z-score inputs. */
export function finiteValues(values: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/** mean + (population) standard deviation over finite values; null if empty/insufficient. */
export function meanStd(values: ArrayLike<number>): { mean: number; std: number; n: number } {
  let sum = 0
  let n = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) {
      sum += v
      n++
    }
  }
  if (n === 0) return { mean: NaN, std: NaN, n: 0 }
  const mean = sum / n
  let ss = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) ss += (v - mean) * (v - mean)
  }
  return { mean, std: Math.sqrt(ss / n), n }
}

/**
 * The degenerate-statistic disposition for a group's values. Callers render per the
 * verdict rather than throwing / emitting NaN geometry:
 * - `empty`  (n=0): render nothing + a "no data" state.
 * - `single` (n=1): a point marker, no KDE/violin shape, no box.
 * - `flat`   (variance≈0): a flat line at the value; z-score skipped (÷0 avoided).
 * - `ok`:    normal stats.
 */
export type StatVerdict = 'empty' | 'single' | 'flat' | 'ok'

export function statVerdict(values: ArrayLike<number>, epsilon = 1e-12): StatVerdict {
  const { std, n } = meanStd(values)
  if (n === 0) return 'empty'
  if (n === 1) return 'single'
  if (!Number.isFinite(std) || std < epsilon) return 'flat'
  return 'ok'
}

/** z-score of a value given a group's mean/std; 0 when the group is flat (÷0 guard). */
export function zscore(value: number, mean: number, std: number, epsilon = 1e-12): number {
  if (!Number.isFinite(value) || std < epsilon) return 0
  return (value - mean) / std
}
