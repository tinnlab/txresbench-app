// engine.ts — the load + color pipeline shared by the store and per-panel stores.
// Pure async helpers over a `DataSource`. GENERIC names (DEC-28): color-by mode is
// `value` (a sparse value column) | `categorical` | `continuous` — never `gene`.
//
// BLEND MODE (BLEND_MODE_PLAN Phase 1) adds a fourth mode `blend` as an ADDITIVE
// discriminated-union member: ONE categorical column → base hue + ONE continuous column
// → lightness/alpha modulation, co-visualized per point. The three single-channel modes
// keep their EXACT current single-attribute shape + path (byte-identical) — blend rides
// as a separate union member sharing the common `key/colormap/scale/hidden` base, and
// `computeColoring` gains a `blend` branch that fills the new OPTIONAL `Coloring.blend`
// GPU payload (absent for every single-channel mode).

import type { DataSource, Positions } from './wire'
import { densify } from './wire'
import {
  continuousColors,
  categoricalColors,
  categoryColor,
  scaleLightness,
  colorbarDescriptor,
  legendDescriptor,
  resolveEffectivePalette,
  type ContinuousColormap,
  type DomainScale,
  type ColorbarDescriptor,
  type LegendDescriptor,
  type PaletteEntry,
  type CategoricalOverrides,
} from './color'
import {
  computeBlendEncoding,
  buildBlend2DLegend,
  normalizeMod,
  DEFAULT_ALPHA_FLOOR,
  type BlendChannel,
  type BlendEncoding,
  type Blend2DLegend,
} from './blend'
import { reduceBlendColumns, type BlendAggregateOp } from './blendReduce'

export type ColorMode = 'categorical' | 'continuous' | 'value'
export type { BlendChannel } from './blend'
export type { BlendAggregateOp } from './blendReduce'

/**
 * A color-by intent. The three single-channel modes keep their EXACT pre-blend shape
 * (`mode`/`key`/`colormap`/`scale`/`hidden`, all required); `blend` is ADDITIVE — the
 * `mode` value `'blend'` plus the OPTIONAL blend fields (`categoryKey`/`valueKey`/`channel`/…).
 * The blend fields are optional (not a disjoint union member) so an existing consumer that
 * reconstructs a single-channel `{ mode, key, colormap, scale, hidden }` literal — with `mode`
 * typed as the widened `ColorBy['mode']` — stays assignable without edits. Narrow to the
 * populated blend shape via `SingleChannelColorBy` / `BlendColorBy` where the extras are needed.
 */
export interface ColorBy {
  mode: ColorMode | 'blend'
  /** value-column key (mode 'value') or column id (categorical/continuous). For `blend` this
   *  echoes `categoryKey` (kept so the shared color-scale + existing `colorBy.key` consumers
   *  stay valid). */
  key: string
  colormap: ContinuousColormap
  scale: DomainScale
  /** category codes hidden via legend toggle (categorical only). */
  hidden: ReadonlySet<number>
  /** categorical: an ORDERED palette override (code → `palette[code]`); default = built-in 20. */
  palette?: readonly PaletteEntry[]
  /** categorical: an explicit BY-NAME color map (stable identity — wins over `palette`). */
  categoryColors?: Readonly<Record<string, PaletteEntry>>
  /** categorical: per-group DISPLAY-label override (raw category name → shown label). */
  categoryLabels?: Readonly<Record<string, string>>
  /** blend: the categorical column driving the base hue (defaults to `key`). */
  categoryKey?: string
  /** blend: the continuous column driving the modulation. */
  valueKey?: string
  /** blend: which visual channel the value modulates (default 'lightness'). */
  channel?: BlendChannel
  /** blend: the value at modulation 0 (default 0.1) — keeps low points faintly visible. */
  alphaFloor?: number
  /** blend: per-group domain (default true) vs shared-global. */
  perGroupDomain?: boolean
  /** blend Phase-2: MULTIPLE categorical columns CONCATENATED into one composite category
   *  (the observed cross-product). Present + length>1 ⇒ the multi-column reduce path; absent
   *  or length≤1 ⇒ the single-column path (falls back to `categoryKey`/`key`, byte-identical). */
  categoricalColumns?: readonly string[]
  /** blend Phase-2: MULTIPLE continuous columns AGGREGATED into one value (see `aggregate`).
   *  Present + length>1 ⇒ the multi-column reduce (normalize-per-column then aggregate);
   *  absent or length≤1 ⇒ the single-column path (falls back to `valueKey`). */
  continuousColumns?: readonly string[]
  /** blend Phase-2: the aggregate operator for `continuousColumns` (default 'mean'). */
  aggregate?: BlendAggregateOp
  /** blend Phase-2: optional per-continuous-column weights (honored for sum/mean). */
  continuousWeights?: readonly number[]
}

/** A single-channel color-by (mode narrowed away from `blend`; the pre-blend shape). */
export interface SingleChannelColorBy extends ColorBy {
  mode: ColorMode
}

/** A fully-populated blend color-by (categorical → hue + continuous → lightness/alpha). */
export interface BlendColorBy extends ColorBy {
  mode: 'blend'
  categoryKey: string
  valueKey: string
  channel: BlendChannel
}

export interface Coloring {
  colors: Uint8Array // N*4
  colorbar?: ColorbarDescriptor
  legend?: LegendDescriptor
  /** Present ONLY for `mode:'blend'`: the GPU two-attribute payload + the 2D legend.
   *  Absent for every single-channel mode (byte-identical to before). */
  blend?: BlendColoring
}

/** The blend GPU payload attached to `Coloring.blend` — the two per-point attributes +
 *  the modulation domain + the 2D legend descriptor. `colors` (on `Coloring`) still holds
 *  a CPU-computed blended RGBA fallback so a non-GPU consumer renders something. */
export interface BlendColoring extends BlendEncoding {
  readonly channel: BlendChannel
  readonly alphaFloor: number
  readonly legend2d: Blend2DLegend
}

/** Load a layout's positions (interleaved xy). */
export function loadPositions(source: DataSource, layoutId: string): Promise<Positions> {
  return source.positions(layoutId)
}

/** CPU blended RGBA (fallback + parity with the GPU shader): base hue per category code,
 *  modulated on LIGHTNESS (scale L by the floor→1 ramp) or ALPHA (floor→1 ramp). `m` is
 *  the normalized [0,1] modulation per point (per-group ⇒ `modValue`, global ⇒ normalized
 *  over `modDomain`). Mirrors the GLSL blend snippet. */
function blendColorsCpu(
  enc: BlendEncoding,
  channel: BlendChannel,
  alphaFloor: number,
  palette?: readonly (readonly [number, number, number])[],
): Uint8Array {
  const n = enc.codes.length
  const out = new Uint8Array(n * 4)
  const [lo, hi] = enc.modDomain
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const code = enc.codes[i] | 0
    const m = enc.perGroupDomain ? enc.modValue[i] : normalizeMod(enc.modValue[i], lo, hi)
    const factor = alphaFloor + (1 - alphaFloor) * m // mix(alphaFloor, 1, m)
    // Honor an EFFECTIVE palette (by-name / custom / auto-extended) for the base hue; absent ⇒
    // the built-in `categoryColor` (byte-identical to the pre-override blend).
    const base = palette ? palette[code] ?? categoryColor(code) : categoryColor(code)
    if (channel === 'alpha') {
      out[o] = base[0]
      out[o + 1] = base[1]
      out[o + 2] = base[2]
      out[o + 3] = Math.round(factor * 255)
    } else {
      const [r, g, b] = scaleLightness(base, factor)
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = 255
    }
  }
  return out
}

/**
 * Compute the RGBA color buffer + legend/colorbar for a color-by intent. Color-by-VALUE
 * densifies the sparse column first (G9: densify-then-color, not zero-copy). `mode:'blend'`
 * additionally fills `Coloring.blend` (the GPU two-attribute payload + 2D legend); every
 * single-channel mode returns the EXACT pre-blend result (no `blend` field).
 */
export async function computeColoring(
  source: DataSource,
  colorBy: ColorBy,
): Promise<Coloring> {
  switch (colorBy.mode) {
    case 'value': {
      const col = await source.valueColumn(colorBy.key)
      const dense = densify(col)
      const { colors, domain } = continuousColors(dense, {
        colormap: colorBy.colormap,
        scale: colorBy.scale,
        zeroTransparent: true,
      })
      return { colors, colorbar: colorbarDescriptor(colorBy.colormap, domain) }
    }
    case 'continuous': {
      const col = await source.continuous(colorBy.key)
      const { colors, domain } = continuousColors(col.value, {
        colormap: colorBy.colormap,
        scale: colorBy.scale,
      })
      return { colors, colorbar: colorbarDescriptor(colorBy.colormap, domain) }
    }
    case 'blend': {
      const ov = categoricalOverrides(colorBy)
      const alphaFloor = colorBy.alphaFloor ?? DEFAULT_ALPHA_FLOOR
      const channel = colorBy.channel ?? 'lightness'
      const perGroupDomain = colorBy.perGroupDomain ?? true
      // Resolve the effective categorical + continuous key LISTS (Phase-2 arrays override the
      // single `categoryKey`/`valueKey`; empty arrays fall back to the single keys).
      const catKeys = resolveBlendKeys(colorBy.categoricalColumns, colorBy.categoryKey ?? colorBy.key)
      const contKeys = resolveBlendKeys(colorBy.continuousColumns, colorBy.valueKey)
      const multi = catKeys.length > 1 || contKeys.length > 1

      if (!multi) {
        // ── SINGLE-column path (Phase 1 — byte-identical) ──────────────────────
        const categoryKey = catKeys[0] ?? colorBy.key
        const valueKey = contKeys[0]
        if (!valueKey) {
          // Malformed blend (no value column bound) — degrade gracefully to the plain
          // categorical hue rather than throwing on the render path.
          const col = await source.categorical(categoryKey)
          return {
            colors: categoricalColors(col.codes, { hidden: colorBy.hidden, categories: col.categories, ...ov }),
            legend: legendDescriptor(col.categories, ov),
          }
        }
        const [cat, cont] = await Promise.all([
          source.categorical(categoryKey),
          source.continuous(valueKey),
        ])
        const enc = computeBlendEncoding(cat.codes, cont.value, { perGroupDomain, scale: colorBy.scale })
        const effPalette = ov ? resolveEffectivePalette(cat.categories, ov) : undefined
        const legend2d = buildBlend2DLegend(cat.categories, {
          channel,
          alphaFloor,
          perGroupDomain,
          valueDomain: perGroupDomain ? [0, 1] : enc.globalDomain,
        })
        return {
          colors: blendColorsCpu(enc, channel, alphaFloor, effPalette),
          blend: { ...enc, channel, alphaFloor, legend2d },
        }
      }

      // ── MULTI-column REDUCE path (Phase 2) ───────────────────────────────────
      // Concat N categorical columns → one composite category; aggregate M continuous
      // columns → one value; then feed the reduced pair into the SAME Phase-1 encode.
      const [cats, conts] = await Promise.all([
        Promise.all(catKeys.map(k => source.categorical(k))),
        Promise.all(contKeys.map(k => source.continuous(k))),
      ])
      const reduced = reduceBlendColumns({
        categoricalColumns: cats.map(c => ({ codes: c.codes, categories: c.categories })),
        continuousColumns: conts.map(c => c.value),
        operator: colorBy.aggregate,
        weights: colorBy.continuousWeights,
        // `scale` (log/sqrt) is applied inside the reduce — per raw value for a single continuous
        // column, and per column before the M≥2 normalize. So the encode below must NOT scale again.
        scale: colorBy.scale,
      })
      const effPalette = resolveEffectivePalette(reduced.compositeCategories, ov)
      if (contKeys.length === 0) {
        // Multiple categorical columns, NO continuous — a plain composite-category hue.
        // NOTE: `colorBy.hidden` indexes the SINGLE-column domain, but `compositeCodes` index the
        // composite cross-product domain — the codes don't correspond, so applying `hidden` here
        // would hide the WRONG composite categories. Hide nothing in composite mode (a legend
        // toggle over composite categories would need composite-domain codes, a future concern).
        return {
          colors: categoricalColors(reduced.compositeCodes, {
            hidden: new Set<number>(),
            categories: reduced.compositeCategories,
            ...ov,
          }),
          legend: legendDescriptor(reduced.compositeCategories, ov),
        }
      }
      // The reduce ALREADY applied `colorBy.scale` (per raw value for M===1, per column for M≥2),
      // so the encode must be LINEAR — passing `colorBy.scale` here would double-transform the value
      // (a log/sqrt scale applied twice). computeBlendEncoding still normalizes it per group.
      const encScale: DomainScale = 'linear'
      const enc = computeBlendEncoding(reduced.compositeCodes, reduced.aggregatedValue, {
        perGroupDomain,
        scale: encScale,
      })
      const legend2d = buildBlend2DLegend(
        reduced.compositeCategories,
        {
          channel,
          alphaFloor,
          perGroupDomain,
          valueDomain: perGroupDomain ? [0, 1] : enc.globalDomain,
        },
        effPalette,
      )
      return {
        colors: blendColorsCpu(enc, channel, alphaFloor, effPalette),
        blend: { ...enc, channel, alphaFloor, legend2d },
      }
    }
    case 'categorical':
    default: {
      const col = await source.categorical(colorBy.key)
      const ov = categoricalOverrides(colorBy)
      // No overrides + ≤20 groups ⇒ `categories`+`ov` resolve to the built-in palette, so the
      // color buffer + legend are byte-identical to the pre-override path.
      const colors = categoricalColors(col.codes, {
        hidden: colorBy.hidden,
        categories: col.categories,
        ...ov,
      })
      return { colors, legend: legendDescriptor(col.categories, ov) }
    }
  }
}

/** Resolve a blend column-key LIST: the non-empty `columns` array wins (Phase-2 multi), else
 *  the single `fallback` key (`[fallback]` when set, `[]` when absent). */
function resolveBlendKeys(
  columns: readonly string[] | undefined,
  fallback: string | undefined,
): string[] {
  const filtered = (columns ?? []).filter((k): k is string => typeof k === 'string' && k.length > 0)
  if (filtered.length > 0) return filtered
  return fallback ? [fallback] : []
}

/** Extract the categorical override bundle from a `ColorBy`, or `undefined` when none is set
 *  (so the no-override path resolves to the built-in palette + raw labels — byte-identical). */
export function categoricalOverrides(colorBy: ColorBy): CategoricalOverrides | undefined {
  if (!colorBy.palette && !colorBy.categoryColors && !colorBy.categoryLabels) return undefined
  return {
    ...(colorBy.palette ? { palette: colorBy.palette } : {}),
    ...(colorBy.categoryColors ? { categoryColors: colorBy.categoryColors } : {}),
    ...(colorBy.categoryLabels ? { categoryLabels: colorBy.categoryLabels } : {}),
  }
}

export const DEFAULT_COLOR_BY: ColorBy = {
  mode: 'categorical',
  key: 'group',
  colormap: 'viridis',
  scale: 'linear',
  hidden: new Set<number>(),
}
