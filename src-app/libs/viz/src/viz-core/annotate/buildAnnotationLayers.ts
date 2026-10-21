// buildAnnotationLayers.ts — the deck.gl layer builder for the annotation overlay (ITEM-3,
// DEC-B two-tier render). The HOST composes the returned `Layer[]` into the ONE shared grid
// deck (never a parallel `<DeckGL>`); layer ids are prefixed with the cell id via
// `cellLayerId` so the grid's `makeLayerFilter` scopes each layer to its cell's viewport,
// exactly like `cellScatterLayerId` / the raster image layers.
//
// TWO TIERS (per-frame cost ∝ VISIBLE features, not total — the gigapixel invariant):
//   • STATIC tier — the many committed annotations. Built once per (collection, viewport)
//     and VIEWPORT-CULLED via a `flatbush` static R-tree over per-feature bboxes
//     (`annotationBounds`), the immutable analog of `spatial/pointIndex`. A polygon `data`
//     accessor renders fills + ring outlines correctly (incl. holes); points/paths render
//     from packed `Float64Array` position buffers. (Further DEC-B step: pack the polygon
//     tier into a binary `SolidPolygonLayer` with `_normalize:false`; the cull is the
//     load-bearing perf lever and is implemented here.)
//   • EDIT tier — only the FEW features in flight (the current draft path + the selected /
//     live-previewed feature): their edges + draggable vertex handles. Re-tessellation is
//     isolated to these, so a reshape costs O(verts of one feature), never O(collection).
//
// Pure builder (viz-core): depends only on @deck.gl + `flatbush` + the pure `annotateModel`
// — no store / react / backend import (INV-1/2). Coordinates are full-res image pixels
// (INV-4); the grid supplies the world `modelMatrix` on the shared deck.

import Flatbush from 'flatbush'
import type { Layer } from '@deck.gl/core'
import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers'
import {
  annotationBounds,
  type Annotation,
  type AnnotationId,
  type AnnotationCollection,
  type PolygonGeometry,
} from './annotateModel'
import { ringToPairs, rubberBandPath, type Vec2 } from './annotationGestures'
import { cellLayerId } from '../layers/multiView'

type RGBA = [number, number, number, number]

// Overlay palette — numeric deck colours (NOT CSS; the token lint governs CSS/tailwind only).
const FILL: RGBA = [96, 165, 250, 55] // committed polygon fill (translucent)
const LINE: RGBA = [37, 99, 235, 210] // committed outline / path
const POINT: RGBA = [37, 99, 235, 230] // committed point
const SEL_LINE: RGBA = [250, 204, 21, 235] // selected feature edges
const HANDLE: RGBA = [255, 255, 255, 255] // vertex handle fill
const HANDLE_LINE: RGBA = [37, 99, 235, 255] // vertex handle stroke
const DRAFT_LINE: RGBA = [250, 204, 21, 235] // in-progress draft path

const POINT_RADIUS_PX = 4
const HANDLE_RADIUS_PX = 5
const OUTLINE_WIDTH_PX = 1.5
const EDIT_WIDTH_PX = 2

// ITEM-13 / INV-15 — a DRAFT vertex must not be confusable with a COMMITTED point. The shipped
// defect was a 4px filled blue dot (committed) next to a 5px dot (draft) in the same blue: one
// pixel apart, same hue, so a single click with EITHER tool looked identical and the canvas never
// told you which tool was live. The draft vertex is now distinguished on THREE independent
// channels — FILL (hollow vs solid), HUE (amber vs blue) and radius — so no single rendering
// change can quietly collapse the distinction again.
const DRAFT_VERT_RADIUS_PX = 5
/** the first vertex, enlarged once the ring may be closed (the "click here to close" target). */
/** Screen-px radius of the enlarged first-vertex "click here to close" target.
 *  EXPORTED because the hit-test must use the SAME number in the SAME unit basis — see
 *  `useAnnotateEditor`'s close branch (blind-audit M3). */
export const DRAFT_CLOSE_RADIUS_PX = 8
const DRAFT_VERT_WIDTH_PX = 2

/** An in-progress edit surfaced to the overlay: the open draft path being drawn AND/OR one
 *  feature whose geometry is being live-previewed (reshape / translate) — overrides the
 *  committed geometry for `previewId` so the edit reads smoothly before commit. */
export interface AnnotationEditDraft {
  /** open polygon/freehand vertices dropped so far (the "Finish (n)" preview). */
  readonly draftPath?: readonly Vec2[]
  /** ITEM-14 — the LIVE cursor while a polygon draft is open, in full-res px (INV-4). The draft
   *  path is stroked out to this point (the rubber band), so the pending edge tracks the pointer
   *  BETWEEN clicks. `null`/absent ⇒ no trailing segment (pointer outside the pane, or a brush
   *  capture, whose path is already the stroke). */
  readonly cursor?: Vec2 | null
  /** ITEM-15 — the draft holds enough vertices to close; enlarges the first vertex into the
   *  "click here to close" target. Driven by the same predicate as the close hit-test, so the
   *  affordance and the behaviour cannot disagree. */
  readonly closable?: boolean
  /** id of the feature being live-edited; its `previewGeometry` replaces the committed one. */
  readonly previewId?: AnnotationId
  readonly previewGeometry?: PolygonGeometry
}

/** The visible world region to cull against (full-res px bbox `[minX,minY,maxX,maxY]`), or
 *  `null` to draw everything (small collections / tests). */
export interface AnnotationViewport {
  readonly bounds: readonly [number, number, number, number]
}

export interface BuildAnnotationLayersArgs {
  readonly collection: AnnotationCollection
  readonly editDraft?: AnnotationEditDraft | null
  readonly selection?: ReadonlySet<AnnotationId> | readonly AnnotationId[] | null
  readonly viewport?: AnnotationViewport | null
  readonly cellId: string
}

/** Ring (flat Float64Array) → deck nested `[[x,y],…]` (holes preserved for SolidPolygonLayer). */
function polygonRings(geom: PolygonGeometry): Vec2[][] {
  return geom.rings.map(ringToPairs)
}

/** A model ring, flat, with the first vertex APPENDED so `last === first`.
 *
 *  `PathLayer`'s `_pathType:'loop'` does NOT mean "deck will close this for you" — it means
 *  "this path is ALREADY closed, skip normalization". The tesselator emits `numPoints + 2`
 *  vertices and wraps the trailing two with `index + 1 - numPoints`
 *  (path-tesselator.js::getPointOnPath), which lands on `p1, p2` — correct ONLY when `p_last`
 *  is a duplicate of `p0`. Feed it an OPEN 4-point ring and the wrap emits
 *  `p0,p1,p2,p3,p1,p2`, i.e. a spurious `p3→p1` segment: a diagonal slashed across every
 *  polygon. The model stores rings OPEN (INV-4), so close them here.
 *
 *  Allocated inside the memoized partition / the small edit tier, never per frame. */
function closedRing(ring: Float64Array): Float64Array {
  const n = ring.length
  if (n < 4) return ring // fewer than 2 points — nothing to close
  if (ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) return ring // already closed
  const out = new Float64Array(n + 2)
  out.set(ring, 0)
  out[n] = ring[0]
  out[n + 1] = ring[1]
  return out
}

// ── memoized spatial index + partition (findings 1 & 2) ───────────────────────────────────
//
// The flatbush R-tree and the per-feature bbox scan are O(N log N); they were rebuilt on EVERY
// call (every render / selection change). Memoize BOTH keyed on the collection's `byId` object
// IDENTITY (a module-level WeakMap, mirroring `spatial/pointIndex.ts::makePointIndexCache`): the
// immer store replaces `byId` on ANY geometry/membership mutation and keeps it stable otherwise,
// so a mere selection / editDraft / camera change never rebuilds the index. When `byId` is
// replaced (new gen) or the store is dropped, the entry is GC'd with it — no manual eviction.

/** One built-once static-tier payload for a `byId` identity: the ordered features, the flatbush
 *  cull over their bboxes, and a SINGLE-SLOT partition memo keyed on the viewport bounds so that
 *  the committed-geometry layer `data` arrays stay reference-stable across selection/draft
 *  changes (the parent only pays the O(visible) cull when the CAMERA actually moves). */
interface CollectionEntry {
  readonly all: Annotation[]
  readonly index: Flatbush | null
  memoKey: string | null
  memoPart: Partition | null
}

/** Committed-geometry render data, partitioned by geometry kind. Selection is NOT baked in — it
 *  is applied by a per-datum accessor + `updateTriggers` so a selection change reuses these
 *  arrays (no data reallocation, no re-tessellation of the static tier). */
interface Partition {
  /** polygons in the view (fill + ring-outline source). */
  readonly polygons: Annotation[]
  /** one ring per outline path, tagged with its owning annotation id (selection accessor key).
   *  The ring stays in the model's FLAT `[x0,y0,…]` form — see PATH-LAYER DATA CONTRACT. */
  readonly ringData: { readonly ring: Float64Array; readonly id: AnnotationId }[]
  /** open paths in the view. */
  readonly paths: Annotation[]
  /** packed binary point positions (stable object → deck skips re-upload), or `null`. */
  readonly pointData:
    | { readonly length: number; readonly attributes: { readonly getPosition: { readonly value: Float64Array; readonly size: number } } }
    | null
}

const collectionCache = new WeakMap<object, CollectionEntry>()

/** Build-once (per `byId` identity) the ordered feature list + the flatbush cull. */
function getCollectionEntry(collection: AnnotationCollection): CollectionEntry {
  const key = collection.byId as object
  let entry = collectionCache.get(key)
  if (!entry) {
    const { ids, byId } = collection
    const all = ids.map(id => byId[id]).filter((a): a is Annotation => !!a)
    let index: Flatbush | null = null
    if (all.length > 0) {
      index = new Flatbush(all.length)
      for (const a of all) {
        const [minX, minY, maxX, maxY] = annotationBounds(a)
        index.add(minX, minY, maxX, maxY)
      }
      index.finish()
    }
    entry = { all, index, memoKey: null, memoPart: null }
    collectionCache.set(key, entry)
  }
  return entry
}

/** The viewport-culled, kind-partitioned static-tier data for `(collection, viewport)`. Reuses
 *  the memoized entry; recomputes the partition ONLY when the collection identity or the viewport
 *  bounds change — so a selection / editDraft change returns the SAME array references. */
function getPartition(
  collection: AnnotationCollection,
  viewport: AnnotationViewport | null | undefined,
): Partition {
  const entry = getCollectionEntry(collection)
  const boundsKey = viewport ? viewport.bounds.join(',') : 'all'
  if (entry.memoKey === boundsKey && entry.memoPart) return entry.memoPart

  const { all, index } = entry
  let visible: Annotation[]
  if (!viewport || !index || all.length === 0) {
    visible = all
  } else {
    const [vminX, vminY, vmaxX, vmaxY] = viewport.bounds
    visible = index.search(vminX, vminY, vmaxX, vmaxY).map(i => all[i])
  }

  const polygons: Annotation[] = []
  const points: Annotation[] = []
  const paths: Annotation[] = []
  for (const a of visible) {
    if (a.geometry.kind === 'polygon') polygons.push(a)
    else if (a.geometry.kind === 'point') points.push(a)
    else paths.push(a)
  }

  const ringData: { ring: Float64Array; id: AnnotationId }[] = []
  for (const a of polygons) {
    // FLAT + explicitly CLOSED rings (PATH-LAYER DATA CONTRACT) — no `ringToPairs` copy.
    for (const ring of (a.geometry as PolygonGeometry).rings) {
      ringData.push({ ring: closedRing(ring as Float64Array), id: a.id })
    }
  }

  let pointData: Partition['pointData'] = null
  if (points.length > 0) {
    // Packed binary position buffer (DEC-B) — O(visible points), no per-point object.
    const value = new Float64Array(points.length * 2)
    for (let i = 0; i < points.length; i++) {
      const xy = (points[i].geometry as { xy: readonly [number, number] }).xy
      value[2 * i] = xy[0]
      value[2 * i + 1] = xy[1]
    }
    pointData = { length: points.length, attributes: { getPosition: { value, size: 2 } } }
  }

  const part: Partition = { polygons, ringData, paths, pointData }
  entry.memoKey = boundsKey
  entry.memoPart = part
  return part
}

// ── PATH-LAYER DATA CONTRACT (DRIFT-3.1 root cause — do not "simplify" away) ───────────────
//
// Every `PathLayer` below sets `_pathType` ('loop' for closed rings, 'open' for polylines).
// In deck.gl that prop does NOT merely mean "close the ring": it sets `normalize: false` on the
// layer's `PathTesselator` (path-layer.js: `normalize: !props._pathType`). With normalization
// OFF the tesselator NEVER flattens nested input — it assumes each path is already a FLAT
// coordinate array and measures it as `path.length / positionSize`
// (path-tesselator.js::getPathLength), where `positionSize` is 3 unless `positionFormat:'XY'`.
//
// So a nested `[[x,y],…]` path + `_pathType` measures a 4-point ring as 4/3 = 1.33 points,
// `getGeometrySize` sees `< 2` and returns 0 → the layer tesselates to ZERO vertices and paints
// NOTHING, silently, at any width or colour. That was the defect: `annot-outline`,
// `annot-path` and `annot-edit-edges` had never rendered a single pixel. (The sibling
// heatmap/parcoord `PathLayer`s render precisely because they omit `_pathType`, so
// normalization flattens their nested paths for them.)
//
// The fix is to honour the contract rather than drop `_pathType`: feed the model's OWN flat
// `Float64Array` rings and declare `positionFormat: 'XY'`. That is also the faster path — it
// deletes the per-render `ringToPairs` flat→nested copy AND skips normalization entirely.
// INVARIANT: `_pathType` ⇒ flat coordinates ⇒ `positionFormat: 'XY'`. All three, or none.
// Guarded by `buildAnnotationLayers.pathContract.test.ts` (props) + the `annotate-outline-pixels`
// e2e (actual pixels — prop-level tests passed happily while nothing drew).

/** Stable accessors (module-level → no per-call closure alloc; the static tier needs no
 *  `updateTriggers` for these because its `data` reference is memoized-stable). */
const getPolygonAccessor = (a: Annotation): Vec2[][] => polygonRings(a.geometry as PolygonGeometry)
/** flat `[x0,y0,…]` — see PATH-LAYER DATA CONTRACT. */
const getRingAccessor = (d: { ring: Float64Array }): Float64Array => d.ring
/** flat `[x0,y0,…]` — see PATH-LAYER DATA CONTRACT. */
const getPathAccessor = (a: Annotation): Float64Array => (a.geometry as { xy: Float64Array }).xy

/** Edges + vertex-handle layers for ONE feature (the edit tier). */
function editFeatureLayers(
  geom: PolygonGeometry,
  idPrefixCell: string,
  key: string,
  edgeColor: RGBA,
): Layer[] {
  const out: Layer[] = []
  // FLAT + CLOSED rings for the edge PathLayer (PATH-LAYER DATA CONTRACT); the handle layer
  // pairs up the ORIGINAL (open) rings so the duplicated closing vertex grows no second handle.
  const openRings = geom.rings as ReadonlyArray<Float64Array>
  const rings = openRings.map(closedRing)
  out.push(
    new PathLayer<Float64Array>({
      id: cellLayerId(idPrefixCell, `annot-edit-edges-${key}`),
      data: rings,
      getPath: (r: Float64Array) => r,
      getColor: edgeColor,
      getWidth: EDIT_WIDTH_PX,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      _pathType: 'loop',
      positionFormat: 'XY', // REQUIRED with `_pathType` — see PATH-LAYER DATA CONTRACT
      pickable: false,
    }),
  )
  const handles: Vec2[] = openRings.flatMap(ringToPairs)
  out.push(
    new ScatterplotLayer<Vec2>({
      id: cellLayerId(idPrefixCell, `annot-edit-handles-${key}`),
      data: handles,
      getPosition: (v: Vec2) => [v[0], v[1]] as [number, number],
      getRadius: HANDLE_RADIUS_PX,
      radiusUnits: 'pixels',
      getFillColor: HANDLE,
      getLineColor: HANDLE_LINE,
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      stroked: true,
      filled: true,
      pickable: false,
    }),
  )
  return out
}

/**
 * Build the annotation overlay layers for one cell: the viewport-culled static tier + the
 * tiny edit tier. Returns an ordered `Layer[]` the host merges into the shared deck.
 */
export function buildAnnotationLayers(args: BuildAnnotationLayersArgs): Layer[] {
  const { collection, editDraft, selection, viewport, cellId } = args
  const selSet: ReadonlySet<AnnotationId> = Array.isArray(selection)
    ? new Set(selection)
    : (selection as ReadonlySet<AnnotationId> | null | undefined) ?? new Set<AnnotationId>()

  const layers: Layer[] = []
  // Static tier: memoized, reference-stable `data` (finding 2). Selection is applied by the
  // `getColor` accessor + `updateTriggers` below — NOT by rebuilding these arrays — so a mere
  // selection change re-runs only the color attribute, never re-tessellates the committed tier.
  const { polygons, ringData, paths, pointData } = getPartition(collection, viewport)

  // ── static tier ─────────────────────────────────────────────────────────────────────
  if (polygons.length > 0) {
    layers.push(
      new SolidPolygonLayer<Annotation>({
        id: cellLayerId(cellId, 'annot-fill'),
        data: polygons,
        getPolygon: getPolygonAccessor,
        getFillColor: FILL,
        pickable: true,
        _normalize: true,
      }),
    )
    // Ring outlines (one path per ring; selected features drawn brighter via the accessor).
    layers.push(
      new PathLayer<{ ring: Float64Array; id: AnnotationId }>({
        id: cellLayerId(cellId, 'annot-outline'),
        data: ringData,
        getPath: getRingAccessor,
        getColor: (d) => (selSet.has(d.id) ? SEL_LINE : LINE),
        getWidth: OUTLINE_WIDTH_PX,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        _pathType: 'loop',
        positionFormat: 'XY', // REQUIRED with `_pathType` — see PATH-LAYER DATA CONTRACT
        pickable: false,
        updateTriggers: { getColor: [selSet] },
      }),
    )
  }

  if (paths.length > 0) {
    layers.push(
      new PathLayer<Annotation>({
        id: cellLayerId(cellId, 'annot-path'),
        data: paths,
        getPath: getPathAccessor,
        getColor: (a: Annotation) => (selSet.has(a.id) ? SEL_LINE : LINE),
        getWidth: OUTLINE_WIDTH_PX,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        _pathType: 'open',
        positionFormat: 'XY', // REQUIRED with `_pathType` — see PATH-LAYER DATA CONTRACT
        pickable: true,
        updateTriggers: { getColor: [selSet] },
      }),
    )
  }

  if (pointData) {
    layers.push(
      new ScatterplotLayer<Annotation>({
        id: cellLayerId(cellId, 'annot-point'),
        data: pointData,
        getRadius: POINT_RADIUS_PX,
        radiusUnits: 'pixels',
        getFillColor: POINT,
        pickable: true,
      }),
    )
  }

  // ── edit tier (the few features in flight) ────────────────────────────────────────────
  const previewId = editDraft?.previewId
  const previewGeom = editDraft?.previewGeometry
  // The selected committed features get handles (skip the one being live-previewed — it is
  // drawn from `previewGeometry` below).
  for (const id of selSet) {
    if (id === previewId) continue
    const a = collection.byId[id]
    if (a && a.geometry.kind === 'polygon') {
      layers.push(...editFeatureLayers(a.geometry, cellId, `sel-${id}`, SEL_LINE))
    }
  }
  if (previewId && previewGeom) {
    layers.push(...editFeatureLayers(previewGeom, cellId, `preview-${previewId}`, SEL_LINE))
  }

  // In-progress draft path (open) + its dropped vertices.
  const draftPath = editDraft?.draftPath
  if (draftPath && draftPath.length > 0) {
    // ITEM-14 — stroke out to the live cursor so the PENDING edge tracks the pointer between
    // clicks. `rubberBandPath` is shared with the editor's close hit-test (one source of truth).
    const cursor = editDraft?.cursor ?? null
    const strokePath = rubberBandPath(draftPath, cursor)
    // The draft is ONE open `PathLayer` polyline. It was previously stroked as N explicit
    // `LineLayer` segments purely to dodge DRIFT-3.1 (the non-painting `PathLayer`); with the
    // PATH-LAYER DATA CONTRACT honoured — flat coords + `positionFormat:'XY'` — `PathLayer`
    // paints correctly, so the substitution is gone and the joints are continuous again.
    if (strokePath.length >= 2) {
      const draftFlat = new Float64Array(strokePath.length * 2)
      for (let i = 0; i < strokePath.length; i++) {
        draftFlat[2 * i] = strokePath[i][0]
        draftFlat[2 * i + 1] = strokePath[i][1]
      }
      layers.push(
        new PathLayer<Float64Array>({
          id: cellLayerId(cellId, 'annot-draft-path'),
          data: [draftFlat],
          getPath: (p: Float64Array) => p,
          getColor: DRAFT_LINE,
          getWidth: EDIT_WIDTH_PX,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          _pathType: 'open',
          positionFormat: 'XY', // REQUIRED with `_pathType` — see PATH-LAYER DATA CONTRACT
          jointRounded: true,
          capRounded: true,
          pickable: false,
          // Key on the reference (polygon draft = new array per vertex), the length (brush capture
          // mutates ONE `useRef` array in place — finding 5 — so its reference is stable) AND the
          // CURSOR (ITEM-14). Without the cursor terms a pointer-move could not redraw the rubber
          // band at all: the old trigger was `[draftPath, draftPath.length]`, both invariant under a
          // mere cursor move, which is why the draft was frozen between clicks BY CONSTRUCTION.
          updateTriggers: {
            getPath: [draftPath, draftPath.length, cursor?.[0], cursor?.[1]],
          },
        }),
      )
    }
    layers.push(
      new ScatterplotLayer<Vec2>({
        id: cellLayerId(cellId, 'annot-draft-verts'),
        data: draftPath as Vec2[],
        getPosition: (v: Vec2) => [v[0], v[1]] as [number, number],
        getRadius: DRAFT_VERT_RADIUS_PX,
        radiusUnits: 'pixels',
        // HOLLOW + amber (ITEM-13): the committed-point layer is FILLED + blue. Distinct on fill,
        // hue and radius — never on radius alone.
        filled: false,
        stroked: true,
        getLineColor: DRAFT_LINE,
        getLineWidth: DRAFT_VERT_WIDTH_PX,
        lineWidthUnits: 'pixels',
        pickable: false,
        updateTriggers: { getPosition: [draftPath, draftPath.length] },
      }),
    )
    // ITEM-15 — the close target: the FIRST vertex enlarged once the ring may be closed.
    if (editDraft?.closable && draftPath.length > 0) {
      layers.push(
        new ScatterplotLayer<Vec2>({
          id: cellLayerId(cellId, 'annot-draft-close'),
          data: [draftPath[0]],
          getPosition: (v: Vec2) => [v[0], v[1]] as [number, number],
          getRadius: DRAFT_CLOSE_RADIUS_PX,
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: DRAFT_LINE,
          getLineWidth: DRAFT_VERT_WIDTH_PX,
          lineWidthUnits: 'pixels',
          pickable: false,
          updateTriggers: { getPosition: [draftPath[0]] },
        }),
      )
    }
  }

  return layers
}
