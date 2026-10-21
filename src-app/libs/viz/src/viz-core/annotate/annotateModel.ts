// annotateModel.ts — the pure annotation data model shared across the annotate module.
// viz-core purity rule: NO deck/react/store/backend imports here (types + pure helpers
// only), mirroring `spatial/regionSelect.ts` / `data/image.ts`.
//
// INVARIANTS THIS FILE ANCHORS:
// - INV-4: geometry is stored in ONE canonical space — full-resolution image pixels —
//   as flat coordinate arrays (level-independent); every other space is derived via the
//   `coords.ts` facade. Never store a pyramid level's pixels here.
// - INV-7: the model carries exactly what GeoJSON round-trips (geometry + class + label
//   + id + a foreign-property passthrough bag).

import type { ToolKeyFor } from '../tools/vocabulary'

/** Stable per-annotation id (UUID string), preserved across import→edit→export (INV-7). */
export type AnnotationId = string

/** Geometry kinds the editor authors. Coordinates are flat interleaved xy pairs in
 *  FULL-RESOLUTION image pixels (INV-4). A polygon's `rings[0]` is the exterior ring,
 *  `rings[1..]` are holes. A path is an open polyline. */
export type AnnotationKind = 'polygon' | 'point' | 'path'

export interface PolygonGeometry {
  readonly kind: 'polygon'
  /** exterior ring first, then holes; each ring is [x0,y0, x1,y1, …] full-res px. */
  readonly rings: ReadonlyArray<Float64Array>
}
export interface PointGeometry {
  readonly kind: 'point'
  readonly xy: readonly [number, number] // full-res px
}
export interface PathGeometry {
  readonly kind: 'path'
  readonly xy: Float64Array // [x0,y0,…] full-res px, open
}
export type AnnotationGeometry = PolygonGeometry | PointGeometry | PathGeometry

/** A named class (QuPath `classification`): `name` + an rgb colour 0–255 (INV-7). */
export interface AnnotationClass {
  readonly id: string
  readonly name: string
  readonly color: readonly [number, number, number]
}

/** One annotation. `properties` is the foreign-property passthrough bag: any GeoJSON
 *  `Feature.properties` key the editor does not model is retained here verbatim so a
 *  QuPath-authored file round-trips losslessly (INV-7). */
export interface Annotation {
  readonly id: AnnotationId
  readonly geometry: AnnotationGeometry
  readonly classId: string | null
  readonly label: string | null
  readonly locked?: boolean
  readonly properties?: Readonly<Record<string, unknown>>
  /** Hierarchy level tag — a HOST-SUPPLIED open string (like `classId`), NOT a fixed enum
   *  (DEC-8). Absent ⇒ the object is level-less (flat model, byte-identical to pre-hierarchy). */
  readonly level?: string | null
  /** Parent object id in the single-parent forest (INV-10), or null/absent for a root. Kept on
   *  the model so it round-trips through GeoJSON (INV-7) and rides the store's Immer undo atom. */
  readonly parentId?: AnnotationId | null
}

/** The editor's tool vocabulary — DERIVED from the one registry (INV-14), never declared here.
 *  Resolves to `'select' | 'point' | 'polygon' | 'brush'`.
 *  `'reshape'` folded into `'select'` (DEC-18): selecting an annotation reveals its draggable vertex
 *  handles, so the reshape CAPABILITY is retained while the redundant mode is gone. */
export type AnnotateTool = ToolKeyFor<'annotate'>

/** The normalized collection the per-instance store holds (byId + ordered ids). */
export interface AnnotationCollection {
  readonly byId: Readonly<Record<AnnotationId, Annotation>>
  readonly ids: readonly AnnotationId[]
}

export const EMPTY_COLLECTION: AnnotationCollection = { byId: {}, ids: [] }

/** Bounding box [minX,minY,maxX,maxY] in full-res px of an annotation's geometry —
 *  the key the flatbush viewport-cull index is built over (DEC-B). */
export function annotationBounds(a: Annotation): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const g = a.geometry
  if (g.kind === 'point') {
    acc(g.xy[0], g.xy[1])
  } else if (g.kind === 'path') {
    for (let i = 0; i + 1 < g.xy.length; i += 2) acc(g.xy[i], g.xy[i + 1])
  } else {
    for (const ring of g.rings) for (let i = 0; i + 1 < ring.length; i += 2) acc(ring[i], ring[i + 1])
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0]
  return [minX, minY, maxX, maxY]
}
