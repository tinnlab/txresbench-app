// bitmapTexture.ts — the one safe way to hand raw raster bytes to a deck.gl `BitmapLayer`.
//
// deck.gl v9 uploads a raw `{ data, width, height }` object as a texture whose RGB channels come
// out ZEROED (only alpha survives) — so a correct color raster renders as a solid BLACK quad. An
// `ImageData` is uploaded reliably as an RGBA texture. This is the SAME pitfall already worked
// around in `density/cpuRaster.ts` (`toBitmapImage`) and `charts/HeatmapView.tsx`; this helper is
// the shared version for the raster-image views (image underlay / tiles), and additionally expands
// a 3-channel RGB source to RGBA (the ImageData ctor requires exactly width·height·4 bytes).

/** A raster source: interleaved RGB or RGBA bytes + pixel dimensions. */
export interface RasterBytes {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  /** channel count; inferred from `data.length` when omitted. */
  readonly channels?: 3 | 4
}

/** What a `BitmapLayer.image` prop accepts here: an `ImageData` (browser) or the raw object
 *  (node/SSR, where it is never actually uploaded — the layer isn't rendered off-DOM). */
export type BitmapTexture = ImageData | { data: Uint8Array; width: number; height: number }

/**
 * Convert raw raster bytes into a `BitmapLayer`-safe texture. In the browser this is an `ImageData`
 * (RGB is expanded to RGBA with opaque alpha); in node (no `ImageData`) the raw object passes
 * through unchanged since it is never GPU-uploaded there. Pure — no GL, no I/O — so it is directly
 * unit-testable and safe to memoize.
 */
export function toBitmapTexture(src: RasterBytes): BitmapTexture {
  const { data, width, height } = src
  if (typeof ImageData === 'undefined') return { data, width, height }
  const px = width * height
  // Degrade (don't throw) on a degenerate raster: the ImageData ctor rejects a 0×0 image
  // (IndexSizeError). A malformed/empty underlay should render nothing, not crash the layer memo.
  if (px === 0) return { data, width, height }
  // Take the 4-channel fast path only when the buffer actually holds px·4 bytes; otherwise fall to
  // the (bounds-safe) RGB expansion below, since `subarray(0, px*4)` on a short buffer yields a
  // wrong-length array that the ImageData ctor also rejects.
  const channels = (src.channels ?? (data.length >= px * 4 ? 4 : 3)) === 4 && data.length >= px * 4 ? 4 : 3
  if (channels === 4) {
    // Copy into a fresh, exactly-sized RGBA buffer (the ImageData ctor requires length === px·4
    // and an own, non-shared backing buffer).
    return new ImageData(new Uint8ClampedArray(data.subarray(0, px * 4)), width, height)
  }
  // RGB → RGBA (opaque).
  const rgba = new Uint8ClampedArray(px * 4)
  for (let i = 0; i < px; i++) {
    rgba[i * 4] = data[i * 3]
    rgba[i * 4 + 1] = data[i * 3 + 1]
    rgba[i * 4 + 2] = data[i * 3 + 2]
    rgba[i * 4 + 3] = 255
  }
  return new ImageData(rgba, width, height)
}
