// brushRaster.ts — PURE circular-brush → polygon geometry (ITEM-4). Stamp disks along a
// captured path into a scratch label bitmap, trace the filled region's boundary with a
// hand-rolled MARCHING-SQUARES contour walk, then RDP-simplify the staircase into a ring. This
// IS the mask brush-fix path (INV-6): it operates on plain typed arrays, so both the
// brush-region annotation tool and the label-mask correction reuse it. NO deck.gl / react /
// backend import (only `annotateModel` types + the sibling `freehand` RDP) — node-testable like
// `regionSelect.ts`. Raster coordinates are full-res image pixels (INV-4).

import type { PolygonGeometry } from './annotateModel'
import { rdpSimplify, type Vec2 } from './freehand'

/** A scratch single-channel label bitmap (row-major, `data[y*width + x]`). */
export interface ScratchRaster {
  readonly width: number
  readonly height: number
  /** 0 = empty, non-zero = filled (the stamped label id). */
  readonly data: Uint8Array
}

/** Allocate an empty scratch raster of `width × height` (all zero). */
export function createScratchRaster(width: number, height: number): ScratchRaster {
  return { width, height, data: new Uint8Array(width * height) }
}

/** Stamp a filled disk of radius `r` centred at `(cx,cy)` with `value` (clipped to bounds). */
export function stampDisk(raster: ScratchRaster, cx: number, cy: number, r: number, value = 1): void {
  const { width, height, data } = raster
  if (!(r >= 0)) return
  const r2 = r * r
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(height - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      if (dx * dx + dy * dy <= r2) data[y * width + x] = value
    }
  }
}

/**
 * Stamp disks of radius `r` densely ALONG a path (interpolating between consecutive samples so
 * a fast stroke leaves no gaps) into `raster`. A single-vertex path stamps one disk.
 */
export function stampPath(raster: ScratchRaster, path: readonly Vec2[], r: number, value = 1): void {
  if (path.length === 0) return
  stampDisk(raster, path[0][0], path[0][1], r, value)
  const step = Math.max(0.5, r * 0.5) // sub-radius spacing keeps the stroke solid
  for (let s = 1; s < path.length; s++) {
    const [ax, ay] = path[s - 1]
    const [bx, by] = path[s]
    const dist = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(dist / step))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      stampDisk(raster, ax + (bx - ax) * t, ay + (by - ay) * t, r, value)
    }
  }
}

/**
 * Trace the boundary of the filled region in `raster` as an ordered closed ring of pixel-corner
 * nodes, via a hand-rolled marching-squares contour walk (Gibara's moving-square variant). A
 * node `(x,y)` samples the four pixels around it (NW/NE/SW/SE → bits 1/2/4/8); the 16-case
 * direction table follows the filled/empty transition, resolving the two saddle cases (6/9) by
 * the previous step. Returns the FIRST connected boundary loop (the brush stroke is one blob);
 * an empty raster ⇒ `[]`. O(boundary length).
 */
export function marchingSquares(raster: ScratchRaster): Vec2[] {
  const { width, height, data } = raster
  const at = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] !== 0 ? 1 : 0

  // Start node = top-left corner of the first filled pixel (row-major scan).
  let startX = -1
  let startY = -1
  for (let y = 0; y < height && startX < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] !== 0) {
        startX = x
        startY = y
        break
      }
    }
  }
  if (startX < 0) return []

  const squareValue = (x: number, y: number): number => {
    let v = 0
    if (at(x - 1, y - 1)) v |= 1 // NW
    if (at(x, y - 1)) v |= 2 // NE
    if (at(x - 1, y)) v |= 4 // SW
    if (at(x, y)) v |= 8 // SE
    return v
  }

  const ring: Vec2[] = []
  let x = startX
  let y = startY
  let prevDx = 0
  let prevDy = 0
  const maxSteps = (width * height + width + height) * 4 // hard guard against a runaway walk
  let steps = 0
  do {
    const v = squareValue(x, y)
    let dx = 0
    let dy = 0
    switch (v) {
      case 1:
      case 5:
      case 13:
        dx = 0
        dy = -1
        break // up
      case 8:
      case 10:
      case 11:
        dx = 0
        dy = 1
        break // down
      case 4:
      case 12:
      case 14:
        dx = -1
        dy = 0
        break // left
      case 2:
      case 3:
      case 7:
        dx = 1
        dy = 0
        break // right
      case 6: // saddle: keep turning consistently based on the way we came in
        if (prevDy === -1) {
          dx = -1
          dy = 0
        } else {
          dx = 1
          dy = 0
        }
        break
      case 9: // saddle
        if (prevDx === 1) {
          dx = 0
          dy = -1
        } else {
          dx = 0
          dy = 1
        }
        break
      default:
        // 0 (all empty) or 15 (all filled) is not a boundary node — the walk left the
        // contour; bail rather than loop forever.
        return ring
    }
    ring.push([x, y])
    x += dx
    y += dy
    prevDx = dx
    prevDy = dy
    if (++steps > maxSteps) break
  } while (x !== startX || y !== startY)

  return ring
}

/** The clamped, inclusive pixel bbox `[x0,y0,x1,y1]` a brush stroke can possibly fill. */
export interface StrokeBBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/**
 * The tight, canvas-clamped pixel bbox of a brush stroke: the path's coordinate extent grown by
 * `radius` (the exact reach of every stamped disk — see `stampDisk`'s clip), intersected with the
 * `[0,width-1]×[0,height-1]` canvas. Returns `null` for an empty stroke or one that lies entirely
 * off-canvas. This is what bounds the scratch allocation + marching-squares scan so cost tracks
 * the EDIT, not the (gigapixel) image (INV-6 gigapixel-safety).
 */
export function strokeBBox(
  width: number,
  height: number,
  path: readonly Vec2[],
  radius: number,
): StrokeBBox | null {
  if (path.length === 0 || !(radius >= 0)) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of path) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const x0 = Math.max(0, Math.floor(minX - radius))
  const y0 = Math.max(0, Math.floor(minY - radius))
  const x1 = Math.min(width - 1, Math.ceil(maxX + radius))
  const y1 = Math.min(height - 1, Math.ceil(maxY + radius))
  if (x1 < x0 || y1 < y0) return null
  return { x0, y0, x1, y1 }
}

/**
 * The full circular-brush → annotation path: stamp the stroke into a scratch raster sized to the
 * stroke's BBOX (never the full `width × height` — a tiny stroke on a gigapixel canvas allocates
 * O(brush), not O(image), INV-6), marching-squares the boundary, RDP-simplify the staircase at
 * `tolerance`, and return a closed exterior polygon ring in full-res px (INV-4). Returns `null`
 * when the stroke is empty/off-canvas or the simplified boundary is degenerate (<3 vertices).
 *
 * The bbox-local raster is offset back to full-res coords on output, so the result is IDENTICAL
 * to a full-canvas march (out-of-local reads are empty, exactly as out-of-canvas reads were).
 */
export function brushPathToPolygon(
  width: number,
  height: number,
  path: readonly Vec2[],
  radius: number,
  tolerance: number,
): PolygonGeometry | null {
  const bbox = strokeBBox(width, height, path, radius)
  if (!bbox) return null
  const bw = bbox.x1 - bbox.x0 + 1
  const bh = bbox.y1 - bbox.y0 + 1
  const raster = createScratchRaster(bw, bh)
  // Stamp in bbox-local coordinates; every filled pixel is inside the bbox by construction.
  const localPath: Vec2[] = path.map(([x, y]) => [x - bbox.x0, y - bbox.y0])
  stampPath(raster, localPath, radius)
  const boundary = marchingSquares(raster)
  if (boundary.length < 3) return null
  const simplified = rdpSimplify(boundary, tolerance)
  if (simplified.length < 3) return null
  const flat = new Float64Array(simplified.length * 2)
  for (let i = 0; i < simplified.length; i++) {
    flat[2 * i] = simplified[i][0] + bbox.x0 // offset the local ring back to full-res coords
    flat[2 * i + 1] = simplified[i][1] + bbox.y0
  }
  return { kind: 'polygon', rings: [flat] }
}
