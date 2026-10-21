// blend.ts — PURE Phase-1 blend-mode encoding math (BLEND_MODE_PLAN Phase 1). The
// "scatter/spatial blend": ONE categorical column → base HUE (palette LUT) + ONE
// continuous column → LIGHTNESS (default) or ALPHA modulation, co-visualized in a
// single per-point mark ("which cluster AND how much").
//
// This file is PURE (no React, no deck, no GPU) so the reduce math is unit-testable in
// the node vitest pass. `data/engine.ts::computeColoring` calls it for `mode:'blend'`;
// the GPU two-attribute path (`instanceColorValue` = category codes, `instanceModValue`
// = the normalized modulation) + the DOM 2D legend both consume its output.
//
// DOMAIN CHOICE (the load-bearing option): PER-GROUP (default) normalizes each point
// WITHIN its own category's [min,max] — every cluster's internal variation is visible
// (the legacy "split the visual map per group" idiom). SHARED-GLOBAL normalizes over one
// domain so values are comparable ACROSS clusters. Per-group pre-normalizes on the CPU
// (modValue ∈ [0,1], modDomain = [0,1]); global keeps the scaled raw value + a real
// modDomain the shader normalizes (so `coordination/colorScale` can widen it across
// linked panels).

import { applyScale, categoryColor, rgbToHex, type DomainScale } from './color'

/** Which visual channel the continuous value modulates. */
export type BlendChannel = 'lightness' | 'alpha'

/** Default alpha/lightness floor — the value at modulation 0 (so low points stay faintly
 *  visible rather than vanishing to pure transparent/black). */
export const DEFAULT_ALPHA_FLOOR = 0.1

/** The GPU two-attribute payload + the modulation domain, produced by `computeBlendEncoding`. */
export interface BlendEncoding {
  /** Category codes as Float32 → `instanceColorValue` (sampled from the palette LUT). */
  readonly codes: Float32Array
  /** The modulation attribute → `instanceModValue`. Per-group: normalized [0,1]; global:
   *  the scaled raw value (the shader normalizes over `modDomain`). */
  readonly modValue: Float32Array
  /** The domain the shader normalizes `modValue` over. Per-group: `[0,1]` (already
   *  normalized); global: the scaled `[min,max]` (a linked scope may widen it). */
  readonly modDomain: [number, number]
  /** Whether per-group normalization was applied (vs shared-global). */
  readonly perGroupDomain: boolean
  /** The scaled GLOBAL `[min,max]` across all finite values (for the legend / coordination). */
  readonly globalDomain: [number, number]
  /** Per-category scaled `[min,max]` (for the legend + per-group math tests). */
  readonly groupDomains: Map<number, [number, number]>
}

/** Normalize `v` into `[0,1]` over `[lo,hi]`; a zero/degenerate span maps to `1` (a group
 *  with no internal variation shows at FULL modulation, not dim — it isn't "low", it's
 *  uniform). Non-finite `v` → `0`. */
export function normalizeMod(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  const span = hi - lo
  if (span <= 0) return 1
  const t = (v - lo) / span
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Reduce a (categorical codes + continuous values) pair to the blend GPU attributes +
 * modulation domain. `scale` (log/sqrt) is applied to the values BEFORE any domain math.
 * PER-GROUP (default) normalizes each point within its own category's scaled [min,max]
 * → `modValue ∈ [0,1]`, `modDomain = [0,1]`. GLOBAL keeps the scaled raw value →
 * `modDomain = the scaled global [min,max]`.
 */
export function computeBlendEncoding(
  codes: Uint16Array,
  values: Float32Array,
  opts: { perGroupDomain?: boolean; scale?: DomainScale } = {},
): BlendEncoding {
  const perGroupDomain = opts.perGroupDomain ?? true
  const scale = opts.scale ?? 'linear'
  const n = Math.min(codes.length, values.length)

  const codesF = new Float32Array(n)
  const scaled = new Float32Array(n)
  const groupDomains = new Map<number, [number, number]>()
  let gLo = Infinity
  let gHi = -Infinity

  for (let i = 0; i < n; i++) {
    const code = codes[i]
    codesF[i] = code
    const s = applyScale(values[i], scale)
    scaled[i] = s
    if (!Number.isFinite(s)) continue
    if (s < gLo) gLo = s
    if (s > gHi) gHi = s
    const dom = groupDomains.get(code)
    if (dom === undefined) groupDomains.set(code, [s, s])
    else {
      if (s < dom[0]) dom[0] = s
      if (s > dom[1]) dom[1] = s
    }
  }

  const globalDomain: [number, number] = Number.isFinite(gLo) && Number.isFinite(gHi) ? [gLo, gHi] : [0, 1]

  const modValue = new Float32Array(n)
  if (perGroupDomain) {
    for (let i = 0; i < n; i++) {
      const dom = groupDomains.get(codes[i])
      modValue[i] = dom ? normalizeMod(scaled[i], dom[0], dom[1]) : 0
    }
    return {
      codes: codesF,
      modValue,
      modDomain: [0, 1],
      perGroupDomain: true,
      globalDomain,
      groupDomains,
    }
  }
  // Global: hand the shader the scaled raw value + the real domain (a linked color scope
  // may widen `modDomain` downstream so identical values match across panels).
  for (let i = 0; i < n; i++) modValue[i] = Number.isFinite(scaled[i]) ? scaled[i] : globalDomain[0]
  return {
    codes: codesF,
    modValue,
    modDomain: globalDomain,
    perGroupDomain: false,
    globalDomain,
    groupDomains,
  }
}

// ── 2D legend descriptor (hue rows × value ramp) ──────────────────────────────

/** One category row of the 2D legend: its stable hue + label. */
export interface Blend2DLegendRow {
  readonly code: number
  readonly label: string
  /** The category's base hue as `#rrggbb` (full lightness — the ramp's high end). */
  readonly hex: string
}

/** The 2D legend descriptor: category HUE rows × a value-RAMP axis (low→full). */
export interface Blend2DLegend {
  readonly kind: 'blend'
  readonly channel: BlendChannel
  readonly alphaFloor: number
  readonly rows: readonly Blend2DLegendRow[]
  /** The value axis shown under the ramp. Per-group ⇒ `[0,1]` (relative "low→high" within
   *  each cluster); global ⇒ the scaled `[min,max]` (comparable across clusters). */
  readonly valueDomain: readonly [number, number]
  readonly perGroupDomain: boolean
}

/** Build the 2D legend descriptor for a set of category labels + the resolved blend params.
 *  `colors` is the OPTIONAL effective per-code base hue (by-name / custom / auto-extended
 *  palette — used by the Phase-2 multi-column composite legend so combos beyond the built-in
 *  20 get distinct hues); ABSENT ⇒ the built-in `categoryColor` cycle (Phase-1 byte-identical). */
export function buildBlend2DLegend(
  categories: readonly string[],
  opts: {
    channel: BlendChannel
    alphaFloor: number
    perGroupDomain: boolean
    valueDomain: readonly [number, number]
  },
  colors?: readonly (readonly [number, number, number])[],
): Blend2DLegend {
  return {
    kind: 'blend',
    channel: opts.channel,
    alphaFloor: opts.alphaFloor,
    rows: categories.map((label, code) => ({
      code,
      label,
      hex: rgbToHex(colors?.[code] ?? categoryColor(code)),
    })),
    valueDomain: opts.valueDomain,
    perGroupDomain: opts.perGroupDomain,
  }
}
