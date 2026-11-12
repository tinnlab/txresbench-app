// cropCanvas.ts — crop a single PANE out of a full workspace canvas (ITEM-47).
// Framework-agnostic (viz-core): plain DOM only, no @txresbench/*. A caller supplies a
// pane's CSS rect (relative to the on-screen canvas); we blit the matching
// sub-rectangle of the canvas's BACKING STORE into a fresh canvas so per-pane PNG
// export is a REAL crop, not the whole grid.
//
// The source canvas can be displayed at a different size than its backing store
// (a WebGL/deck.gl canvas is typically sized `width = clientWidth * devicePixelRatio`).
// A CSS rect must therefore be scaled into device pixels by `source.width /
// source.clientWidth` before it indexes the backing store. `deviceRectFor` is the
// pure, unit-tested core of that conversion (with out-of-bounds clamping).

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A source sub-rectangle in the canvas's device (backing-store) pixel space. */
export interface DeviceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Convert a CSS-pixel rect (relative to a canvas displayed at `cssW × cssH`) into a
 * device-pixel source rect on that canvas's backing store (`storeW × storeH`),
 * clamped to the store bounds so `drawImage` never reads out of range.
 *
 * Pure math — no DOM — so the scale/clamp logic is directly testable.
 */
export function deviceRectFor(
  rect: Rect,
  cssW: number,
  cssH: number,
  storeW: number,
  storeH: number,
): DeviceRect {
  const scaleX = cssW > 0 ? storeW / cssW : 1
  const scaleY = cssH > 0 ? storeH / cssH : 1

  let sx = rect.x * scaleX
  let sy = rect.y * scaleY
  let sw = rect.width * scaleX
  let sh = rect.height * scaleY

  // Clamp a negative origin inward (shrinking the width/height by the overhang).
  if (sx < 0) {
    sw += sx
    sx = 0
  }
  if (sy < 0) {
    sh += sy
    sy = 0
  }
  // Clamp the far edge to the backing store; never negative.
  sw = Math.max(0, Math.min(sw, storeW - sx))
  sh = Math.max(0, Math.min(sh, storeH - sy))

  return { sx, sy, sw, sh }
}

/** Resolve the effective device-pixel ratio for output scaling. */
export function effectiveDpr(dpr?: number): number {
  if (dpr && dpr > 0) return dpr
  if (typeof window !== 'undefined' && window.devicePixelRatio > 0) {
    return window.devicePixelRatio
  }
  return 1
}

/**
 * Crop the sub-rectangle `rect` (in CSS pixels, relative to `source`'s displayed
 * size) out of `source` into a NEW canvas sized `rect.width*dpr × rect.height*dpr`.
 *
 * The CSS rect is converted to the source's device pixels via
 * `source.width / source.clientWidth` (backing-store scale), so a crop of a
 * high-DPI WebGL canvas keeps full resolution. `dpr` sets the OUTPUT resolution so
 * the crop isn't downscaled below the display density.
 */
export function cropCanvasToRect(
  source: HTMLCanvasElement,
  rect: Rect,
  dpr?: number,
): HTMLCanvasElement {
  const outDpr = effectiveDpr(dpr)

  // Displayed (CSS) size — fall back to the backing store when unmeasured (headless
  // / detached), which makes the device scale 1:1.
  const cssW = source.clientWidth || source.width
  const cssH = source.clientHeight || source.height
  const { sx, sy, sw, sh } = deviceRectFor(rect, cssW, cssH, source.width, source.height)

  const dw = Math.max(1, Math.round(rect.width * outDpr))
  const dh = Math.max(1, Math.round(rect.height * outDpr))

  const out = document.createElement('canvas')
  out.width = dw
  out.height = dh
  const ctx = out.getContext('2d')
  if (ctx && sw > 0 && sh > 0) {
    ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, dw, dh)
  }
  return out
}

/** Encode a canvas to a PNG `Blob` (rejects when `toBlob` is unavailable / null). */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('canvas.toBlob unavailable'))
      return
    }
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('canvas.toBlob returned null'))
    }, 'image/png')
  })
}
