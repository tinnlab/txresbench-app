// annotationGestures.ts — the PURE, host-agnostic core of the vector-annotation EDIT
// interaction (ITEM-3). The editable-geometry analog of `selection/areaGestures.ts`:
// topmost hit-test, whole-feature translate, per-vertex reshape (insert / move / delete),
// snap-to-nearby-vertex (reusing the KD-tree point index), and a draft `finishPolygon`
// that discards a degenerate (<3-vertex) ring. Everything here is world-space + framework
// free — NO deck.gl / react / store / backend import (only the dependency-free
// `spatial/pointIndex` + the shared `annotateModel` types) — so it is directly
// node-testable exactly like `SelectionController.ts` / `regionSelect.ts`.
//
// INVARIANTS: geometry is operated on in the ONE canonical space — full-resolution image
// pixels (INV-4, anchored by `annotateModel.ts`); every op is a pure value→value transform
// (a committed edit is indistinguishable from any other edit — INV-6). The single per-HOST
// difference is an `unproject(clientX,clientY)→[x,y]` adapter that lives in the React hook,
// never here.

import type {
  Annotation,
  AnnotationGeometry,
  PolygonGeometry,
} from './annotateModel'
import type { PointIndex } from '../spatial/pointIndex'

/** A 2D vertex in FULL-RESOLUTION image pixels (the canonical annotation space, INV-4). */
export type Vec2 = [number, number]

// ── ring helpers ────────────────────────────────────────────────────────────────────────

/** A ring's flat `[x0,y0,x1,y1,…]` coordinates as `[x,y]` pairs (holes + exterior alike). */
export function ringToPairs(ring: Float64Array): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i], ring[i + 1]])
  return out
}

/** Deep copy a polygon's rings so a per-vertex op never mutates the source geometry. */
function cloneRings(geom: PolygonGeometry): Float64Array[] {
  return geom.rings.map(r => Float64Array.from(r))
}

/** Ray-casting point-in-ring on a FLAT `[x0,y0,…]` ring (no per-vertex allocation). */
function pointInFlatRing(ring: Float64Array, x: number, y: number): boolean {
  let inside = false
  const n = ring.length >>> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]
    const yi = ring[2 * i + 1]
    const xj = ring[2 * j]
    const yj = ring[2 * j + 1]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Squared distance from `(px,py)` to the segment `a→b` (matches simplify-js's seg dist). */
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

// ── hit testing (topmost feature) ─────────────────────────────────────────────────────────

/** Is `(x,y)` inside a polygon (inside the exterior ring AND outside every hole)? */
export function pointInPolygonGeometry(geom: PolygonGeometry, x: number, y: number): boolean {
  if (geom.rings.length === 0) return false
  if (!pointInFlatRing(geom.rings[0], x, y)) return false
  for (let r = 1; r < geom.rings.length; r++) {
    if (pointInFlatRing(geom.rings[r], x, y)) return false // inside a hole
  }
  return true
}

/** Nearest squared distance from `(x,y)` to any segment of a flat open path. */
function pathDistanceSq(xy: Float64Array, x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const d = segmentDistanceSq(x, y, xy[i], xy[i + 1], xy[i + 2], xy[i + 3])
    if (d < best) best = d
  }
  // a single-vertex path degenerates to point distance
  if (best === Infinity && xy.length >= 2) {
    const ex = x - xy[0]
    const ey = y - xy[1]
    best = ex * ex + ey * ey
  }
  return best
}

/**
 * Does an annotation's geometry contain / lie within `pickRadius` of world point `p`?
 * Polygons use the ring test (pickRadius ignored); points + paths use a proximity test so a
 * thin feature is still grabbable.
 */
export function annotationContainsPoint(a: Annotation, p: Vec2, pickRadius = 0): boolean {
  const g: AnnotationGeometry = a.geometry
  if (g.kind === 'polygon') return pointInPolygonGeometry(g, p[0], p[1])
  const r2 = pickRadius * pickRadius
  if (g.kind === 'point') {
    const ex = p[0] - g.xy[0]
    const ey = p[1] - g.xy[1]
    return ex * ex + ey * ey <= r2
  }
  return pathDistanceSq(g.xy, p[0], p[1]) <= r2
}

/**
 * The TOPMOST annotation (last in list = on top / drawn last) that contains `p`, or -1 when
 * none does — the select/reshape grab, honoring z-order. Mirrors
 * `areaGestures.hitTestTopmostArea`.
 */
export function hitTestTopmostAnnotation(
  annotations: readonly Annotation[],
  p: Vec2,
  pickRadius = 0,
): number {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (annotationContainsPoint(annotations[i], p, pickRadius)) return i
  }
  return -1
}

// ── whole-feature translate (mirrors `areaGestures.translateArea`) ─────────────────────────

/** Translate an ENTIRE annotation (every ring / point / path vertex) by a world delta. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const g = a.geometry
  let moved: AnnotationGeometry
  if (g.kind === 'point') {
    moved = { kind: 'point', xy: [g.xy[0] + dx, g.xy[1] + dy] }
  } else if (g.kind === 'path') {
    const out = Float64Array.from(g.xy)
    for (let i = 0; i + 1 < out.length; i += 2) {
      out[i] += dx
      out[i + 1] += dy
    }
    moved = { kind: 'path', xy: out }
  } else {
    const rings = g.rings.map(ring => {
      const out = Float64Array.from(ring)
      for (let i = 0; i + 1 < out.length; i += 2) {
        out[i] += dx
        out[i + 1] += dy
      }
      return out
    })
    moved = { kind: 'polygon', rings }
  }
  return { ...a, geometry: moved }
}

// ── per-vertex reshape on a polygon ring ───────────────────────────────────────────────────

/** Move ring `ringIndex`'s vertex `vertexIndex` to `(x,y)`. Out-of-range ⇒ unchanged geom. */
export function moveVertex(
  geom: PolygonGeometry,
  ringIndex: number,
  vertexIndex: number,
  x: number,
  y: number,
): PolygonGeometry {
  const src = geom.rings[ringIndex]
  if (!src) return geom
  const o = vertexIndex * 2
  if (o < 0 || o + 1 >= src.length) return geom
  const rings = cloneRings(geom)
  rings[ringIndex][o] = x
  rings[ringIndex][o + 1] = y
  return { kind: 'polygon', rings }
}

/**
 * Insert a NEW vertex `(x,y)` splitting the edge that starts at `edgeIndex` (i.e. between
 * vertex `edgeIndex` and `edgeIndex+1`); the new vertex lands at index `edgeIndex+1`.
 * Out-of-range ⇒ unchanged geom.
 */
export function insertVertex(
  geom: PolygonGeometry,
  ringIndex: number,
  edgeIndex: number,
  x: number,
  y: number,
): PolygonGeometry {
  const src = geom.rings[ringIndex]
  if (!src) return geom
  const n = src.length >>> 1
  if (edgeIndex < 0 || edgeIndex >= n) return geom
  const at = (edgeIndex + 1) * 2
  const grown = new Float64Array(src.length + 2)
  grown.set(src.subarray(0, at), 0)
  grown[at] = x
  grown[at + 1] = y
  grown.set(src.subarray(at), at + 2)
  const rings = geom.rings.map((r, i) => (i === ringIndex ? grown : Float64Array.from(r)))
  return { kind: 'polygon', rings }
}

/**
 * Delete ring `ringIndex`'s vertex `vertexIndex`. A ring is kept at ≥3 vertices (a smaller
 * ring is not a valid polygon), so a delete that would drop below 3 is a no-op. Out-of-range
 * ⇒ unchanged geom.
 */
export function deleteVertex(
  geom: PolygonGeometry,
  ringIndex: number,
  vertexIndex: number,
): PolygonGeometry {
  const src = geom.rings[ringIndex]
  if (!src) return geom
  const n = src.length >>> 1
  if (n <= 3) return geom
  if (vertexIndex < 0 || vertexIndex >= n) return geom
  const o = vertexIndex * 2
  const shrunk = new Float64Array(src.length - 2)
  shrunk.set(src.subarray(0, o), 0)
  shrunk.set(src.subarray(o + 2), o)
  const rings = geom.rings.map((r, i) => (i === ringIndex ? shrunk : Float64Array.from(r)))
  return { kind: 'polygon', rings }
}

// ── snap-to-nearby-vertex (reuses the KD-tree point index) ─────────────────────────────────

/**
 * Snap `p` to the nearest existing vertex within `threshold` world units, else return `p`
 * unchanged. `vertices` is the interleaved `[x0,y0,…]` buffer the KD-tree `index` was built
 * over (e.g. every editable feature's vertices) — the O(log N) `nearest` query reuses the
 * exact `spatial/pointIndex` seam the lasso prefilter uses.
 */
export function snapToVertex(
  p: Vec2,
  vertices: Float32Array,
  index: PointIndex,
  threshold: number,
): Vec2 {
  const id = index.nearest(p[0], p[1])
  if (id < 0) return [p[0], p[1]]
  const vx = vertices[2 * id]
  const vy = vertices[2 * id + 1]
  const dx = vx - p[0]
  const dy = vy - p[1]
  if (dx * dx + dy * dy <= threshold * threshold) return [vx, vy]
  return [p[0], p[1]]
}

// ── draft finish (mirrors `useAreaSelection.finishPolygon` discard rule) ───────────────────

/**
 * Commit an in-progress polygon draft into a `PolygonGeometry`, or `null` when the draft is
 * degenerate (<3 vertices — a line/point is not a polygon; identical to
 * `useAreaSelection.finishPolygon` dropping a <3-vertex ring). The ring is stored as a flat
 * exterior `[x0,y0,…]` Float64Array in full-res px (INV-4).
 */
export function finishPolygon(draft: readonly Vec2[]): PolygonGeometry | null {
  if (draft.length < 3) return null
  const flat = new Float64Array(draft.length * 2)
  for (let i = 0; i < draft.length; i++) {
    flat[2 * i] = draft[i][0]
    flat[2 * i + 1] = draft[i][1]
  }
  return { kind: 'polygon', rings: [flat] }
}

// ── in-progress polygon: rubber band + close affordance (ITEM-14/15, INV-15) ───────────────
//
// A multi-step gesture must render its PENDING result continuously, not only its committed
// vertices — the shipped defect was that a polygon draft redrew ONLY when a vertex was added,
// so between clicks the user saw nothing tracking the cursor while the marquee/lasso SELECT
// path (`selection/areaGestures.ts`) did exactly that. These two helpers are the shared,
// pure source both the editor (`useAnnotateEditor`) and the overlay builder
// (`buildAnnotationLayers`) consume, so the on-screen rubber band and the hit-test that
// closes the ring can never disagree.

/** Minimum vertices before a draft may be closed into a polygon (mirrors `finishPolygon`). */
export const MIN_POLYGON_VERTICES = 3

/**
 * The path to STROKE for an in-progress polygon: the dropped vertices, plus a trailing segment
 * to the live `cursor` (the rubber band). Returns the dropped vertices unchanged when there is
 * no cursor (pointer outside the pane / not yet moved), so a draft is never rendered with a
 * phantom segment. Pure: allocates a new array only when a cursor is appended.
 */
export function rubberBandPath(draft: readonly Vec2[], cursor: Vec2 | null | undefined): readonly Vec2[] {
  if (!cursor || draft.length === 0) return draft
  return [...draft, [cursor[0], cursor[1]]]
}

/**
 * Whether a press at `p` should CLOSE the draft ring rather than drop another vertex — true
 * only once the draft already holds enough vertices to form a polygon AND the press lands
 * within `radius` (world px) of the FIRST vertex. This is the hit-test behind the "click the
 * first point to close" affordance; the same predicate drives the highlighted first-vertex
 * ring, so what the user sees and what the press does are one decision.
 */
export function isPolygonCloseHit(
  draft: readonly Vec2[],
  p: Vec2,
  radius: number,
): boolean {
  if (draft.length < MIN_POLYGON_VERTICES) return false
  const first = draft[0]
  return Math.hypot(p[0] - first[0], p[1] - first[1]) <= radius
}

/** Whether the draft has enough vertices that closing it is offered at all (drives the ring). */
export function isPolygonClosable(draft: readonly Vec2[]): boolean {
  return draft.length >= MIN_POLYGON_VERTICES
}
