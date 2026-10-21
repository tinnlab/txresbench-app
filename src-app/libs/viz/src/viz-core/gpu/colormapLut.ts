// colormapLut.ts — GPU colormap LUT builders (DEC-4 / ITEM-26). Turns a colormap
// into a 256×4 RGBA byte texture the fragment/vertex shader samples, so recolor is a
// texture swap + a uniform change — NO per-point JS color loop on the render path.
//
// These REUSE color.ts's interpolator (its internal 256-entry LUT) so the GPU LUT's BYTES match the
// CPU-precompute path — the GPU render and the DOM colorbar swatch come from the same source of truth.
// NOTE: the continuous texture is sampled with LINEAR filtering (a value BETWEEN two LUT texels blends
// them), whereas the CPU path quantizes NEAREST (`(t*255)|0`); so a GPU scatter and a CPU scatter/DOM
// swatch can differ by up to one inter-texel step at a given value — cosmetic, and the GPU's
// interpolation is arguably the more faithful reading. Categorical uses NEAREST (exact). The bytes are
// consumed by `device.createTexture({ format:'rgba8unorm', data, width:256, height:1 })`.

import {
  continuousColors,
  DEFAULT_CATEGORICAL_PALETTE,
  type ContinuousColormap,
} from '../data/color'

/** Number of texels in a 1D colormap LUT (matches color.ts's internal LUT resolution). */
export const LUT_SIZE = 256

/**
 * Build a 256×4 RGBA (`Uint8Array`, length 1024) LUT for a continuous colormap.
 * Texel k = colormap(k/255) at full alpha. Reuses `continuousColors` (color.ts's d3
 * interpolator + its 256-step quantization), evaluated over the identity ramp on the
 * [0,1] domain, so `LUT[0]` == colormap(0) and `LUT[255]` == colormap(1).
 */
export function buildColormapLUT(colormap: ContinuousColormap): Uint8Array {
  const ramp = new Float32Array(LUT_SIZE)
  for (let k = 0; k < LUT_SIZE; k++) ramp[k] = k / (LUT_SIZE - 1)
  // domain [0,1] + linear scale ⇒ t == ramp[k] ⇒ colors[k] == color.ts LUT entry k.
  const { colors } = continuousColors(ramp, {
    colormap,
    scale: 'linear',
    domain: [0, 1],
    alpha: 255,
  })
  return colors // Uint8Array, length LUT_SIZE * 4
}

/**
 * Build a 256×4 RGBA (`Uint8Array`, length 1024) palette LUT for categorical coloring.
 * Texel i = `CATEGORICAL_PALETTE[i % palette.length]` at full alpha, so a per-point
 * `code` attribute samples its stable color at `(code + 0.5) / 256` with NEAREST
 * filtering (the palette's wraparound is baked into the texture). Index math in-shader
 * is `code / paletteSize` with `paletteSize == LUT_SIZE`.
 */
export function buildPaletteLUT(
  palette: readonly (readonly [number, number, number])[] = DEFAULT_CATEGORICAL_PALETTE,
): Uint8Array {
  const out = new Uint8Array(LUT_SIZE * 4)
  // Default (no arg) ⇒ the DEFAULT categorical palette (Okabe-Ito-first, ITEM-11), kept in lock-step with
  // `categoryColor`/`resolveEffectivePalette` so GPU == CPU == legend. A caller that has resolved the
  // EFFECTIVE palette (custom / by-name / auto-extended via `resolveEffectivePalette`) passes it so texel
  // `code` samples its override color; texels beyond the effective length wrap.
  const n = palette.length > 0 ? palette.length : DEFAULT_CATEGORICAL_PALETTE.length
  const src = palette.length > 0 ? palette : DEFAULT_CATEGORICAL_PALETTE
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = src[i % n]
    const o = i * 4
    out[o] = r
    out[o + 1] = g
    out[o + 2] = b
    out[o + 3] = 255
  }
  return out
}
