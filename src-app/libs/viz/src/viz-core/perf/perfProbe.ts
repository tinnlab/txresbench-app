// perfProbe.ts — pure, testable perf-measurement helpers (ITEM-59). No DOM, no GL: it
// works on a plain array of frame TIMESTAMPS (ms, e.g. from performance.now() sampled in
// a requestAnimationFrame loop) and turns them into frame-time / fps statistics + a
// budget verdict. The showcase perf story feeds these live timestamps in; the driver
// (scripts/viz-perf.mjs) reads the resulting stats/verdict off window.__VIZ_PERF__.
//
// Design rules:
//  - frames = number of frame INTERVALS = timestamps.length - 1 (a single timestamp is
//    zero intervals). Fewer than two timestamps ⇒ all-zero stats (never NaN/Infinity).
//  - p95Ms is the nearest-rank 95th percentile of the per-frame durations (the tail /
//    worst-frame indicator — a stutter shows up here even if the mean stays smooth).
//  - minFps is derived from the SLOWEST frame (max duration) — the worst instantaneous
//    fps, the number a "never drops below" budget cares about.

export interface FrameStats {
  /** number of measured frame intervals (timestamps.length - 1, floored at 0). */
  frames: number
  /** mean per-frame duration in ms. */
  meanMs: number
  /** median per-frame duration in ms. */
  medianMs: number
  /** 95th-percentile (nearest-rank) per-frame duration in ms — the tail/stutter number. */
  p95Ms: number
  /** worst instantaneous fps = 1000 / slowest frame. */
  minFps: number
  /** average fps = 1000 / meanMs. */
  meanFps: number
}

const ZERO_STATS: FrameStats = {
  frames: 0,
  meanMs: 0,
  medianMs: 0,
  p95Ms: 0,
  minFps: 0,
  meanFps: 0,
}

/** nearest-rank percentile (p in [0,1]) of an ascending-sorted array. */
function percentileSorted(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  // nearest-rank: rank = ceil(p * n), clamped to [1, n]; 1-based → index rank-1.
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(p * sortedAsc.length)))
  return sortedAsc[rank - 1]
}

/**
 * Turn an array of frame timestamps (ms) into frame-time / fps statistics.
 * Robust to empty / single-element input (returns all zeros).
 */
export function frameStats(timestamps: number[]): FrameStats {
  if (!Array.isArray(timestamps) || timestamps.length < 2) return { ...ZERO_STATS }

  const deltas: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i] - timestamps[i - 1]
    // guard against non-monotonic / bogus clocks: clamp negatives to 0.
    deltas.push(d > 0 ? d : 0)
  }

  const frames = deltas.length
  const sum = deltas.reduce((a, b) => a + b, 0)
  const meanMs = sum / frames

  const sorted = [...deltas].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianMs =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]

  const p95Ms = percentileSorted(sorted, 0.95)
  const maxMs = sorted[sorted.length - 1]

  const minFps = maxMs > 0 ? 1000 / maxMs : 0
  const meanFps = meanMs > 0 ? 1000 / meanMs : 0

  return { frames, meanMs, medianMs, p95Ms, minFps, meanFps }
}

/**
 * A perf budget. All fields optional so a caller can gate on any subset. `minFrames` +
 * the implicit non-zero-fps check are the "did it actually render" gates (the lenient
 * default the swiftshader driver uses); `minFps` / `maxP95Ms` are the strict, real-GPU
 * gates ("1M @ 60fps" ⇒ { minFps: 60 } or { maxP95Ms: 16.7 }).
 */
export interface Budget {
  /** fail if the worst-frame fps drops below this. */
  minFps?: number
  /** fail if the 95th-percentile frame time exceeds this (ms). */
  maxP95Ms?: number
  /** fail unless at least this many frames were rendered. */
  minFrames?: number
}

export interface Verdict {
  ok: boolean
  reasons: string[]
}

/**
 * Judge stats against a budget. ALWAYS fails on "nothing rendered" (zero frames / zero
 * fps) so a crashed/blank run can never pass, regardless of the (possibly empty) budget.
 * Optional `minFrames` / `minFps` / `maxP95Ms` add stricter gates on top.
 */
export function perfVerdict(stats: FrameStats, budget: Budget = {}): Verdict {
  const reasons: string[] = []

  if (stats.frames <= 0 || stats.meanFps <= 0) {
    reasons.push('no frames rendered (zero fps)')
  }
  if (budget.minFrames != null && stats.frames < budget.minFrames) {
    reasons.push(`only ${stats.frames} frames rendered (< ${budget.minFrames})`)
  }
  if (budget.minFps != null && stats.minFps < budget.minFps) {
    reasons.push(`min fps ${stats.minFps.toFixed(1)} below budget ${budget.minFps}`)
  }
  if (budget.maxP95Ms != null && stats.p95Ms > budget.maxP95Ms) {
    reasons.push(`p95 frame ${stats.p95Ms.toFixed(2)}ms over budget ${budget.maxP95Ms}ms`)
  }

  return { ok: reasons.length === 0, reasons }
}

/**
 * A tiny rolling frame timer for the perf story: start() stamps t0, mark() stamps each
 * frame (call once per requestAnimationFrame), stop()/timestamps() returns the raw
 * timestamp array to hand to `frameStats`. The clock is injectable for deterministic
 * unit tests (defaults to performance.now()).
 */
export class RollingFrameTimer {
  private ts: number[] = []
  private readonly clock: () => number

  constructor(clock?: () => number) {
    this.clock =
      clock ??
      (typeof performance !== 'undefined'
        ? () => performance.now()
        : () => Date.now())
  }

  /** reset and stamp the first timestamp. */
  start(): void {
    this.ts = [this.clock()]
  }

  /** stamp one frame boundary — call once per animation frame. */
  mark(): void {
    this.ts.push(this.clock())
  }

  /** stop measuring and return the collected timestamps (copy). */
  stop(): number[] {
    return this.timestamps()
  }

  /** the collected timestamps (defensive copy). */
  timestamps(): number[] {
    return this.ts.slice()
  }

  /** number of timestamps collected so far. */
  get count(): number {
    return this.ts.length
  }
}
