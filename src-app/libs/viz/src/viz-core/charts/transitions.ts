// transitions.ts — per-plot OPT-IN GPU attribute-transition config for the AGGREGATED,
// attribute-based chart Views (bar / box / violin / dotplot / histogram). Mirrors the
// per-plot `DataZoomConfig` shape (`AxisDataZoom.tsx`): `false | { duration?, easing? }`,
// DEFAULT OFF (opt-in) — so every existing render is byte-identical until a plot explicitly
// enables it (existing pixel-immediate e2e stays green). When enabled, a View spreads the
// mapped object into a deck.gl layer's `transitions` prop, so deck GPU-interpolates the named
// accessor attributes between updates (a recolor / data change tweens instead of snapping).
//
// PURE: no React, no deck import — it only maps the config → the plain object deck's layers
// accept (accessor name → { duration, easing-fn }), so the whole module unit-tests in node.
// The dense 10M-scatter path (`DeckScatterCanvas`) + the heatmap texture path deliberately
// never call this: double-resident transition buffers blow the dense perf budget, and a
// BitmapLayer texture swap is not an attribute tween.

/** Easing vocabulary (minimal + validated). `cubic-in-out` is the smooth default. */
export type TransitionEasing = 'linear' | 'cubic-in-out'

/**
 * Per-plot transition config. `false` (or omitted) = OFF (instant, byte-identical to today).
 * Same "nothing hardcoded, per-plot" shape as `DataZoomConfig`.
 */
export interface TransitionConfig {
  /** Tween duration in milliseconds. Default {@link DEFAULT_TRANSITION_DURATION} (300). */
  readonly duration?: number
  /** Easing curve. Default {@link DEFAULT_TRANSITION_EASING} (`cubic-in-out`). */
  readonly easing?: TransitionEasing
}

/** The per-plot prop shape (mirrors `DataZoomProp`): `false` = fully off. */
export type TransitionProp = false | TransitionConfig

/** Default tween duration (ms) when an enabled config names none. */
export const DEFAULT_TRANSITION_DURATION = 300
/** Default easing curve when an enabled config names none. */
export const DEFAULT_TRANSITION_EASING: TransitionEasing = 'cubic-in-out'
/** The recognized easing names, for validation + error messages. */
export const TRANSITION_EASINGS: readonly TransitionEasing[] = ['linear', 'cubic-in-out']

/** The deck.gl accessor names an aggregated View may animate. */
export type TransitionAccessor = 'getFillColor' | 'getPosition' | 'getRadius' | 'getLineColor'

/** One resolved deck attribute-transition setting (interpolation). */
export interface DeckAttributeTransition {
  readonly duration: number
  readonly easing: (t: number) => number
}

/** A deck.gl `transitions` object: accessor name → its interpolation setting. */
export type DeckTransitions = Partial<Record<TransitionAccessor, DeckAttributeTransition>>

/** Easing implementations. `cubic-in-out` is the standard smoothstep-cubic. Pure. */
const EASINGS: Record<TransitionEasing, (t: number) => number> = {
  linear: t => t,
  'cubic-in-out': t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
}

/** Resolve an easing name → its pure `(t)=>t'` function (unknown ⇒ the default). */
export function easingFn(easing: TransitionEasing): (t: number) => number {
  return EASINGS[easing] ?? EASINGS[DEFAULT_TRANSITION_EASING]
}

/** True iff the config turns transitions ON (a config object; not `false`/undefined). */
export function transitionsEnabled(config: TransitionProp | undefined): config is TransitionConfig {
  return !!config
}

/**
 * Map a per-plot `TransitionConfig` → the deck.gl `transitions` object over the given
 * accessors. Returns `undefined` when transitions are OFF (`false`/undefined) OR no accessors
 * are supplied — so the View spreads NO `transitions` key and the layer stays byte-identical
 * (instant). The default-off contract lives HERE (one place), so every aggregated View wires
 * it the same way. PURE.
 */
export function deckTransitions(
  config: TransitionProp | undefined,
  accessors: readonly TransitionAccessor[],
): DeckTransitions | undefined {
  if (!config || accessors.length === 0) return undefined
  const duration = config.duration ?? DEFAULT_TRANSITION_DURATION
  const easing = easingFn(config.easing ?? DEFAULT_TRANSITION_EASING)
  const out: DeckTransitions = {}
  for (const a of accessors) out[a] = { duration, easing }
  return out
}

/**
 * Minimal validation of a per-plot transitions value (the declarative-option path). Returns a
 * human error STRING (no `[viz]` prefix — the caller adds series context) or `null` when valid.
 * `false`/`undefined` are valid (off). A config object's `duration` (if present) must be a
 * non-negative finite number of ms; its `easing` (if present) must be a known name.
 */
export function transitionConfigError(config: unknown): string | null {
  if (config === false || config === undefined || config === null) return null
  if (typeof config !== 'object') return 'transitions must be `false` or an object'
  const c = config as Record<string, unknown>
  if (c.duration !== undefined) {
    const d = c.duration
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) {
      return 'transitions.duration must be a non-negative number (milliseconds)'
    }
  }
  if (c.easing !== undefined && c.easing !== 'linear' && c.easing !== 'cubic-in-out') {
    return `transitions.easing must be one of ${TRANSITION_EASINGS.join(', ')}`
  }
  return null
}
