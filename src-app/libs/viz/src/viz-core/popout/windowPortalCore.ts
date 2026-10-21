// windowPortalCore.ts — the PURE, node-testable bits of the portal-move pop-out (the geometry +
// features-string math). The DOM-touching engine (window.open, createPortal, style cloning,
// stable-node relocation) lives in the sibling `windowPortal.tsx`; it's exercised by the web e2e.

export interface PopupGeometry {
  readonly width: number
  readonly height: number
  readonly left?: number
  readonly top?: number
}

/** Build the `window.open` features string (a real popup, not a tab). Dimensions are floored to ≥1. */
export function buildPopupFeatures(g: PopupGeometry): string {
  const parts = [
    'popup=yes',
    `width=${Math.max(1, Math.round(g.width))}`,
    `height=${Math.max(1, Math.round(g.height))}`,
  ]
  if (g.left != null && Number.isFinite(g.left)) parts.push(`left=${Math.max(0, Math.round(g.left))}`)
  if (g.top != null && Number.isFinite(g.top)) parts.push(`top=${Math.max(0, Math.round(g.top))}`)
  return parts.join(',')
}

/** Center a `w×h` popup on a `sw×sh` screen (clamped so it never goes off the top-left). */
export function centeredGeometry(w: number, h: number, sw: number, sh: number): PopupGeometry {
  return {
    width: w,
    height: h,
    left: Math.max(0, Math.round((sw - w) / 2)),
    top: Math.max(0, Math.round((sh - h) / 2)),
  }
}

/** The `window.open` target NAME for a cell's popout (stable per id → reusing it focuses the same window). */
export function popoutWindowName(id: string): string {
  return `viz-portal-${id}`
}
