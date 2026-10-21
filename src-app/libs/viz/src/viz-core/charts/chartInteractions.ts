// chartInteractions.ts — PURE interaction/overlay helpers for the companion
// statistical charts (volcano threshold recolor + top-N labels; significance-bracket
// geometry). STRICT all-GPU / no-SVG (DEC-18/23): these build plain deck.gl-ready
// geometry (LineLayer segments + TextLayer label positions) — no GL context, no DOM,
// no store, no I/O — so they unit-test in node (DEC-29: interaction = a cheap CPU
// pre-pass whose output the GPU layers consume). Naming is domain-agnostic (DEC-28).
//
// The volcano recategorize mirrors `aggregate.volcanoPoints`' classifier so a threshold
// drag reclassifies exactly as the initial build did; the bracket geometry consumes the
// `statsKernels.packBrackets` output (stacked, non-colliding levels).

import type { RGBA, Segment, VolcanoDirection } from './chartLayers'
import type { Bracket } from '../data/statsKernels'

// ── 1. Volcano threshold classification (drag-driven recolor) ───────────────────

/** A volcano point in plot coordinates: `x` = effect size, `y` = significance. */
export interface VolcanoPoint2D {
  readonly label: string
  readonly x: number
  readonly y: number
}

/** A {@link VolcanoPoint2D} tagged with its up/down/ns direction under the thresholds. */
export interface CategorizedVolcanoPoint extends VolcanoPoint2D {
  readonly direction: VolcanoDirection
}

/**
 * Classify each point up / down / ns against the fold-change (`fcThreshold`, applied to
 * `|x|`) and significance (`pThreshold`, applied to `y`) thresholds. A point is
 * significant iff `|x| >= fcThreshold && y >= pThreshold`; a significant point is `up`
 * when `x > 0`, else `down`; otherwise `ns`. Mirrors `aggregate.volcanoPoints` so a
 * dragged threshold reclassifies identically. Pure — no GL, no I/O.
 */
export function volcanoCategorize(
  points: readonly VolcanoPoint2D[],
  fcThreshold: number,
  pThreshold: number,
): CategorizedVolcanoPoint[] {
  const fcT = Math.abs(fcThreshold)
  return points.map(p => {
    const sig = Math.abs(p.x) >= fcT && p.y >= pThreshold
    const direction: VolcanoDirection = !sig ? 'ns' : p.x > 0 ? 'up' : 'down'
    return { label: p.label, x: p.x, y: p.y, direction }
  })
}

// ── 2. Top-N labels (TextLayer) ─────────────────────────────────────────────────

/** A positioned text label for a deck.gl `TextLayer` (`getPosition`/`getText`). */
export interface TextLabel {
  readonly text: string
  readonly position: [number, number]
}

/**
 * Pick the `n` most-significant points (highest `y`; ties broken by larger `|x|`) and
 * return them as {@link TextLabel}s for a `TextLayer`. `n` is clamped to `[0, length]`;
 * a non-positive `n` yields none. Empty labels are skipped. Pure, stable ordering.
 */
export function topNLabels(points: readonly VolcanoPoint2D[], n: number): TextLabel[] {
  if (n <= 0 || points.length === 0) return []
  const ranked = [...points].sort((a, b) => b.y - a.y || Math.abs(b.x) - Math.abs(a.x))
  const take = Math.min(n, ranked.length)
  const out: TextLabel[] = []
  for (let i = 0; i < take; i++) {
    const p = ranked[i]
    if (p.label) out.push({ text: p.label, position: [p.x, p.y] })
  }
  return out
}

// ── 3. Significance-bracket geometry (LineLayer + TextLayer) ─────────────────────

export interface BracketGeometryOpts {
  /** Category center-to-center spacing (group index → x = index·spacing). Default 1. */
  spacing?: number
  /** Vertical drop of each end tick below the bracket bar (data units). Default 0.5. */
  tickDrop?: number
  /** Vertical offset of the label above the bracket bar (data units). Default 0.3. */
  labelDy?: number
  /** Line color for the bracket segments. Default a mid-grey. */
  color?: RGBA
}

/** The deck.gl-ready overlay for a packed bracket set: line segments + text labels. */
export interface BracketOverlay {
  readonly segments: Segment[]
  readonly labels: TextLabel[]
}

const DEFAULT_BRACKET_COLOR: RGBA = [90, 90, 90, 230]

/**
 * Turn packed significance brackets ({@link Bracket}[] from `statsKernels.packBrackets`)
 * into `LineLayer` segments + `TextLayer` labels. Each bracket spans its two group
 * centers (`min(i,j)·spacing` → `max(i,j)·spacing`) at height `y`, drawn as a horizontal
 * bar plus a short downward tick at each end (3 segments), with the significance label
 * centered above the bar. Pure geometry — no GL, no I/O.
 */
export function bracketSegments(
  brackets: readonly Bracket[],
  opts: BracketGeometryOpts = {},
): BracketOverlay {
  const spacing = opts.spacing ?? 1
  const tickDrop = opts.tickDrop ?? 0.5
  const labelDy = opts.labelDy ?? 0.3
  const color = opts.color ?? DEFAULT_BRACKET_COLOR

  const segments: Segment[] = []
  const labels: TextLabel[] = []
  for (const b of brackets) {
    const xi = Math.min(b.i, b.j) * spacing
    const xj = Math.max(b.i, b.j) * spacing
    const y = b.y
    // horizontal bar
    segments.push({ source: [xi, y], target: [xj, y], color })
    // end ticks dropping toward the groups
    segments.push({ source: [xi, y], target: [xi, y - tickDrop], color })
    segments.push({ source: [xj, y], target: [xj, y - tickDrop], color })
    labels.push({ text: b.label, position: [(xi + xj) / 2, y + labelDy] })
  }
  return { segments, labels }
}
