// pubreadyColor.ts — publication color-integrity helpers (ITEM-10 / ITEM-11 / ITEM-12). Kept separate from
// the big `color.ts` so these pure, well-tested policies can land without perturbing the existing palette
// machinery; the default-palette swap + picker wiring consume them at integration. Pure + node-safe.

import { INTERPOLATORS, OKABE_ITO_RGB, type ContinuousColormap } from './color'

// ── ITEM-11: Okabe-Ito — the CVD-safe qualitative standard (Wong, Nature Methods 2010). 8 colors.
// Single-sourced in color.ts (the default categorical palette); re-exported here for the policy helpers. ──
export const OKABE_ITO = OKABE_ITO_RGB
/** Beyond 8 categories, color alone can't stay CVD-distinct — the UI should nudge to FACET instead. */
export const OKABE_ITO_MAX = OKABE_ITO.length
export function exceedsCategoricalCap(nCategories: number): boolean {
  return nCategories > OKABE_ITO_MAX
}

// ── ITEM-10: monotonic-luminance gate (ban jet/rainbow such as `turbo`) ──
function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (m) { const [r, g, b] = m[1].split(',').map(v => parseFloat(v)); return [r || 0, g || 0, b || 0] }
  if (css[0] === '#') {
    const h = css.slice(1)
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return [0, 0, 0]
}
const luminance = (rgb: [number, number, number]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

/** Sample a colormap's luminance across [0,1]. */
export function sampleLuminance(cmap: ContinuousColormap, steps = 16): number[] {
  const f = INTERPOLATORS[cmap]
  const out: number[] = []
  for (let i = 0; i < steps; i++) out.push(luminance(parseRgb(f(i / (steps - 1)))))
  return out
}

/** True if a colormap's luminance is (approximately) MONOTONIC — the property a SEQUENTIAL map needs to be
 *  grayscale-safe + perceptually honest. `turbo`/jet fail (luminance rises then falls). Diverging maps are
 *  legitimately non-monotonic, so the caller applies this only to maps used as sequential. */
export function isMonotonicLuminance(cmap: ContinuousColormap, steps = 16, tol = 6): boolean {
  const l = sampleLuminance(cmap, steps)
  let up = true, down = true
  for (let i = 1; i < l.length; i++) {
    if (l[i] < l[i - 1] - tol) up = false
    if (l[i] > l[i - 1] + tol) down = false
  }
  return up || down
}

/** Colormaps to DROP from the sequential picker (non-monotonic rainbow maps) — ITEM-10. */
export const BANNED_SEQUENTIAL: readonly ContinuousColormap[] = ['turbo']

// ── ITEM-12: symmetric diverging domain (center a signed scale at 0) ──
/** For signed data (z-score, log2FC) a diverging map must be centered at 0 with vmin = −vmax, else the
 *  color midpoint lies off zero and misreads the sign. Returns the symmetrized [−m, m]. */
export function symmetricDivergingDomain(domain: readonly [number, number]): [number, number] {
  const m = Math.max(Math.abs(domain[0]), Math.abs(domain[1]))
  return [-m, m]
}
