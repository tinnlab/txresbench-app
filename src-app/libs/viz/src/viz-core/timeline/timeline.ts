// timeline.ts — the PURE timeline model + frame→filter-range math (ITEM-46). A timeline
// scrubs an ORDERED dataset dimension (a continuous ordering, or a categorical batch
// treated as an ordered axis): each "frame" maps to a sliding window `[lo,hi]` over that
// dimension, which the GPU turns into a `DataFilterExtension` filterRange (no CPU
// per-point loop on scrub — only the tiny filterRange uniform changes). GENERIC,
// domain-agnostic (DEC-28): a frame is a position along an ordered axis; nothing here is
// bio-specific. No React, no deck.gl, no @ziee/* — unit-testable in node.

/** A timeline over an ordered dimension `[min,max]`, sampled into `frameCount` frames. */
export interface TimelineModel {
  /** Low end of the ordered dimension. */
  readonly min: number
  /** High end of the ordered dimension. */
  readonly max: number
  /**
   * Current frame position in `[0, frameCount)`. Kept as a FLOAT so `advance` can move
   * it sub-frame per rAF tick; consumers round it for display / an integer step.
   */
  readonly frame: number
  /** Number of discrete frames the dimension is sampled into (≥ 1). */
  readonly frameCount: number
  /** Whether the play loop is running (the rAF driver gates on this). */
  readonly playing: boolean
  /** Play speed in FRAMES PER SECOND (used by `advance(model, dt)`). */
  readonly speed: number
}

/** Inputs `frameToRange` needs: the ordered domain, its frame sampling, + the window. */
export interface FrameRangeOpts {
  readonly min: number
  readonly max: number
  readonly frameCount: number
  /** Sliding-window WIDTH as a fraction (0..1) of the `[min,max]` span. */
  readonly window: number
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Wrap a (possibly fractional / negative) frame into `[0, frameCount)` — the play loop. */
function wrapFrame(frame: number, frameCount: number): number {
  if (frameCount <= 0) return 0
  let f = frame % frameCount
  if (f < 0) f += frameCount
  return f
}

/**
 * Map a frame to a sliding filter window `[lo, hi]` over the ordered dimension. A
 * fixed-width window (fraction `window` of the span) slides from the low end at
 * `frame 0` to the high end at `frame frameCount-1`. CLAMPED at both ends: `lo ≥ min`
 * and `hi ≤ max`. If `window ≥ 1` (or the span is degenerate) the window covers the
 * whole `[min,max]`. Pure — this is the ONLY per-scrub math, and it's O(1): the caller
 * feeds `[lo,hi]` straight into a GPU `filterRange` uniform, never a CPU point loop.
 */
export function frameToRange(frame: number, opts: FrameRangeOpts): [number, number] {
  const { min, max, frameCount, window } = opts
  const span = max - min
  if (span <= 0) return [min, max]
  const w = clamp(window, 0, 1) * span
  const travel = Math.max(0, span - w) // how far the window's low edge can slide
  const t = frameCount <= 1 ? 0 : clamp(frame / (frameCount - 1), 0, 1)
  const lo = min + t * travel
  const hi = Math.min(max, lo + w)
  return [lo, hi]
}

/** The domain value at the CENTER of a frame's window (used for labels). */
export function frameCenter(frame: number, opts: FrameRangeOpts): number {
  const [lo, hi] = frameToRange(frame, opts)
  return (lo + hi) / 2
}

/** A readable `"i/N · <center>"` label for the current frame. Generic (no unit name). */
export function frameLabel(frame: number, opts: FrameRangeOpts, fractionDigits = 2): string {
  const idx = Math.round(clamp(frame, 0, Math.max(0, opts.frameCount - 1)))
  const center = frameCenter(frame, opts)
  return `${idx + 1}/${opts.frameCount} · ${center.toFixed(fractionDigits)}`
}

/** Construct a timeline over `[min,max]` sampled into `frameCount` frames. */
export function createTimeline(
  min: number,
  max: number,
  frameCount: number,
  opts: { frame?: number; playing?: boolean; speed?: number } = {},
): TimelineModel {
  return {
    min,
    max,
    frameCount: Math.max(1, Math.floor(frameCount)),
    frame: opts.frame ?? 0,
    playing: opts.playing ?? false,
    speed: opts.speed ?? 6,
  }
}

/** Step the frame by an INTEGER `delta`, LOOPING around the ends (prev/next buttons). */
export function step(model: TimelineModel, delta: number): TimelineModel {
  return { ...model, frame: wrapFrame(Math.round(model.frame) + delta, model.frameCount) }
}

/** SEEK to an absolute frame (a drag), CLAMPED to `[0, frameCount-1]` (no wrap). */
export function seek(model: TimelineModel, frame: number): TimelineModel {
  return { ...model, frame: clamp(frame, 0, Math.max(0, model.frameCount - 1)) }
}

/**
 * Advance the play head by `dt` seconds at `model.speed` frames/sec, LOOPING past the
 * end. Pure (returns a new model); the rAF driver calls it every tick while `playing`.
 */
export function advance(model: TimelineModel, dt: number): TimelineModel {
  const next = model.frame + model.speed * dt
  return { ...model, frame: wrapFrame(next, model.frameCount) }
}

/** Toggle / set the playing flag. */
export function setPlaying(model: TimelineModel, playing: boolean): TimelineModel {
  return { ...model, playing }
}

/** Set the play speed (frames/sec). */
export function setSpeed(model: TimelineModel, speed: number): TimelineModel {
  return { ...model, speed }
}
