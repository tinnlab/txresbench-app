// quantize.ts — optional 16-bit POSITION packing (PERFORMANCE_PLAN.md Phase 2, B2). Storing an
// interleaved xy cloud as Float32 costs 8 B/point; mapping each axis linearly onto the 16-bit
// grid `[0,65535]` (per-axis origin + scale) costs 4 B/point — HALF the resident xy memory AND
// half the bytes the CPU-raster worker transfers. The precision floor is one axis span / 65535
// (≈ 0.0015%), invisible at the density-raster cell size, so a packed bin is byte-consistent with
// the Float32 bin within that quantization step.
//
// PURE + framework-agnostic (no deck.gl / React / DOM), so it unit-tests in node and round-trips
// against a hand oracle. The `readX`/`readY` accessors decode ONE point's world coord straight
// from the packed buffer WITHOUT a full Float32 unpack allocation — that is the whole point: the
// packed bin path (`binDensityPacked`) reads coords on the fly, never materializing 8 B/point.
//
// Packing is entirely OPT-IN: nothing calls it unless a caller explicitly packs, so the default
// Float32 render/bin path stays byte-identical.

import { boundsForPositions } from './densityBin'

/**
 * The per-axis linear map that ties a `Uint16` code back to world space:
 *   `world = origin + code * scale`   (code ∈ [0, 65535])
 *   `code  = round((world - origin) / scale)`
 * A degenerate axis (all points equal / a single point) has `scale = 0`, so every code is `0`
 * and decodes exactly back to `origin` (zero round-trip error).
 */
export interface PackMeta {
  /** world value the code `0` maps to (the axis minimum). */
  readonly originX: number
  readonly originY: number
  /** world units per code step = axisSpan / 65535 (0 for a degenerate axis). */
  readonly scaleX: number
  readonly scaleY: number
}

/** A packed cloud: the interleaved `Uint16` codes (length N*2) + the decode map. */
export interface PackedPositions extends PackMeta {
  /** interleaved xy codes, length N*2 (`packed[i*2]`, `packed[i*2+1]`). */
  readonly packed: Uint16Array
}

/** The 16-bit code ceiling — an axis span maps linearly onto `[0, U16_MAX]`. */
export const U16_MAX = 65535

/** Compute the per-axis origin+scale for `bounds` (span / 65535; 0 for a degenerate axis). */
function metaForSpan(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): PackMeta {
  const spanX = maxX - minX
  const spanY = maxY - minY
  return {
    originX: minX,
    originY: minY,
    scaleX: spanX > 0 ? spanX / U16_MAX : 0,
    scaleY: spanY > 0 ? spanY / U16_MAX : 0,
  }
}

/**
 * Pack an interleaved Float32 xy buffer (length N*2) into 16-bit codes + a decode map. Each axis
 * is mapped linearly onto `[0, 65535]` from its own min/max (reusing `boundsForPositions`, which
 * skips non-finite coords). A non-finite coord packs to code `0` (it decodes to the axis origin;
 * such points are anyway dropped by the bounds-clamped binner). Round-trip error per axis is ≤
 * `span / 65535` (see `unpackXY`). Allocates ONE `Uint16Array` (half the input's bytes).
 */
export function packPositions(xy: Float32Array): PackedPositions {
  const b = boundsForPositions(xy)
  const meta = metaForSpan(b.minX, b.minY, b.maxX, b.maxY)
  const n = xy.length >> 1
  const packed = new Uint16Array(n * 2)
  const invX = meta.scaleX > 0 ? 1 / meta.scaleX : 0
  const invY = meta.scaleY > 0 ? 1 / meta.scaleY : 0
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2]
    const y = xy[i * 2 + 1]
    packed[i * 2] = encode(x, meta.originX, invX)
    packed[i * 2 + 1] = encode(y, meta.originY, invY)
  }
  return { packed, ...meta }
}

/** Encode one world coord to a clamped `[0,65535]` code (non-finite → 0). */
function encode(v: number, origin: number, inv: number): number {
  if (!Number.isFinite(v) || inv === 0) return 0
  let code = Math.round((v - origin) * inv)
  if (code < 0) code = 0
  else if (code > U16_MAX) code = U16_MAX
  return code
}

/** Decode point `i`'s world X straight from the packed buffer — NO full-array allocation. */
export function readX(packed: Uint16Array, i: number, meta: PackMeta): number {
  return meta.originX + packed[i * 2] * meta.scaleX
}

/** Decode point `i`'s world Y straight from the packed buffer — NO full-array allocation. */
export function readY(packed: Uint16Array, i: number, meta: PackMeta): number {
  return meta.originY + packed[i * 2 + 1] * meta.scaleY
}

/**
 * Full decode back to an interleaved Float32 xy buffer (length N*2) — the inverse of
 * `packPositions`. Each decoded coord is within `span / 65535` of the original (one code step),
 * so `unpackXY(packPositions(xy))` reproduces `xy` to that bound. Use the per-point `readX`/
 * `readY` accessors instead when you only need to scan (the bin path) — this materializes 8 B/pt.
 */
export function unpackXY(source: PackedPositions): Float32Array {
  const { packed } = source
  const n = packed.length >> 1
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = readX(packed, i, source)
    out[i * 2 + 1] = readY(packed, i, source)
  }
  return out
}
