// useAnnotateEditor.tsx — the SINGLE-CANVAS annotation editing hook (ITEM-3). The editable
// twin of `selection/useAreaSelection`: it owns the pointer→gesture translation, the LIVE
// draft in a `useRef`/local state (imperative preview — never the store), and commits ONCE on
// pointer-up. A host supplies only `unproject` (its viewport's screen→world) + the per-cell
// `AnnotateStore`; every tool (polygon / point / brush / select / reshape) is wired here to the
// pure gesture + brush/freehand modules and the store actions.
//
// COMMIT-ONCE (the drag-coalescing contract, ITEM-5/6): a drag of N moves updates only local
// preview state; the store is written exactly ONCE on pointer-up (or on `finishPolygon`), so
// the whole drag becomes ONE undo entry and no big subtree re-renders per `pointermove`.

import { useCallback, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useStore } from 'zustand'
import {
  hitTestTopmostAnnotation,
  translateAnnotation,
  moveVertex,
  finishPolygon as buildPolygonFromDraft,
  isPolygonCloseHit,
  isPolygonClosable,
  type Vec2,
} from './annotationGestures'
import {
  createScratchRaster,
  stampPath,
  marchingSquares,
} from './brushRaster'
import { rdpSimplify } from './freehand'
import type { Annotation, AnnotationGeometry, PolygonGeometry } from './annotateModel'
import type { AnnotateStore } from './Annotate.store'
import { DRAFT_CLOSE_RADIUS_PX, type AnnotationEditDraft } from './buildAnnotationLayers'

/** Min pointer travel (screen px) between idle-hover re-hit-tests — throttles the O(N) topmost
 *  scan so it doesn't run on every `pointermove` while merely gliding over the canvas (finding 3). */
const HOVER_RETEST_MIN_PX = 3

/** Screen→world adapter (the host's viewport un-project). Full-res px out (INV-4). */
export type Unproject = (clientX: number, clientY: number) => Vec2 | null

export interface UseAnnotateEditorOpts {
  /**
   * The per-cell annotation store the editor is currently BOUND to (from `useAnnotateStore()`).
   * Used for the REACTIVE reads only (the `activeTool`→`cursor` subscription), so a tool switch in
   * the bound pane re-renders the cursor affordance.
   */
  store: AnnotateStore
  /**
   * ITEM-10 / INV-13 — SYNCHRONOUS per-pane store resolution. A multi-pane host (GridWorkspace)
   * binds the gesture to the pane UNDER THE CURSOR on pointer-down and returns that pane's store
   * here, so the SAME press that lands in a pane also draws in it — no press is consumed to
   * establish focus and no hidden "active pane" mediates the gesture. Omitted ⇒ `store` is used
   * (the single-pane case: the showcase stories, `AnnotateProvider`-scoped hosts).
   *
   * MUST be resolved from a ref, not React state: it is read during the pointer-down handler that
   * also performs the binding, so a state-driven value would be one event behind.
   */
  resolveStore?: () => AnnotateStore | undefined
  /** the host viewport's screen→world adapter. */
  unproject: Unproject
  /** grab radius in WORLD (full-res px) for select hit-test / vertex pick (default 6). */
  pickRadiusWorld?: number
  /** brush disk radius in full-res px (default 12). */
  brushRadius?: number
  /** RDP tolerance in full-res px for freehand/brush rings (default 2). */
  simplifyTolerance?: number
  /** min world distance between captured brush samples (throttle; default 2). */
  captureMinDist?: number
}

export interface AnnotateEditorApi {
  pointerHandlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  }
  /** the in-flight edit surfaced to `buildAnnotationLayers({editDraft})`, or `null`. */
  editDraft: AnnotationEditDraft | null
  /** dropped polygon vertices (drives a "Finish (n)" affordance). */
  polyDraftLength: number
  /** commit the in-progress polygon draft (≥3 verts) as a new annotation. */
  finishPolygon: () => void
  /** drop any in-progress draft/drag (call on a tool switch). */
  resetDraft: () => void
  /** cursor the host should show over the draw overlay for the active tool. */
  cursor: 'crosshair' | 'move' | 'default'
  /** BLIND-AUDIT M8 — abandon an in-progress polygon at ANY vertex count. `finishPolygon` needs 3
   *  and the close-target is inert below 3, so a 1-2 vertex draft had no way out but a pane switch. */
  cancelDraft: () => void
  /** whether there is anything to cancel (drives an enabled/disabled affordance). */
  hasDraft: boolean
}

/** Bounded-bbox brush rasterization: stamp the captured path into a LOCAL scratch raster
 *  (cost ∝ brushed bbox, not image size), trace + simplify, then offset the ring back to
 *  full-res px. Reuses the pure `brushRaster`/`freehand` primitives (INV-6). */
function brushCaptureToPolygon(
  path: readonly Vec2[],
  radius: number,
  tol: number,
): PolygonGeometry | null {
  if (path.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of path) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const pad = Math.ceil(radius) + 2
  const ox = Math.floor(minX) - pad
  const oy = Math.floor(minY) - pad
  const w = Math.ceil(maxX) - ox + pad
  const h = Math.ceil(maxY) - oy + pad
  if (!(w > 0) || !(h > 0) || w * h > 64_000_000) return null // sane bound
  const raster = createScratchRaster(w, h)
  stampPath(raster, path.map(([x, y]) => [x - ox, y - oy] as Vec2), radius)
  const boundary = marchingSquares(raster)
  if (boundary.length < 3) return null
  const simplified = rdpSimplify(boundary, tol)
  if (simplified.length < 3) return null
  const flat = new Float64Array(simplified.length * 2)
  for (let i = 0; i < simplified.length; i++) {
    flat[2 * i] = simplified[i][0] + ox
    flat[2 * i + 1] = simplified[i][1] + oy
  }
  return { kind: 'polygon', rings: [flat] }
}

/** Nearest polygon vertex to `p` within `radius` (world) across a polygon's rings. */
function nearestVertex(
  geom: PolygonGeometry,
  p: Vec2,
  radius: number,
): { ringIndex: number; vertexIndex: number } | null {
  const r2 = radius * radius
  let best = r2
  let hit: { ringIndex: number; vertexIndex: number } | null = null
  for (let ri = 0; ri < geom.rings.length; ri++) {
    const ring = geom.rings[ri]
    for (let vi = 0, n = ring.length >>> 1; vi < n; vi++) {
      const dx = ring[2 * vi] - p[0]
      const dy = ring[2 * vi + 1] - p[1]
      const d2 = dx * dx + dy * dy
      if (d2 <= best) {
        best = d2
        hit = { ringIndex: ri, vertexIndex: vi }
      }
    }
  }
  return hit
}

export function useAnnotateEditor({
  store,
  resolveStore,
  unproject,
  pickRadiusWorld = 6,
  brushRadius = 12,
  simplifyTolerance = 2,
  captureMinDist = 2,
}: UseAnnotateEditorOpts): AnnotateEditorApi {
  // ITEM-10 / INV-13 — the store every IMPERATIVE path reads. A multi-pane host binds the gesture to
  // the pane under the cursor synchronously in its own pointer-down (before delegating here), so
  // `resolveStore()` already names the pressed pane on the FIRST press. Falls back to the bound
  // `store` for single-pane hosts. Read through a ref so the handlers stay referentially stable.
  const resolveStoreRef = useRef<(() => AnnotateStore | undefined) | undefined>(resolveStore)
  resolveStoreRef.current = resolveStore
  const storeRef = useRef(store)
  storeRef.current = store
  const storeNow = useCallback((): AnnotateStore => resolveStoreRef.current?.() ?? storeRef.current, [])
  // Draft state (local — re-renders the cheap preview; never the store during a gesture).
  const [polyDraft, setPolyDraft] = useState<Vec2[]>([])
  // ITEM-14 — the live cursor for the rubber band. Kept in state (it must re-render the preview)
  // but written only while a polygon draft is OPEN, so an idle pointer costs nothing.
  const [draftCursor, setDraftCursor] = useState<Vec2 | null>(null)
  // `onPointerDown` needs the CURRENT draft synchronously to decide "close the ring vs drop a
  // vertex"; the state value it closes over is a render behind.
  //
  // BLIND-AUDIT H1 (INV-11): the ref is AUTHORITATIVE and is written by `writeDraft` on every
  // mutation. It used to be re-assigned from state on every render (`polyDraftRef.current =
  // polyDraft`), which made `resetDraft()` — a QUEUED `setPolyDraft([])` — a no-op WITHIN the
  // event that called it. A pane switch calls `resetDraft()` and then delegates to
  // `onPointerDown` in the SAME event, so the ref still held the OLD pane's vertices while
  // `storeNow()` already resolved to the NEW pane: pane A's in-flight polygon committed INTO
  // pane B carrying A's coordinates. Never restore the render-time assignment — a render landing
  // between a synchronous clear and the state flush would resurrect the stale draft.
  const polyDraftRef = useRef<Vec2[]>([])
  const writeDraft = useCallback((next: Vec2[]) => {
    polyDraftRef.current = next
    setPolyDraft(next)
  }, [])
  const [preview, setPreview] = useState<{ id: string; geometry: PolygonGeometry } | null>(null)
  const [hoverMovable, setHoverMovable] = useState(false)

  // Brush stroke: accumulate in a `useRef` array mutated IN PLACE (O(1) push, finding 5) — the old
  // `setCapturePath(prev => [...prev, p])` copied the whole growing array per pointermove (O(n²)).
  // `captureVersion` is a cheap re-render tick; `editDraft` reads `captureRef.current` directly.
  const captureRef = useRef<Vec2[]>([])
  const [captureVersion, setCaptureVersion] = useState(0)

  // Imperative drag bookkeeping (no re-render).
  const dragRef = useRef<{ id: string; startWorld: Vec2; origGeom: AnnotationGeometry } | null>(null)
  const vertexRef = useRef<{ id: string; ringIndex: number; vertexIndex: number; origGeom: PolygonGeometry } | null>(null)
  const capturingRef = useRef(false)
  // The geometry to write on pointer-up (drag/vertex), stashed each move so up commits ONCE.
  const pendingGeomRef = useRef<AnnotationGeometry | null>(null)
  // Idle-hover throttle: last screen position we ran the topmost hit-test at (finding 3).
  const hoverPosRef = useRef<{ x: number; y: number } | null>(null)

  // Reactive active tool (finding 4) — subscribing here makes the `cursor` memo (and any
  // tool-dependent render) update on a tool switch instead of reading a stale snapshot.
  const activeTool = useStore(store, s => s.activeTool)

  /** Convert a SCREEN-px distance to WORLD units at the current zoom, by unprojecting a 1px
   *  horizontal offset from the given screen point. Falls back to `pickRadiusWorld` if the host's
   *  unproject declines (outside any viewport). */
  const screenPxToWorld = useCallback(
    (clientX: number, clientY: number, px: number): number => {
      const a = unproject(clientX, clientY)
      const b = unproject(clientX + 1, clientY)
      if (!a || !b) return pickRadiusWorld
      const perPx = Math.hypot(b[0] - a[0], b[1] - a[1])
      return perPx > 0 ? px * perPx : pickRadiusWorld
    },
    [unproject, pickRadiusWorld],
  )

  const annotationList = useCallback((): Annotation[] => {
    const s = storeNow().getState()
    return s.ids.map(id => s.byId[id]).filter((a): a is Annotation => !!a)
  }, [storeNow])

  const resetDraft = useCallback(() => {
    // H1: clear the ref SYNCHRONOUSLY — a caller (a pane switch) delegates to the pointer
    // handlers in the same event and must not see the previous pane's vertices.
    writeDraft([])
    setDraftCursor(null)
    captureRef.current = []
    setCaptureVersion(v => v + 1)
    setPreview(null)
    setHoverMovable(false)
    dragRef.current = null
    vertexRef.current = null
    capturingRef.current = false
    pendingGeomRef.current = null
    hoverPosRef.current = null
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const p = unproject(e.clientX, e.clientY)
      if (!p) return
      const st = storeNow().getState()
      const tool = st.activeTool

      if (tool === 'point') {
        st.add({ geometry: { kind: 'point', xy: [p[0], p[1]] }, classId: st.activeClassId })
        return
      }
      if (tool === 'polygon') {
        // ITEM-15 — a press on the FIRST vertex CLOSES the ring instead of dropping another
        // vertex, which is what the enlarged first-vertex target promises. Same predicate the
        // overlay uses for the affordance, so what is shown and what happens are one decision.
        const draft = polyDraftRef.current
        // BLIND-AUDIT M3 — ONE unit basis for the target and its hit-test. The drawn
        // `annot-draft-close` ring is DRAFT_CLOSE_RADIUS_PX in SCREEN px (`radiusUnits:'pixels'`),
        // but this test used `pickRadiusWorld` (6 WORLD px). They coincide only near zoom 1: zoomed
        // out, a press on the highlighted target dropped another vertex; zoomed in, a press well
        // outside the visible ring closed the ring. Convert the ring's screen radius into world at
        // the CURRENT zoom (unproject a 1px screen offset) so what is shown and what happens are the
        // same decision at every zoom — which is what both this module and the layer comment claim.
        const closeRadiusWorld = screenPxToWorld(e.clientX, e.clientY, DRAFT_CLOSE_RADIUS_PX)
        if (isPolygonCloseHit(draft, p, closeRadiusWorld)) {
          const geom = buildPolygonFromDraft(draft)
          if (geom) st.add({ geometry: geom, classId: st.activeClassId })
          writeDraft([])
          setDraftCursor(null)
          return
        }
        writeDraft([...polyDraftRef.current, [p[0], p[1]]])
        // Seed the rubber band at the vertex just dropped so the pending edge exists before the
        // pointer moves (otherwise the first segment appears only after a move event).
        setDraftCursor([p[0], p[1]])
        return
      }
      if (tool === 'brush') {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        capturingRef.current = true
        captureRef.current = [[p[0], p[1]]]
        setCaptureVersion(v => v + 1)
        return
      }
      if (tool === 'select') {
        // DEC-18 (reshape folded into select): a SELECTED polygon shows its vertex handles, so a
        // press near one grabs that vertex. Miss ⇒ fall through to a topmost-hit select/translate.
        // This is the whole of the old `reshape` MODE — the capability, without the extra tool.
        const selId = [...st.selection][0]
        const sel = selId ? st.byId[selId] : undefined
        if (sel && sel.geometry.kind === 'polygon') {
          const hitV = nearestVertex(sel.geometry, p, pickRadiusWorld)
          if (hitV) {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            vertexRef.current = { id: sel.id, ...hitV, origGeom: sel.geometry }
            return
          }
        }
      }
      // 'select' (vertex-grab miss) / any other tool: topmost hit → select + start translate.
      const list = annotationList()
      const i = hitTestTopmostAnnotation(list, p, pickRadiusWorld)
      if (i >= 0) {
        const a = list[i]
        e.currentTarget.setPointerCapture?.(e.pointerId)
        st.select([a.id])
        dragRef.current = { id: a.id, startWorld: [p[0], p[1]], origGeom: a.geometry }
      } else if (tool === 'select') {
        st.select(null)
      }
    },
    [storeNow, unproject, pickRadiusWorld, annotationList],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Vertex reshape drag.
      if (vertexRef.current) {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        const v = vertexRef.current
        const next = moveVertex(v.origGeom, v.ringIndex, v.vertexIndex, p[0], p[1])
        pendingGeomRef.current = next
        setPreview({ id: v.id, geometry: next })
        return
      }
      // Whole-feature translate drag.
      if (dragRef.current) {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        const d = dragRef.current
        const moved = translateAnnotation(
          { id: d.id, geometry: d.origGeom, classId: null, label: null },
          p[0] - d.startWorld[0],
          p[1] - d.startWorld[1],
        )
        pendingGeomRef.current = moved.geometry
        if (moved.geometry.kind === 'polygon') setPreview({ id: d.id, geometry: moved.geometry })
        return
      }
      // Brush capture: mutate the ref array in place (O(1)); tick a version to re-render the
      // preview. No per-move array copy → a long stroke is O(n), not O(n²) (finding 5).
      if (capturingRef.current) {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        const path = captureRef.current
        const last = path[path.length - 1]
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < captureMinDist) return
        path.push([p[0], p[1]])
        setCaptureVersion(v => v + 1)
        return
      }
      // ITEM-14 / INV-15 — an OPEN polygon draft tracks the cursor so the pending edge is drawn
      // between clicks (the marquee/lasso select path always did this; the annotate path did not,
      // and could not: its draft trigger keyed on vertex COUNT). Guarded on an open draft, so a
      // pointer moving over a pane with no draft still costs nothing.
      // BLIND-AUDIT M9 — also require the POLYGON tool to still be active. Gated on draft length
      // alone, switching tools mid-draft left the rubber band live AND `return`ed before the idle
      // hover branch below, so the pane's hover affordance died until the stale draft was cleared.
      if (polyDraftRef.current.length > 0 && storeNow().getState().activeTool === 'polygon') {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        setDraftCursor(prev =>
          prev && prev[0] === p[0] && prev[1] === p[1] ? prev : [p[0], p[1]],
        )
        return
      }
      // Idle hover: reflect whether a press would grab a feature (the `move` cursor affordance).
      // Throttle by a min SCREEN distance (finding 3) so the O(N) topmost hit-test + the
      // allocate-all `annotationList()` run only when the pointer has actually moved, not on
      // every single `pointermove` event.
      const st = storeNow().getState()
      if (st.activeTool === 'select') {
        const lastHover = hoverPosRef.current
        if (lastHover && Math.hypot(e.clientX - lastHover.x, e.clientY - lastHover.y) < HOVER_RETEST_MIN_PX) return
        hoverPosRef.current = { x: e.clientX, y: e.clientY }
        const p = unproject(e.clientX, e.clientY)
        const over = !!p && hitTestTopmostAnnotation(annotationList(), p, pickRadiusWorld) >= 0
        setHoverMovable(prev => (prev === over ? prev : over))
      }
    },
    [storeNow, unproject, pickRadiusWorld, captureMinDist, annotationList],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const st = storeNow().getState()
      // Commit a vertex reshape / translate ONCE (drag-coalesced → one undo entry).
      if (vertexRef.current || dragRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        const id = vertexRef.current?.id ?? dragRef.current?.id
        const geom = pendingGeomRef.current
        if (id && geom) st.reshape(id, geom)
        dragRef.current = null
        vertexRef.current = null
        pendingGeomRef.current = null
        setPreview(null)
        return
      }
      // Commit a brush stroke.
      if (capturingRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        capturingRef.current = false
        const path = captureRef.current
        captureRef.current = []
        setCaptureVersion(v => v + 1)
        const geom = brushCaptureToPolygon(path, brushRadius, simplifyTolerance)
        if (geom) st.add({ geometry: geom, classId: st.activeClassId })
        return
      }
      // 'polygon' finishes via finishPolygon(); 'point' committed on down — nothing to do.
    },
    [storeNow, brushRadius, simplifyTolerance],
  )

  const finishPolygon = useCallback(() => {
    const geom = buildPolygonFromDraft(polyDraft)
    if (geom) {
      const st = storeNow().getState()
      st.add({ geometry: geom, classId: st.activeClassId })
    }
    writeDraft([])
    setDraftCursor(null)
  }, [polyDraft, storeNow])

  const editDraft: AnnotationEditDraft | null = useMemo(() => {
    // The brush stroke lives in `captureRef` (grown in place); `captureVersion` is the recompute
    // signal. buildAnnotationLayers keys the draft `updateTriggers` on `draftPath.length`, so the
    // in-place-grown ref still re-tessellates the tiny preview path per accepted sample.
    const capture = captureRef.current
    const draftPath = polyDraft.length > 0 ? polyDraft : capture.length > 0 ? capture : undefined
    if (!draftPath && !preview) return null
    // The rubber band + close target belong to the POLYGON draft only — a brush capture's path is
    // already the stroke, so trailing it to the cursor would draw a phantom segment.
    const isPolygon = polyDraft.length > 0
    return {
      draftPath,
      cursor: isPolygon ? draftCursor : null,
      closable: isPolygon && isPolygonClosable(polyDraft),
      previewId: preview?.id,
      previewGeometry: preview?.geometry,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captureVersion IS the captureRef signal
  }, [polyDraft, captureVersion, preview, draftCursor])

  const cursor: AnnotateEditorApi['cursor'] = useMemo(() => {
    if (hoverMovable) return 'move'
    // `activeTool` is a reactive subscription (finding 4) → the cursor updates on a tool switch.
    return activeTool === 'select' ? 'default' : 'crosshair'
  }, [hoverMovable, activeTool])

  return {
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp },
    editDraft,
    polyDraftLength: polyDraft.length,
    finishPolygon,
    resetDraft,
    // M8 — `resetDraft` already drops everything in flight; expose it under an intent-naming name
    // so a UI can offer Cancel independently of Finish (which requires 3 vertices).
    cancelDraft: resetDraft,
    hasDraft: polyDraft.length > 0,
    cursor,
  }
}
