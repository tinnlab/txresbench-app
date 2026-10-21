// color.ts — the color pipeline (ITEM-3). Continuous values → a perceptual
// colormap; categorical codes → a stable colorblind-safe palette. Colors are
// PRECOMPUTED into a `Uint8Array[N*4]` on the CPU once (deck.gl research §5,
// pattern A) and fed to `getFillColor {size:4, normalized:true}` — recolor = swap
// the typed array + bump one updateTrigger, never a CPU rebuild per frame.

import {
  interpolateViridis, interpolateMagma, interpolateInferno, interpolatePlasma, interpolateCividis,
  interpolateTurbo, interpolateWarm, interpolateCool, interpolateCubehelixDefault,
  interpolateBlues, interpolateGreens, interpolateGreys, interpolateOranges, interpolatePurples, interpolateReds,
  interpolateBuGn, interpolateBuPu, interpolateGnBu, interpolateOrRd, interpolatePuBu, interpolatePuBuGn,
  interpolatePuRd, interpolateRdPu, interpolateYlGn, interpolateYlGnBu, interpolateYlOrBr, interpolateYlOrRd,
  interpolateBrBG, interpolatePRGn, interpolatePiYG, interpolatePuOr, interpolateRdBu, interpolateRdGy,
  interpolateRdYlBu, interpolateRdYlGn, interpolateSpectral,
} from 'd3-scale-chromatic'

// The full continuous colormap vocabulary (matplotlib / scanpy names): perceptual (viridis family),
// sequential single- + multi-hue, and diverging. Drives the plot-editing colormap picker.
export type ContinuousColormap =
  // perceptual
  | 'viridis' | 'magma' | 'inferno' | 'plasma' | 'cividis' | 'turbo' | 'warm' | 'cool' | 'cubehelix'
  // sequential single-hue
  | 'blues' | 'greens' | 'greys' | 'oranges' | 'purples' | 'reds'
  // sequential multi-hue
  | 'bugn' | 'bupu' | 'gnbu' | 'orrd' | 'pubu' | 'pubugn' | 'purd' | 'rdpu' | 'ylgn' | 'ylgnbu' | 'ylorbr' | 'ylorrd'
  // diverging
  | 'brbg' | 'prgn' | 'piyg' | 'puor' | 'rdbu' | 'rdgy' | 'rdylbu' | 'rdylgn' | 'spectral'

export const INTERPOLATORS: Record<ContinuousColormap, (t: number) => string> = {
  viridis: interpolateViridis, magma: interpolateMagma, inferno: interpolateInferno, plasma: interpolatePlasma,
  cividis: interpolateCividis, turbo: interpolateTurbo, warm: interpolateWarm, cool: interpolateCool,
  cubehelix: interpolateCubehelixDefault,
  blues: interpolateBlues, greens: interpolateGreens, greys: interpolateGreys, oranges: interpolateOranges,
  purples: interpolatePurples, reds: interpolateReds,
  bugn: interpolateBuGn, bupu: interpolateBuPu, gnbu: interpolateGnBu, orrd: interpolateOrRd, pubu: interpolatePuBu,
  pubugn: interpolatePuBuGn, purd: interpolatePuRd, rdpu: interpolateRdPu, ylgn: interpolateYlGn,
  ylgnbu: interpolateYlGnBu, ylorbr: interpolateYlOrBr, ylorrd: interpolateYlOrRd,
  brbg: interpolateBrBG, prgn: interpolatePRGn, piyg: interpolatePiYG, puor: interpolatePuOr, rdbu: interpolateRdBu,
  rdgy: interpolateRdGy, rdylbu: interpolateRdYlBu, rdylgn: interpolateRdYlGn, spectral: interpolateSpectral,
}

export const DEFAULT_CONTINUOUS_COLORMAP: ContinuousColormap = 'viridis'

/** Every selectable continuous colormap, grouped (perceptual → sequential → diverging). Drives the picker. */
export const CONTINUOUS_COLORMAPS: readonly ContinuousColormap[] = [
  'viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'warm', 'cool', 'cubehelix',
  'blues', 'greens', 'greys', 'oranges', 'purples', 'reds',
  'bugn', 'bupu', 'gnbu', 'orrd', 'pubu', 'pubugn', 'purd', 'rdpu', 'ylgn', 'ylgnbu', 'ylorbr', 'ylorrd',
  'brbg', 'prgn', 'piyg', 'puor', 'rdbu', 'rdgy', 'rdylbu', 'rdylgn', 'spectral',
]

/** Domain transforms applied before normalization (legacy `ContinuousValueScale`). */
export type DomainScale = 'linear' | 'log2' | 'log10' | 'sqrt'

/**
 * A colorblind-safe qualitative palette (Tableau-10 + extensions), used for
 * categorical coloring. Stable per code index so a label keeps its color across
 * every panel (the Vitessce "stable color-per-label" rule).
 */
export const CATEGORICAL_PALETTE: readonly (readonly [number, number, number])[] = [
  [31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40],
  [148, 103, 189], [140, 86, 75], [227, 119, 194], [127, 127, 127],
  [188, 189, 34], [23, 190, 207], [174, 199, 232], [255, 187, 120],
  [152, 223, 138], [255, 152, 150], [197, 176, 213], [196, 156, 148],
  [247, 182, 210], [199, 199, 199], [219, 219, 141], [158, 218, 229],
]

/** Okabe-Ito — the CVD-safe qualitative standard (Wong, Nature Methods 2010), the DEFAULT categorical
 *  palette (ITEM-11 / DEC-1). Beyond its 8 colors we extend with the tab20 cycle (color alone can't stay
 *  CVD-distinct past ~8 — the UI nudges to facet). */
export const OKABE_ITO_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [230, 159, 0], [86, 180, 233], [0, 158, 115],
  [240, 228, 66], [0, 114, 178], [213, 94, 0], [204, 121, 167],
]
/** The DEFAULT categorical palette (ITEM-11): Okabe-Ito first, then the tab20 cycle for >8 groups. ONE
 *  source so `categoryColor`, `categoricalColors`, and `resolveEffectivePalette` stay consistent (a
 *  divergence would mismatch plot marks vs legend swatches). */
export const DEFAULT_CATEGORICAL_PALETTE: readonly (readonly [number, number, number])[] = [
  ...OKABE_ITO_RGB,
  ...CATEGORICAL_PALETTE,
]
function defaultCatColor(code: number): readonly [number, number, number] {
  return DEFAULT_CATEGORICAL_PALETTE[((code % DEFAULT_CATEGORICAL_PALETTE.length) + DEFAULT_CATEGORICAL_PALETTE.length) % DEFAULT_CATEGORICAL_PALETTE.length]
}

/**
 * QUALITATIVE palettes for categorical coloring — the matplotlib / scanpy vocabulary a single-cell user
 * expects (tab10/tab20 = scanpy's `default_20`; ColorBrewer Set1/2/3, Paired, Dark2, Accent, Pastel1/2).
 * Selecting one auto-populates every group's color (used as the ORDERED palette seed). Hex strings.
 */
export const QUALITATIVE_PALETTES: Record<string, readonly string[]> = {
  // Okabe-Ito FIRST — it's the DEFAULT categorical palette (a fresh cell uses it), derived from the SAME
  // `OKABE_ITO_RGB` source (via the `rgbToHex` helper below, hoisted) so the picker option matches the
  // marks/legend exactly. `QUALITATIVE_PALETTE_KEY_DEFAULT` names it so the picker can label it as default.
  'Okabe-Ito': OKABE_ITO_RGB.map(c => rgbToHex(c)),
  tab10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
  tab20: ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'],
  Set1: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999'],
  Set2: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  Set3: ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'],
  Paired: ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'],
  Dark2: ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
  Accent: ['#7fc97f', '#beaed4', '#fdc086', '#ffff99', '#386cb0', '#f0027f', '#bf5b17', '#666666'],
  Pastel1: ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6', '#ffffcc', '#e5d8bd', '#fddaec', '#f2f2f2'],
  Pastel2: ['#b3e2cd', '#fdcdac', '#cbd5e8', '#f4cae4', '#e6f5c9', '#fff2ae', '#f1e2cc', '#cccccc'],
}

/** Every selectable qualitative palette name, in a stable order (drives the categorical palette picker). */
export const QUALITATIVE_PALETTE_NAMES: readonly string[] = Object.keys(QUALITATIVE_PALETTES)
/** The palette name a fresh categorical cell uses by default (Okabe-Ito) — the picker pre-selects it. */
export const QUALITATIVE_PALETTE_KEY_DEFAULT = 'Okabe-Ito'

/** The transparent "out-of-range / unselected" color (legacy `__out_of_range__`). */
export const OUT_OF_RANGE: readonly [number, number, number, number] = [0, 0, 0, 0]

// ── categorical override layer (custom palette + by-name map + display labels) ────────
// ADDITIVE over the fixed `CATEGORICAL_PALETTE`. A palette entry is a CSS color string
// (`#rrggbb` / `rgb(r,g,b)`) OR a byte RGB triple. The NO-override path resolves to the
// built-in palette EXACTLY as before (byte-identical for ≤20 groups); >20 groups (or a short
// custom palette) AUTO-EXTEND with generated maximally-distinct colors instead of cycling.

/** A single palette color: a CSS string or a byte RGB triple. */
export type PaletteEntry = string | readonly [number, number, number]

/** The optional categorical override bundle carried on a `ColorBy` / passed to a render site. */
export interface CategoricalOverrides {
  /** An ORDERED override (code → `palette[code]`); default = the built-in 20-palette. */
  readonly palette?: readonly PaletteEntry[]
  /** An explicit BY-NAME map (stable identity — wins over the ordered palette per category). */
  readonly categoryColors?: Readonly<Record<string, PaletteEntry>>
  /** Per-group DISPLAY-label override (raw category name → shown label). */
  readonly categoryLabels?: Readonly<Record<string, string>>
  /** HIDDEN group codes (interactive legend hide/show). A grouped chart (box/violin/bar/dotplot/heatmap)
   *  DROPS a hidden group entirely — its column collapses and the remaining groups re-space (reflow), the
   *  analog of hiding a scatter category. Codes index by the group's category order. Absent/empty ⇒ all shown.
   *  Resolve visible groups + their original codes via `visibleByCode` so emphasis stays index-aligned. */
  readonly hiddenCodes?: ReadonlySet<number>
}

/** Collapse a per-group array to the VISIBLE groups (dropping `hidden` codes), returning the filtered
 *  items in collapsed order PLUS their ORIGINAL codes (so a chart can re-space the groups yet still map
 *  each visible mark back to its category code for cross-plot emphasis). No hidden ⇒ identity (same refs). */
export function visibleByCode<T>(
  items: readonly T[],
  hidden: ReadonlySet<number> | undefined,
): { items: T[]; codes: number[] } {
  if (!hidden || hidden.size === 0) return { items: items.slice(), codes: items.map((_, i) => i) }
  const outItems: T[] = []
  const codes: number[] = []
  items.forEach((it, i) => {
    if (!hidden.has(i)) {
      outItems.push(it)
      codes.push(i)
    }
  })
  return { items: outItems, codes }
}

/** True in dev/test builds (Vite `import.meta.env.DEV` / node `NODE_ENV`). Gates the
 *  auto-extend shortfall warning out of release builds (mirrors `option/parse.ts`). */
function isDevEnv(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
    if (env && typeof env.DEV === 'boolean') return env.DEV
  } catch {
    /* import.meta unavailable (plain node) — fall through */
  }
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
  } catch {
    return false
  }
}

/** Normalize a palette entry (CSS string or byte triple) to a byte RGB triple. */
function toRgbTriple(entry: PaletteEntry): [number, number, number] {
  if (typeof entry === 'string') return parseRgb(entry)
  return [entry[0], entry[1], entry[2]]
}

/** Golden-angle hue step (deg) — the classic maximally-distinct sequential-hue generator. */
const GOLDEN_ANGLE_DEG = 137.508

/**
 * Return `n` colors seeded from `seed`. `n <= seed.length` ⇒ the seed's first `n` entries
 * UNCHANGED (byte-identical prefix — this is what keeps the built-in ≤20-group path identical).
 * `n > seed.length` ⇒ the seed prefix followed by `n − seed.length` GENERATED maximally-distinct
 * colors (golden-angle hue rotation + lightness/saturation banding), never a silent cycle. A tiny
 * lightness-nudge guard keeps a generated color from colliding byte-for-byte with an earlier one.
 */
export function extendPalette(
  seed: readonly (readonly [number, number, number])[],
  n: number,
): [number, number, number][] {
  const base: [number, number, number][] = seed.map(c => [c[0], c[1], c[2]])
  if (n <= base.length) return base.slice(0, n)
  const out = base.slice()
  const seen = new Set(out.map(c => c.join(',')))
  let j = 0
  while (out.length < n) {
    const hue = (j * GOLDEN_ANGLE_DEG) % 360
    const sat = 0.62 + 0.12 * (j % 2) // 0.62 / 0.74 alternating
    let light = 0.45 + 0.18 * ((j % 3) - 1) // 0.27 / 0.45 / 0.63 banded
    let rgb = hslToRgb([hue, sat, light])
    // Defensive de-dup: nudge lightness until the byte triple is novel (bounded).
    while (seen.has(rgb.join(',')) && light < 0.92) {
      light += 0.05
      rgb = hslToRgb([hue, sat, light])
    }
    seen.add(rgb.join(','))
    out.push(rgb)
    j++
  }
  return out
}

/**
 * Resolve the EFFECTIVE per-code color array for `categories` (length = `categories.length`).
 * Precedence per code: an explicit BY-NAME `categoryColors[name]` wins → else the ORDERED
 * `palette[code]` (default = the built-in 20) → auto-extended when the ordered palette is shorter
 * than the category count. NO overrides + ≤20 groups ⇒ byte-identical to `categoryColor(code)`.
 */
export function resolveEffectivePalette(
  categories: readonly string[],
  overrides?: CategoricalOverrides,
): [number, number, number][] {
  const n = categories.length
  const custom = overrides?.palette && overrides.palette.length > 0
  const seed: [number, number, number][] = custom
    ? overrides!.palette!.map(toRgbTriple)
    : DEFAULT_CATEGORICAL_PALETTE.map(c => [c[0], c[1], c[2]])
  if (seed.length < n && isDevEnv()) {
    console.warn(
      custom
        ? `[viz] custom palette has ${seed.length} color(s) for ${n} categories — auto-extending with generated distinct colors (no silent cycle)`
        : `[viz] ${n} categories exceed the built-in ${seed.length}-color palette — auto-extending with generated distinct colors (no silent cycle)`,
    )
  }
  const ordered = extendPalette(seed, Math.max(n, seed.length))
  const byName = overrides?.categoryColors
  const out: [number, number, number][] = []
  for (let code = 0; code < n; code++) {
    const name = categories[code]
    if (byName && Object.prototype.hasOwnProperty.call(byName, name)) {
      out.push(toRgbTriple(byName[name]))
    } else {
      out.push(ordered[code] ?? ordered[code % ordered.length])
    }
  }
  return out
}

/** Resolve a category's DISPLAY label: `categoryLabels[raw]` if set, else the raw name. */
export function displayCategory(
  rawName: string,
  categoryLabels?: Readonly<Record<string, string>>,
): string {
  if (categoryLabels && Object.prototype.hasOwnProperty.call(categoryLabels, rawName)) {
    return categoryLabels[rawName]
  }
  return rawName
}

export function applyScale(v: number, scale: DomainScale): number {
  switch (scale) {
    case 'log2':
      return Math.log2(v + 1)
    case 'log10':
      return Math.log10(v + 1)
    case 'sqrt':
      return Math.sqrt(Math.max(v, 0))
    default:
      return v
  }
}

// ── RGB ↔ HSL (blend-mode lightness modulation) ───────────────────────────────
// Pure byte-triple ↔ HSL helpers used by BOTH the blend 2D legend (renders each
// category hue at a ramp of lightness) and the blend CPU-fallback color buffer.
// The GLSL blend snippet in `gpu/ColormapScatterLayer.ts` mirrors this ALGORITHM
// (only the lightness channel is scaled; hue/saturation ride through), so the GPU
// lightness modulation and the DOM legend swatch come from the same math. The JS
// hue is in degrees [0,360); the GLSL uses the normalized [0,1) equivalent — each
// is internally inverse, and lightness (the only modulated channel) is identical.

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Byte RGB `[0..255]³` → HSL (`h` in `[0,360)`, `s`/`l` in `[0,1]`). */
export function rgbToHsl(rgb: readonly [number, number, number]): [number, number, number] {
  const rn = rgb[0] / 255
  const gn = rgb[1] / 255
  const bn = rgb[2] / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h * 60, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

/** HSL (`h` in degrees, `s`/`l` in `[0,1]`) → byte RGB `[0..255]³`. Inverse of `rgbToHsl`. */
export function hslToRgb(hsl: readonly [number, number, number]): [number, number, number] {
  const h = (((hsl[0] % 360) + 360) % 360) / 360
  const s = clamp01(hsl[1])
  const l = clamp01(hsl[2])
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

/**
 * Scale a color's HSL LIGHTNESS by `factor` (clamped to `[0,1]`), preserving hue +
 * saturation. `factor < 1` darkens toward black, `1` is unchanged. This is the CPU
 * mirror of the shader's blend lightness modulation (base hue held, L ramped by the
 * normalized value).
 */
export function scaleLightness(
  rgb: readonly [number, number, number],
  factor: number,
): [number, number, number] {
  const [h, s, l] = rgbToHsl(rgb)
  return hslToRgb([h, s, clamp01(l * factor)])
}

/** Parse a d3 `rgb(r, g, b)` / `#rrggbb` string into an [r,g,b] byte triple. */
function parseRgb(css: string): [number, number, number] {
  if (css[0] === '#') {
    const hex = css.length === 4
      ? css.slice(1).split('').map(c => c + c).join('')
      : css.slice(1)
    const int = parseInt(hex, 16)
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
  }
  const m = css.match(/\d+(?:\.\d+)?/g)
  if (!m || m.length < 3) return [0, 0, 0]
  return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])]
}

export interface ContinuousColorResult {
  readonly colors: Uint8Array // length N*4
  readonly domain: readonly [number, number] // [min, max] AFTER scale
}

/**
 * Precompute RGBA colors for a continuous column. Non-finite / (optionally)
 * zero-default points map to the low end of the map at full alpha — set
 * `zeroTransparent` to render the sparse-default (0) points as transparent
 * (color-by-value: unexpressed points fade out).
 */
export function continuousColors(
  values: Float32Array,
  opts: {
    colormap?: ContinuousColormap
    scale?: DomainScale
    domain?: readonly [number, number]
    alpha?: number
    zeroTransparent?: boolean
  } = {},
): ContinuousColorResult {
  const interp = INTERPOLATORS[opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP]
  const scale = opts.scale ?? 'linear'
  const alpha = opts.alpha ?? 255
  const n = values.length
  const scaled = new Float32Array(n)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    const s = applyScale(values[i], scale)
    scaled[i] = s
    if (Number.isFinite(s)) {
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
  }
  let [dmin, dmax] = opts.domain ?? [lo, hi]
  if (!Number.isFinite(dmin) || !Number.isFinite(dmax)) {
    dmin = 0
    dmax = 1
  }
  if (dmax === dmin) dmax = dmin + 1e-6 // avoid /0 (legacy echarts min===max fix)
  const span = dmax - dmin

  // Precompute a 256-entry LUT so we call the d3 interpolator 256× not N×.
  const lut = new Uint8Array(256 * 3)
  for (let k = 0; k < 256; k++) {
    const [r, g, b] = parseRgb(interp(k / 255))
    lut[k * 3] = r
    lut[k * 3 + 1] = g
    lut[k * 3 + 2] = b
  }

  const colors = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (opts.zeroTransparent && values[i] === 0) {
      // leave RGBA at 0 (transparent) — unexpressed point
      continue
    }
    const t = Math.max(0, Math.min(1, (scaled[i] - dmin) / span))
    const k = (t * 255) | 0
    colors[o] = lut[k * 3]
    colors[o + 1] = lut[k * 3 + 1]
    colors[o + 2] = lut[k * 3 + 2]
    colors[o + 3] = alpha
  }
  return { colors, domain: [dmin, dmax] }
}

/**
 * Precompute RGBA colors for a categorical column from its codes. `hidden` is an
 * optional set of category indices to render transparent (legend toggle / filter).
 */
export function categoricalColors(
  codes: Uint16Array,
  opts: {
    alpha?: number
    hidden?: ReadonlySet<number>
    /** The category NAMES (enables the by-name/custom/auto-extend EFFECTIVE palette). Absent ⇒
     *  the built-in palette cycle, byte-identical to before. */
    categories?: readonly string[]
  } & CategoricalOverrides = {},
): Uint8Array {
  const alpha = opts.alpha ?? 255
  const hidden = opts.hidden
  // Resolve the EFFECTIVE palette only when category names are supplied; otherwise keep the
  // exact built-in cycle (no-override / no-categories path stays byte-identical).
  const palette = opts.categories ? resolveEffectivePalette(opts.categories, opts) : null
  const n = codes.length
  const colors = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const code = codes[i]
    if (hidden && hidden.has(code)) continue // transparent
    const [r, g, b] = palette
      ? palette[code] ?? defaultCatColor(code)
      : defaultCatColor(code)
    colors[o] = r
    colors[o + 1] = g
    colors[o + 2] = b
    colors[o + 3] = alpha
  }
  return colors
}

/** The color assigned to a category index (for legend swatches). Okabe-Ito default (ITEM-11). */
export function categoryColor(code: number): readonly [number, number, number] {
  return defaultCatColor(code)
}

/** RGB byte triple → a `#rrggbb` CSS string (for DOM legend swatches). */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('')
}

// ── legend / colorbar descriptors (small DOM overlays; ITEM-3) ────────────────

export interface ColorbarDescriptor {
  readonly kind: 'continuous'
  readonly colormap: ContinuousColormap
  readonly domain: readonly [number, number]
  /** CSS gradient stops for the colorbar strip. */
  readonly stops: readonly string[]
  /** ITEM-17: the quantity + unit this colorbar encodes (e.g. "mean expression (z-score)"), shown as the
   *  colorbar caption so a continuous scale is never unlabeled. Absent ⇒ no caption (unchanged). */
  readonly label?: string
}

/** ITEM-17: compose a colorbar caption from a quantity + optional unit — "quantity (unit)". */
export function colorbarLabel(quantity: string, unit?: string): string {
  return unit ? `${quantity} (${unit})` : quantity
}

export interface LegendDescriptor {
  readonly kind: 'categorical'
  readonly entries: readonly { code: number; label: string; hex: string }[]
}

export function colorbarDescriptor(
  colormap: ContinuousColormap,
  domain: readonly [number, number],
  steps = 16,
  label?: string,
): ColorbarDescriptor {
  const interp = INTERPOLATORS[colormap]
  const stops: string[] = []
  for (let i = 0; i < steps; i++) stops.push(interp(i / (steps - 1)))
  return { kind: 'continuous', colormap, domain, stops, ...(label ? { label } : {}) }
}

export function legendDescriptor(
  categories: readonly string[],
  overrides?: CategoricalOverrides,
): LegendDescriptor {
  // No overrides + ≤20 groups ⇒ palette[code] === categoryColor(code) and label === raw
  // (byte-identical to the pre-override legend); overrides drive both the swatch + the label.
  const palette = resolveEffectivePalette(categories, overrides)
  return {
    kind: 'categorical',
    entries: categories.map((raw, code) => ({
      code,
      label: displayCategory(raw, overrides?.categoryLabels),
      hex: rgbToHex(palette[code]),
    })),
  }
}
