import type { CSSProperties } from 'react'

/**
 * Pure height-reservation helpers for `ReservedImage` (message-scroll-perf
 * ITEM-3, DEC-4) — kept in a `.ts` (no JSX) so the unit test can import them
 * without a JSX transform.
 */

/** Default reserved height for a dimensionless image (matches estimator, DEC-4). */
export const RESERVED_IMAGE_MIN_HEIGHT = 240

export function toPositiveNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && v > 0) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

export interface ReservedImageBox {
  hasDims: boolean
  style: CSSProperties
}

/**
 * The wrapper style that reserves row height for an image. Intrinsic dims → an
 * exact `aspect-ratio` box (stable before AND after load); no dims → a
 * `min-height` reservation RELEASED once loaded so the final layout equals the
 * natural height (DEC-4).
 */
export function reservedImageBox(
  width: unknown,
  height: unknown,
  loaded: boolean,
): ReservedImageBox {
  const w = toPositiveNumber(width)
  const h = toPositiveNumber(height)
  if (w !== undefined && h !== undefined) {
    return { hasDims: true, style: { aspectRatio: `${w} / ${h}` } }
  }
  return {
    hasDims: false,
    style: loaded ? {} : { minHeight: RESERVED_IMAGE_MIN_HEIGHT },
  }
}
