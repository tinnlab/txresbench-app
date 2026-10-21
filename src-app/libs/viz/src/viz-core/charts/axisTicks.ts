// axisTicks.ts — pure tick-generation for the GPU chart chrome (ITEM-17 / DEC-23).
// `niceTicks` is a d3-style "nice" tick-value generator (round multiples of a 1/2/5×10ⁿ
// step spanning [min,max]); `categoryTicks` places one tick per categorical slot at its
// integer center (matching the `gi * spacing` / bar-index centers the chartLayers builders
// emit at spacing=1). Both are pure — no GL, no DOM — so they unit-test in node and feed
// `ChartFrame`'s value-axis and category-axis tick placement. Naming is domain-agnostic
// (DEC-28). No SVG anywhere (DEC-18/23) — these are just numbers + labels.

/** One categorical tick: its data-space x (or y) center and its label. */
export interface CategoryTick {
  readonly pos: number
  readonly label: string
}

/**
 * d3's `tickStep`: the "nicest" round step (a 1, 2, or 5 times a power of ten) that
 * divides [min,max] into roughly `count` intervals. Thresholds are d3's √50/√10/√2 so
 * the chosen step keeps the tick count close to the request.
 */
export function tickStep(min: number, max: number, count: number): number {
  const span = Math.abs(max - min)
  const n = Math.max(1, count)
  const step0 = span / n
  const power = Math.pow(10, Math.floor(Math.log10(step0)))
  const error = step0 / power
  if (error >= Math.sqrt(50)) return power * 10
  if (error >= Math.sqrt(10)) return power * 5
  if (error >= Math.sqrt(2)) return power * 2
  return power
}

/** Decimal places implied by a step (so ticks print without floating-point noise). */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  return Math.max(0, -Math.floor(Math.log10(step)))
}

/** Snap `v` to the step's decimal precision — kills 0.1+0.2-style drift on the axis. */
function snap(v: number, decimals: number): number {
  return Number(v.toFixed(Math.min(20, decimals)))
}

/**
 * d3-style "nice" tick VALUES over [min,max]: round multiples of a 1/2/5×10ⁿ step, all
 * within [min,max], roughly `count` of them. Degenerate inputs: non-finite → `[]`;
 * `min === max` → a single tick at that value; a reversed range is normalized. Pure.
 */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  let lo = min
  let hi = max
  if (lo > hi) {
    const t = lo
    lo = hi
    hi = t
  }
  if (lo === hi) return [snap(lo, stepDecimals(Math.abs(lo) || 1) + 2)]

  const step = tickStep(lo, hi, count)
  if (!Number.isFinite(step) || step <= 0) return [lo, hi]
  const decimals = stepDecimals(step)
  const start = Math.ceil(lo / step)
  const stop = Math.floor(hi / step)
  const ticks: number[] = []
  // guard: pathological spans can't produce an absurd number of ticks
  const nSteps = stop - start
  if (!Number.isFinite(nSteps) || nSteps > 10_000) return [snap(lo, decimals), snap(hi, decimals)]
  for (let i = start; i <= stop; i++) ticks.push(snap(i * step, decimals))
  return ticks
}

/**
 * One tick per categorical slot at its integer center (`pos = index`), preserving the
 * given label order. Matches the category centers the chartLayers builders emit at
 * spacing = 1 (violin/box `gi * spacing`, bar `ci`). Pure.
 */
export function categoryTicks(labels: readonly string[]): CategoryTick[] {
  return labels.map((label, i) => ({ pos: i, label }))
}

/** Concise numeric label for a value tick (integer stays integer; step precision else). */
export function formatTickValue(v: number): string {
  if (!Number.isFinite(v)) return ''
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return v.toExponential(1)
  if (Number.isInteger(v)) return String(v)
  // trim trailing zeros from a fixed-precision render
  return String(Number(v.toFixed(4)))
}
