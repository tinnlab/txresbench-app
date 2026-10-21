// hierarchy.ts — PURE QuPath-grade object-hierarchy algebra (ITEM-8/9/10).
//
// A hierarchy is a single-parent forest over annotation OR label-mask objects: every object
// has exactly one parent id or is a root (parentId === null). This module owns ALL tree logic
// as framework-agnostic pure functions (viz-core purity: NO deck/react/store/backend/GL), so
// it is oracle-testable in node and reused by BOTH the vector-annotation store (Annotate.store,
// where parentId lives on the Immer doc so undo is automatic) and the label-mask correction
// path (maskEdit, where a correction emits an invertible parentage delta).
//
// INV-10 (hierarchy integrity): containment is the SOLE auto-parent rule (QuPath's dual rule —
// full-ROI containment for area objects, CENTROID containment for points/detections); every
// tree op preserves the single-parent-forest invariant (no cycles, no multi-parent); split /
// merge / relabel emit an invertible delta so a correction undoes the tree change atomically.
//
// The module is decoupled from the concrete object type via `ContainmentShape` — a candidate
// parent is described by a point-in-shape test + an area (for the "smallest container" rule) +
// vertices (for full-ROI containment of an area child). `shapeOfAnnotation` derives one from an
// `Annotation`; the mask path builds one from a label object's ROI bbox/centroid.

import type { Annotation, AnnotationCollection, AnnotationId, PolygonGeometry } from './annotateModel'
import { pointInPolygonGeometry } from './annotationGestures'

/** A stable object id (annotation UUID string, or a stringified label id for mask objects). */
export type HierId = string

/**
 * The containment descriptor of one object, decoupled from its concrete type. `contains(x,y)`
 * is the point-in-shape test; `area` orders candidates for the "smallest fully-containing parent"
 * rule; `vertices` are the object's own boundary points (an AREA child is contained iff ALL its
 * vertices lie in a candidate); `centroid` is the point tested for a POINT child (QuPath's dual
 * rule) and the fallback for degenerate area.
 */
export interface ContainmentShape {
  readonly kind: 'area' | 'point'
  readonly bbox: readonly [number, number, number, number] // cheap AABB prefilter
  readonly area: number
  readonly centroid: readonly [number, number]
  readonly contains: (x: number, y: number) => boolean
  /** boundary vertices in full-res px (area objects); a point object has its single coordinate. */
  readonly vertices: ReadonlyArray<readonly [number, number]>
}

/** One node in the hierarchy resolve/algebra input: an id + its current parent + its shape. */
export interface HierObject {
  readonly id: HierId
  readonly parentId: HierId | null
  readonly level?: string | null
  readonly shape: ContainmentShape
}

/** A normalized single-parent forest: parent lookup + derived ordered children + roots. */
export interface HierForest {
  readonly parentOf: ReadonlyMap<HierId, HierId | null>
  readonly childIds: ReadonlyMap<HierId, HierId[]>
  readonly roots: readonly HierId[]
  /** input order of ids (children + `descendantsOf` are emitted in this stable order). */
  readonly order: readonly HierId[]
}

/** An invertible parentage change on one object: old→new parent. */
export interface ParentageChange {
  readonly id: HierId
  readonly oldParent: HierId | null
  readonly newParent: HierId | null
}

/** An invertible hierarchy delta — the tree half of a correction's undo atom (INV-10 / DEC-11). */
export interface HierarchyDelta {
  readonly changes: readonly ParentageChange[]
}

/** The empty (no-op) delta. */
export const EMPTY_HIERARCHY_DELTA: HierarchyDelta = { changes: [] }

/** True iff the delta changes nothing. */
export function isEmptyHierarchyDelta(d: HierarchyDelta): boolean {
  return d.changes.length === 0
}

// ── shape construction ────────────────────────────────────────────────────────

function bboxOfVerts(verts: ReadonlyArray<readonly [number, number]>): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of verts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0]
  return [minX, minY, maxX, maxY]
}

/** Shoelace |area| of a polygon exterior ring (flat [x0,y0,…]); 0 for < 3 vertices. */
function polygonAreaFlat(flat: Float64Array | number[]): number {
  const n = flat.length / 2
  if (n < 3) return 0
  let a = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1]
  }
  return Math.abs(a / 2)
}

function centroidOfVerts(verts: ReadonlyArray<readonly [number, number]>): [number, number] {
  if (verts.length === 0) return [0, 0]
  let sx = 0, sy = 0
  for (const [x, y] of verts) {
    sx += x
    sy += y
  }
  return [sx / verts.length, sy / verts.length]
}

/** Build the containment descriptor for an `Annotation` (polygon → area, point/path → point-ish). */
export function shapeOfAnnotation(a: Annotation): ContainmentShape {
  const g = a.geometry
  if (g.kind === 'polygon') {
    const ext = g.rings[0] ?? new Float64Array(0)
    const verts: [number, number][] = []
    for (let i = 0; i + 1 < ext.length; i += 2) verts.push([ext[i], ext[i + 1]])
    const poly = g as PolygonGeometry
    return {
      kind: 'area',
      bbox: bboxOfVerts(verts),
      area: polygonAreaFlat(ext),
      centroid: centroidOfVerts(verts),
      contains: (x, y) => pointInPolygonGeometry(poly, x, y),
      vertices: verts,
    }
  }
  if (g.kind === 'point') {
    const p: [number, number] = [g.xy[0], g.xy[1]]
    return {
      kind: 'point',
      bbox: [p[0], p[1], p[0], p[1]],
      area: 0,
      centroid: p,
      contains: (x, y) => x === p[0] && y === p[1],
      vertices: [p],
    }
  }
  // path: an open polyline — treated as a point-like (centroid) object with zero area.
  const verts: [number, number][] = []
  for (let i = 0; i + 1 < g.xy.length; i += 2) verts.push([g.xy[i], g.xy[i + 1]])
  const c = centroidOfVerts(verts)
  return {
    kind: 'point',
    bbox: bboxOfVerts(verts),
    area: 0,
    centroid: c,
    contains: () => false,
    vertices: verts,
  }
}

/**
 * Build a containment descriptor for a label-mask object from its ROI bbox + centroid. `isPoint`
 * marks a detection (centroid-parented); an area object is contained iff its bbox corners + centroid
 * lie in a candidate (a cheap full-ROI proxy — the mask path has no vector boundary).
 */
export function shapeOfMaskObject(
  bbox: readonly [number, number, number, number],
  opts?: { isPoint?: boolean; centroid?: readonly [number, number] },
): ContainmentShape {
  const [x0, y0, x1, y1] = bbox
  const centroid = opts?.centroid ?? [(x0 + x1) / 2, (y0 + y1) / 2]
  const verts: [number, number][] = [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1], [centroid[0], centroid[1]],
  ]
  const w = Math.max(0, x1 - x0)
  const h = Math.max(0, y1 - y0)
  return {
    kind: opts?.isPoint ? 'point' : 'area',
    bbox,
    area: opts?.isPoint ? 0 : w * h,
    centroid,
    contains: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
    vertices: opts?.isPoint ? [centroid] : verts,
  }
}

// ── containment resolve (QuPath dual rule) ──────────────────────────────────────

/** True iff `parent` FULLY contains `child` per the QuPath dual rule. */
function fullyContains(parent: ContainmentShape, child: ContainmentShape): boolean {
  // cheap AABB prefilter
  const [px0, py0, px1, py1] = parent.bbox
  const [cx0, cy0, cx1, cy1] = child.bbox
  if (cx0 < px0 || cy0 < py0 || cx1 > px1 || cy1 > py1) return false
  if (child.kind === 'point') {
    // POINT / detection child → parented by CENTROID containment (QuPath dual rule).
    return parent.contains(child.centroid[0], child.centroid[1])
  }
  // AREA child → contained iff EVERY vertex lies in the parent (full-ROI containment).
  for (const [x, y] of child.vertices) {
    if (!parent.contains(x, y)) return false
  }
  return true
}

/**
 * Resolve each object's parent to the SMALLEST OTHER object that fully contains it (QuPath's
 * containment rule; dual by child kind). Unattached → root (null). Deterministic + idempotent:
 * a strictly-decreasing-area (with id tiebreak) eligibility guarantees a single-parent forest
 * with NO cycles, and re-running over the resolved set reproduces the same map.
 */
export function resolveHierarchy(objects: readonly HierObject[]): Map<HierId, HierId | null> {
  const out = new Map<HierId, HierId | null>()
  for (const child of objects) {
    let best: HierObject | null = null
    for (const cand of objects) {
      if (cand.id === child.id) continue
      // Acyclic guard: a parent must be strictly LARGER, or equal-area with a lower id (a total
      // order over candidates). Prevents mutual containment (equal ROIs) from forming a cycle.
      const larger = cand.shape.area > child.shape.area
        || (cand.shape.area === child.shape.area && cand.id < child.id)
      if (!larger) continue
      if (!fullyContains(cand.shape, child.shape)) continue
      if (
        best === null
        || cand.shape.area < best.shape.area
        || (cand.shape.area === best.shape.area && cand.id < best.id)
      ) {
        best = cand
      }
    }
    out.set(child.id, best ? best.id : null)
  }
  return out
}

// ── normalized forest + tree algebra ───────────────────────────────────────────

/** Build a normalized forest from an id→parent map (+ the input id order for stable emit). */
export function buildForest(
  order: readonly HierId[],
  parentOf: ReadonlyMap<HierId, HierId | null>,
): HierForest {
  const parent = new Map<HierId, HierId | null>()
  for (const id of order) parent.set(id, parentOf.get(id) ?? null)
  const childIds = new Map<HierId, HierId[]>()
  const roots: HierId[] = []
  for (const id of order) {
    const p = parent.get(id) ?? null
    if (p != null && parent.has(p)) {
      let arr = childIds.get(p)
      if (!arr) childIds.set(p, (arr = []))
      arr.push(id)
    } else {
      roots.push(id)
    }
  }
  return { parentOf: parent, childIds, roots, order }
}

/** The direct children of `id` in input order (empty if none). */
export function childIdsOf(forest: HierForest, id: HierId): readonly HierId[] {
  return forest.childIds.get(id) ?? []
}

/** All descendants of `id` (pre-order DFS, input-order-stable), excluding `id` itself. */
export function descendantsOf(forest: HierForest, id: HierId): HierId[] {
  const out: HierId[] = []
  const walk = (n: HierId): void => {
    for (const c of childIdsOf(forest, n)) {
      out.push(c)
      walk(c)
    }
  }
  walk(id)
  return out
}

/** True iff `maybeAncestor` is `id` or an ancestor of `id` (walks parent links, cycle-safe). */
export function isAncestorOrSelf(
  parentOf: ReadonlyMap<HierId, HierId | null>,
  id: HierId,
  maybeAncestor: HierId,
): boolean {
  let cur: HierId | null = id
  const seen = new Set<HierId>()
  while (cur != null) {
    if (cur === maybeAncestor) return true
    if (seen.has(cur)) break // defensive: never loop on a malformed map
    seen.add(cur)
    cur = parentOf.get(cur) ?? null
  }
  return false
}

/**
 * Reparent `id` under `newParent` (null = make root), returning the delta. Rejects a reparent
 * that would create a cycle (newParent is `id` or a descendant of `id`) — returns EMPTY then.
 */
export function reparent(
  objects: readonly HierObject[],
  id: HierId,
  newParent: HierId | null,
): HierarchyDelta {
  const parentOf = new Map(objects.map(o => [o.id, o.parentId]))
  if (!parentOf.has(id)) return EMPTY_HIERARCHY_DELTA
  const old = parentOf.get(id) ?? null
  if (old === newParent) return EMPTY_HIERARCHY_DELTA
  if (newParent != null) {
    if (!parentOf.has(newParent)) return EMPTY_HIERARCHY_DELTA
    // cycle guard: newParent must not be id or a descendant of id.
    if (isAncestorOrSelf(parentOf, newParent, id)) return EMPTY_HIERARCHY_DELTA
  }
  return { changes: [{ id, oldParent: old, newParent }] }
}

// ── containment-preserving corrections (mask + vector) ──────────────────────────

/**
 * Split delta: the children of `originalId` redistribute between the original and the fresh
 * `newId` half by which half's shape contains them (centroid test); a straddler (contained by
 * both or neither) STAYS under the original (nearest containing). Returns the invertible delta.
 */
export function splitPreserveChildren(
  objects: readonly HierObject[],
  originalId: HierId,
  newId: HierId,
  originalShape: ContainmentShape,
  newShape: ContainmentShape,
): HierarchyDelta {
  const changes: ParentageChange[] = []
  for (const o of objects) {
    if (o.parentId !== originalId) continue
    const [cx, cy] = o.shape.centroid
    const inNew = newShape.contains(cx, cy)
    const inOrig = originalShape.contains(cx, cy)
    // Reassign ONLY when the child clearly belongs to the new half (in new AND not in original).
    if (inNew && !inOrig) changes.push({ id: o.id, oldParent: originalId, newParent: newId })
  }
  return { changes }
}

/**
 * Merge delta: every child of `fromId` re-parents to the survivor `toId` (union of children).
 * Also re-parents `fromId` itself to `toId`? No — `fromId` is dissolved by the merge; its
 * children move up under the survivor. Returns the invertible delta.
 */
export function mergePreserveChildren(
  objects: readonly HierObject[],
  fromId: HierId,
  toId: HierId,
): HierarchyDelta {
  if (fromId === toId) return EMPTY_HIERARCHY_DELTA
  // Guard INV-10 (single-parent acyclic forest): merging a parent INTO one of its own descendants
  // (e.g. a region into a cell it contains) must not re-parent the survivor — or an object that is an
  // ANCESTOR of the survivor — under `toId`, or we'd emit a self-parent / cycle. Collect `toId`'s
  // current ancestor chain (treating `fromId` as dissolved) and skip any re-parent that would close a loop.
  const parentById = new Map(objects.map(o => [o.id, o.parentId ?? null]))
  const toAncestors = new Set<HierId>([toId])
  for (let cur = parentById.get(toId) ?? null, guard = 0; cur != null && guard < objects.length; guard++) {
    if (cur === fromId) cur = parentById.get(cur) ?? null // fromId dissolves — walk past it
    else { toAncestors.add(cur); cur = parentById.get(cur) ?? null }
  }
  const changes: ParentageChange[] = []
  for (const o of objects) {
    // re-parent fromId's children to the survivor, EXCEPT the survivor itself or any ancestor of it
    // (those would create a self-parent / cycle).
    if (o.parentId === fromId && !toAncestors.has(o.id)) {
      changes.push({ id: o.id, oldParent: fromId, newParent: toId })
    }
  }
  return changes.length ? { changes } : EMPTY_HIERARCHY_DELTA
}

/**
 * Re-resolve parentage for ONLY the given ids (e.g. after a relabel / level change), leaving all
 * other objects' parents untouched. Returns the delta for those whose parent actually changed.
 */
export function reresolveParentage(
  objects: readonly HierObject[],
  affectedIds: readonly HierId[],
): HierarchyDelta {
  const resolved = resolveHierarchy(objects)
  const affected = new Set(affectedIds)
  const byId = new Map(objects.map(o => [o.id, o]))
  const changes: ParentageChange[] = []
  for (const id of affectedIds) {
    const o = byId.get(id)
    if (!o) continue
    const next = resolved.get(id) ?? null
    if (next !== o.parentId) changes.push({ id, oldParent: o.parentId, newParent: next })
  }
  void affected
  return changes.length ? { changes } : EMPTY_HIERARCHY_DELTA
}

/** Compose the full resolve into a delta relative to the objects' CURRENT parents. */
export function resolveDelta(objects: readonly HierObject[]): HierarchyDelta {
  const resolved = resolveHierarchy(objects)
  const changes: ParentageChange[] = []
  for (const o of objects) {
    const next = resolved.get(o.id) ?? null
    if (next !== o.parentId) changes.push({ id: o.id, oldParent: o.parentId, newParent: next })
  }
  return changes.length ? { changes } : EMPTY_HIERARCHY_DELTA
}

// ── delta application (forward / inverse) ────────────────────────────────────────

/** Apply a delta's FORWARD parentage (id→newParent) to a mutable parent map, in place. */
export function applyHierarchyDelta(target: Map<HierId, HierId | null>, delta: HierarchyDelta): void {
  for (const c of delta.changes) target.set(c.id, c.newParent)
}

/** Apply a delta's INVERSE parentage (id→oldParent) to a mutable parent map, in place. */
export function invertHierarchyDelta(target: Map<HierId, HierId | null>, delta: HierarchyDelta): void {
  for (const c of delta.changes) target.set(c.id, c.oldParent)
}

/** The inverse delta (swap old/new) — for pushing onto a redo/undo stack directly. */
export function reverseDelta(delta: HierarchyDelta): HierarchyDelta {
  return { changes: delta.changes.map(c => ({ id: c.id, oldParent: c.newParent, newParent: c.oldParent })) }
}

// ── bridge to the vector-annotation collection ──────────────────────────────────

/** Build `HierObject`s from an annotation collection (input order = collection `ids`). */
export function hierObjectsFromAnnotations(collection: AnnotationCollection): HierObject[] {
  const out: HierObject[] = []
  for (const id of collection.ids) {
    const a: Annotation | undefined = collection.byId[id]
    if (!a) continue
    out.push({ id, parentId: a.parentId ?? null, level: a.level ?? null, shape: shapeOfAnnotation(a) })
  }
  return out
}

/** Build the normalized forest directly from an annotation collection. */
export function forestFromAnnotations(collection: AnnotationCollection): HierForest {
  const parentOf = new Map<HierId, HierId | null>()
  for (const id of collection.ids) parentOf.set(id, collection.byId[id]?.parentId ?? null)
  return buildForest(collection.ids, parentOf)
}
