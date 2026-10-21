// freehand.ts — PURE freehand-lasso geometry (ITEM-4). Capture a pointer path → RDP-simplify
// (hand-rolled Ramer–Douglas–Peucker, no `simplify-js` dep) → close into a polygon ring. The
// dependency-free half of the brush/freehand region tool: NO deck.gl / react / backend import
// (only the shared `annotateModel` types), so it node-tests exactly like `regionSelect.ts`.
// Coordinates are full-resolution image pixels (INV-4); the produced ring feeds `selectRegion`
// / `selectInPolygon` unchanged (INV-5/6/7).

import type { PolygonGeometry } from './annotateModel'

/** A 2D vertex in the SAME space as the captured path (full-res px, INV-4). */
export type Vec2 = [number, number]

/** Squared distance from `(px,py)` to the segment `a→b` (simplify-js `getSqSegDist`). */
function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) {
    const ex = px - ax
    const ey = py - ay
    return ex * ex + ey * ey
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  const ex = px - cx
  const ey = py - cy
  return ex * ex + ey * ey
}

/**
 * Ramer–Douglas–Peucker simplification of an open polyline: keep only the vertices whose
 * perpendicular distance to the running chord exceeds `tolerance`. Iterative (explicit stack,
 * no recursion-depth risk on a long capture). Endpoints are always kept; the returned array is
 * a fresh copy (never aliases the input). `tolerance <= 0` or ≤2 points ⇒ a verbatim copy.
 *
 * Idempotent within `tolerance`: `rdpSimplify(rdpSimplify(p, t), t)` equals `rdpSimplify(p, t)`
 * — every surviving vertex is, by construction, still farther than `t` from its neighbours'
 * chord, so a second pass drops nothing.
 */
export function rdpSimplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  const n = points.length
  if (n <= 2 || !(tolerance > 0)) return points.map(p => [p[0], p[1]] as Vec2)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const tol2 = tolerance * tolerance
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const top = stack.pop()
    if (!top) break
    const [first, last] = top
    if (last - first < 2) continue
    const ax = points[first][0]
    const ay = points[first][1]
    const bx = points[last][0]
    const by = points[last][1]
    let maxD2 = -1
    let idx = -1
    for (let i = first + 1; i < last; i++) {
      const d2 = segmentDistanceSq(points[i][0], points[i][1], ax, ay, bx, by)
      if (d2 > maxD2) {
        maxD2 = d2
        idx = i
      }
    }
    if (maxD2 > tol2 && idx > first) {
      keep[idx] = 1
      stack.push([first, idx], [idx, last])
    }
  }
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push([points[i][0], points[i][1]])
  return out
}

/** A polygon ring's flat `[x0,y0,…]` Float64Array as `[x,y]` pairs (for `selectRegion` etc.). */
export function ringToVec2s(ring: Float64Array): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i], ring[i + 1]])
  return out
}

/** Drop a trailing vertex that equals the first (an already-closed capture) before ringing. */
function dropClosingDuplicate(points: readonly Vec2[]): Vec2[] {
  if (points.length >= 2) {
    const a = points[0]
    const b = points[points.length - 1]
    if (a[0] === b[0] && a[1] === b[1]) return points.slice(0, points.length - 1)
  }
  return points.slice()
}

/** Shoelace |area| of an open ring `[[x,y],…]` — 0 ⇒ all vertices collinear (degenerate). */
function ringAbsArea(pts: readonly Vec2[]): number {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return Math.abs(a) / 2
}

/**
 * Turn a captured freehand path into a closed polygon ring: RDP-simplify at `tolerance`, drop a
 * duplicate closing vertex, and store the survivors as a flat exterior ring (full-res px, INV-4).
 * Returns `null` for a degenerate result: fewer than 3 distinct vertices, OR a zero-area /
 * collinear ring (all vertices on one line — a real risk when `tolerance <= 0` short-circuits RDP
 * and passes a straight 3-point capture straight through). Mirrors the `finishPolygon` discard
 * rule. The ring is implicitly closed (first vertex not repeated), matching `PolygonGeometry` /
 * GeoJSON-serializer expectations.
 */
export function freehandToPolygon(path: readonly Vec2[], tolerance: number): PolygonGeometry | null {
  const simplified = dropClosingDuplicate(rdpSimplify(path, tolerance))
  if (simplified.length < 3) return null
  // A ring whose vertices are all collinear encloses no area — not a polygon. Guard here because
  // `tolerance <= 0` bypasses RDP, so a collinear 3+-point path survives the vertex-count check.
  if (ringAbsArea(simplified) <= 1e-9) return null
  const flat = new Float64Array(simplified.length * 2)
  for (let i = 0; i < simplified.length; i++) {
    flat[2 * i] = simplified[i][0]
    flat[2 * i + 1] = simplified[i][1]
  }
  return { kind: 'polygon', rings: [flat] }
}
