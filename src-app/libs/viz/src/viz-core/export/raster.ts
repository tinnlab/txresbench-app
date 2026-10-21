// raster.ts — PNG raster export from a canvas (DEC-31 "Raster" family). Framework-
// agnostic (viz-core): plain DOM only, no @ziee/*. Produces a `data:` URL from a
// WebGL/2D canvas; a scale factor composites into an offscreen canvas for high-DPI /
// print output; `transparentBackground` keeps alpha, otherwise the frame is flattened
// onto white. Works headless: when there is no `document` to composite against (node
// tests), it falls back to a direct `canvas.toDataURL`.

export interface RasterOptions {
  /** Output pixel scale relative to the source canvas (>1 = high-DPI / print). */
  scale?: number
  /** Keep the canvas alpha channel instead of flattening onto white. */
  transparentBackground?: boolean
}

/**
 * Export a canvas as a PNG `data:` URL. At `scale === 1` with a transparent
 * background this is a direct capture; otherwise the frame is drawn into an
 * offscreen 2D canvas (scaled, optionally white-filled) and re-encoded.
 */
export function exportCanvasPNG(canvas: HTMLCanvasElement, opts: RasterOptions = {}): string {
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1
  const transparent = opts.transparentBackground ?? false
  const needsComposite = scale !== 1 || !transparent

  if (
    needsComposite &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  ) {
    const w = Math.max(1, Math.round(canvas.width * scale))
    const h = Math.max(1, Math.round(canvas.height * scale))
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')
    if (ctx) {
      if (!transparent) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
      }
      ctx.drawImage(canvas as CanvasImageSource, 0, 0, w, h)
      return off.toDataURL('image/png')
    }
  }

  // Fallback: direct capture (transparent + unscaled, or no DOM to composite).
  return canvas.toDataURL('image/png')
}

/**
 * A fitted draw rectangle: where to place a `srcW×srcH` source inside a
 * `boxW×boxH` output box so it is CONTAINED (letterboxed) and CENTERED with its
 * aspect ratio preserved — never stretched. `width`/`height` are the drawn size,
 * `x`/`y` the top-left offset (the letterbox margins are `x` left/right, `y`
 * top/bottom). Pure math — no DOM — so the fit/aspect logic is directly testable.
 */
export interface FitRect {
  width: number
  height: number
  x: number
  y: number
}

/**
 * Contain-fit a `srcW×srcH` source inside a `boxW×boxH` box preserving aspect
 * ratio: scale by the SMALLER of the two axis ratios so the whole source fits,
 * then center it (letterbox). When the box aspect differs from the source, the
 * source occupies one axis fully and is centered on the other — it is never
 * distorted. Degenerate (non-positive) inputs yield a zero rect.
 */
export function fitContain(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): FitRect {
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) {
    return { width: 0, height: 0, x: 0, y: 0 }
  }
  const s = Math.min(boxW / srcW, boxH / srcH)
  const width = srcW * s
  const height = srcH * s
  return { width, height, x: (boxW - width) / 2, y: (boxH - height) / 2 }
}

export interface ResizeToBoxOptions {
  /** Keep alpha instead of filling the letterbox / frame with white. */
  transparentBackground?: boolean
}

/**
 * Draw `source` into a NEW `boxW×boxH` canvas, CONTAIN-fitted + centered so the
 * source aspect ratio is preserved (letterboxed, never stretched). The output
 * canvas is EXACTLY `round(boxW)×round(boxH)`; the letterbox margins (and any
 * source alpha) are flattened onto white unless `transparentBackground`. Needs a
 * DOM `document`; returns a 1×1 canvas only if there's no 2D context.
 */
export function resizeCanvasToBox(
  source: HTMLCanvasElement,
  boxW: number,
  boxH: number,
  opts: ResizeToBoxOptions = {},
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(boxW))
  const h = Math.max(1, Math.round(boxH))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (ctx) {
    if (!(opts.transparentBackground ?? false)) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
    }
    const fit = fitContain(source.width, source.height, w, h)
    if (fit.width > 0 && fit.height > 0) {
      ctx.drawImage(source as CanvasImageSource, fit.x, fit.y, fit.width, fit.height)
    }
  }
  return out
}

/** Trigger a browser download of a `data:`/blob URL under `filename`. */
export function downloadDataUrl(url: string, filename: string): void {
  if (typeof document === 'undefined') return
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
