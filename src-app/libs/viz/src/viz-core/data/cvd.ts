// cvd.ts — color-vision-deficiency + grayscale SIMULATION (ITEM-9). ~8% of men have a CVD; a
// publication-grade figure must remain readable to them and in grayscale. This is a design CHECK (a
// non-destructive preview) — you don't SHIP a simulated figure, you fix the one that fails. Uses the
// Machado (2009) severity-1.0 matrices, which operate directly in sRGB space (no linearization needed),
// so a preview is a cheap per-pixel matrix multiply. Grayscale uses BT.709 luminance. Pure + node-safe.

export type CvdKind = 'deuteranopia' | 'protanopia' | 'tritanopia' | 'grayscale'

// Machado et al. 2009 dichromat matrices (severity 1.0), row-major, sRGB.
const M: Record<Exclude<CvdKind, 'grayscale'>, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** Simulate how one RGB color appears under a CVD (or grayscale). Input/output 0..255. */
export function simulateColor(rgb: readonly [number, number, number], kind: CvdKind): [number, number, number] {
  const [r, g, b] = rgb
  if (kind === 'grayscale') {
    const y = clamp255(0.2126 * r + 0.7152 * g + 0.0722 * b)
    return [y, y, y]
  }
  const m = M[kind]
  return [
    clamp255(m[0] * r + m[1] * g + m[2] * b),
    clamp255(m[3] * r + m[4] * g + m[5] * b),
    clamp255(m[6] * r + m[7] * g + m[8] * b),
  ]
}

/** Simulate an entire RGBA image (the export raster preview). Returns a NEW buffer; alpha is preserved. */
export function simulateImage(rgba: Uint8Array | Uint8ClampedArray, kind: CvdKind): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b] = simulateColor([rgba[i], rgba[i + 1], rgba[i + 2]], kind)
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = rgba[i + 3]
  }
  return out
}
