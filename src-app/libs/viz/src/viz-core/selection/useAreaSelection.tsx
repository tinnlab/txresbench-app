// useAreaSelection.tsx — the SHARED 2D-area selection interaction for single-canvas hosts
// (SelectableScatter / RasterUnderlay ROI / ViolinView lasso). It owns a `SelectionController`,
// the draft + drag state, the pointer handlers, the realtime polygon preview, commit / finish /
// clear / drag-to-move, and produces the outline shapes — all built on the pure `areaGestures` core.
// A host supplies ONLY `unproject` (its viewport's screen→world) + `positions`/`totalPoints`/
// `pointIndex` + the current `tool`/`mode`; everything else is identical across hosts, so every
// migrated surface gets the SAME persistent committed outline + drag behaviour.
//
// (The GridWorkspace — many cells under ONE deck — can't mount N hooks, so it drives the pure
// `areaGestures` ops + `buildSelectionOutlineLayer` directly; this hook is the single-canvas path.)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { PolygonLayer } from '@deck.gl/layers'
import { IndexMask } from '../data/selection'
import { SelectionController, type Area, type CombineMode } from './SelectionController'
import type { PointIndex } from '../spatial/pointIndex'
import { areaToOp } from './provenance'
import type { VizSelectionOp } from '../option/types'
import {
  translateArea,
  hitTestTopmostArea,
  selectionShapes,
  commitCandidatesFor,
  previewMask,
  outlineStyle,
  type Vec2,
  type SelectionTool,
  type OverlayShape,
} from './areaGestures'

export type Unproject = (clientX: number, clientY: number) => Vec2 | null

/** ITEM-9 — the pane/space a SINGLE-CANVAS host's ops are attributed to. The literals are used
 *  rather than importing `DEFAULT_SELECTION_SPACE` from `adapter/` because that would pull the
 *  store layer into a pure `viz-core` module; `provenance.test.ts` pins the value. */
const SINGLE_CANVAS_PANE = 'canvas'
const DEFAULT_SELECTION_SPACE = 'default'

export interface UseAreaSelectionOpts {
  /** interleaved xy Float32Array (world space), length totalPoints*2. */
  positions: Float32Array
  totalPoints: number
  /** prebuilt spatial index over `positions` (host owns it; the hit-test narrows through it). */
  pointIndex: PointIndex
  /** the host's screen→world adapter (uses the host's current viewport). */
  unproject: Unproject
  tool: SelectionTool
  mode: CombineMode
  /** fired with the combined mask on every selection change (commit / preview / drag / clear). */
  onSelectionChange?: (mask: IndexMask) => void
  /** ITEM-9 — fired with the ORDERED op recipe after every commit, so a single-canvas host can
   *  publish provenance the same way the grid does. Optional: omit it and behaviour is unchanged. */
  onCommitOps?: (ops: readonly VizSelectionOp[]) => void
}

export interface AreaSelectionApi {
  /** per-point 0/1 selection attribute (drives the GPU highlight overlay). */
  selected: Uint8Array
  selCount: number
  /** bump to re-trigger the highlight layer's `getFilterValue`. */
  selEpoch: number
  /** committed outlines (persistent) + the in-progress draft — feed to `buildSelectionOutlineLayer`. */
  shapes: OverlayShape[]
  /** vertices dropped in the current polygon draft (for the "Finish (n)" affordance). */
  polyDraftLength: number
  pointerHandlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  }
  finishPolygon: () => void
  clearSelection: () => void
  /** reset any in-progress draft/drag (call on a tool switch). */
  resetDraft: () => void
  /** the cursor the host should show over the draw overlay for the active tool. */
  cursor: 'move' | 'crosshair'
}

// How long the pointer must settle before the O(N) mask + count is recomputed during a LIVE gesture
// (move-drag / polygon preview). The OUTLINE follows the cursor in realtime (cheap); only the lit set
// + the selected-count trail on this debounce — they don't need to be realtime, and recomputing them
// every pointer move (an O(N) mask rebuild + count) is what makes a drag over millions of points lag.
const RECOMPUTE_DEBOUNCE_MS = 80

export function useAreaSelection({
  positions,
  totalPoints,
  pointIndex,
  unproject,
  tool,
  mode,
  onSelectionChange,
  onCommitOps,
}: UseAreaSelectionOpts): AreaSelectionApi {
  const [selected, setSelected] = useState<Uint8Array>(() => new Uint8Array(totalPoints))
  const [selCount, setSelCount] = useState(0)
  const [selEpoch, setSelEpoch] = useState(0)
  const [committedAreas, setCommittedAreas] = useState<readonly Area[]>([])

  const [rectDraft, setRectDraft] = useState<{ start: Vec2; end: Vec2 } | null>(null)
  const [polyDraft, setPolyDraft] = useState<Vec2[]>([])
  // The live-dragged geometry for the OUTLINE only (updated every move); the expensive mask recompute
  // is debounced separately, so the boundary follows the cursor smoothly while the fill/count settle.
  const [liveDragArea, setLiveDragArea] = useState<{ index: number; area: Area } | null>(null)

  // ── debounced heavy recompute (mask + count) ──────────────────────────────────────────────────
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRecompute = useRef<(() => void) | null>(null)
  const cancelRecompute = useCallback(() => {
    if (recomputeTimer.current) {
      clearTimeout(recomputeTimer.current)
      recomputeTimer.current = null
    }
    pendingRecompute.current = null
  }, [])
  const scheduleRecompute = useCallback((fn: () => void) => {
    pendingRecompute.current = fn
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current)
    recomputeTimer.current = setTimeout(() => {
      recomputeTimer.current = null
      const f = pendingRecompute.current
      pendingRecompute.current = null
      f?.()
    }, RECOMPUTE_DEBOUNCE_MS)
  }, [])
  const flushRecompute = useCallback(() => {
    if (recomputeTimer.current) {
      clearTimeout(recomputeTimer.current)
      recomputeTimer.current = null
    }
    const f = pendingRecompute.current
    pendingRecompute.current = null
    f?.()
  }, [])
  useEffect(() => () => cancelRecompute(), [cancelRecompute])
  // true when the cursor is over a committed area that can be grabbed → the host shows a `move`
  // cursor and a press starts a drag, in ANY tool (hover-to-move — no need to click the Move tool).
  const [hoverMovable, setHoverMovable] = useState(false)

  // in-progress drag-to-move: the grabbed area's geometry at grab time — every move translates a
  // FRESH copy so the drag never accumulates rounding drift.
  const dragRef = useRef<{ index: number; startWorld: Vec2; origArea: Area } | null>(null)
  // true while a live polygon preview drives the display, so we revert to committed on abandon.
  const previewActiveRef = useRef(false)
  // last-known committed area list (controller is the source of truth; this mirrors it for render).
  const controllerAreasRef = useRef<readonly Area[]>([])

  const maskToU8 = useCallback(
    (mask: IndexMask) => {
      const u8 = new Uint8Array(totalPoints)
      for (let i = 0; i < totalPoints; i++) u8[i] = mask.has(i) ? 1 : 0
      return u8
    },
    [totalPoints],
  )

  // The controller is recreated whenever the underlying point cloud changes.
  const controller = useMemo(() => {
    return new SelectionController({
      positions,
      totalPoints,
      onChange: mask => {
        setSelected(maskToU8(mask))
        setSelCount(mask.count())
        setSelEpoch(e => e + 1)
        setCommittedAreas(mask.count() === 0 ? [] : controllerAreasRef.current)
        onSelectionChange?.(mask)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, totalPoints])

  // Push a mask into the display state WITHOUT committing it (the live polygon preview + revert).
  const applyDisplay = useCallback(
    (mask: IndexMask) => {
      setSelected(maskToU8(mask))
      setSelCount(mask.count())
      setSelEpoch(e => e + 1)
      onSelectionChange?.(mask)
    },
    [maskToU8, onSelectionChange],
  )

  // Commit a drawn area — narrow the hit-test to the shape bbox via the spatial index (O(log N + k)).
  const commitArea = useCallback(
    (area: Area) => {
      controller.applyArea(area, positions, totalPoints, commitCandidatesFor(area, pointIndex))
      controllerAreasRef.current = controller.areasList()
      setCommittedAreas(controller.areasList())
      // ITEM-9 — the SINGLE-CANVAS hosts (`SelectableScatter`, `RasterUnderlayScatterView`) emit
      // provenance through the same `areaToOp` mapping the grid uses, so a selection made outside
      // the grid is not silently provenance-less. Optional: a host that does not care omits the
      // sink and nothing changes.
      onCommitOps?.(controller.areasList().map(a => areaToOp(a, SINGLE_CANVAS_PANE, DEFAULT_SELECTION_SPACE)))
    },
    [controller, positions, totalPoints, pointIndex, onCommitOps],
  )

  const clearSelection = useCallback(() => {
    cancelRecompute()
    controller.clear()
    controllerAreasRef.current = []
    setCommittedAreas([])
    setRectDraft(null)
    setPolyDraft([])
    setLiveDragArea(null)
  }, [controller, cancelRecompute])

  const resetDraft = useCallback(() => {
    cancelRecompute()
    setRectDraft(null)
    setPolyDraft([])
    setHoverMovable(false)
    setLiveDragArea(null)
    dragRef.current = null
  }, [cancelRecompute])

  // drag-to-move: replace the entry geometry + recompute (live mask via controller.onChange).
  const moveAreaLive = useCallback(
    (index: number, newArea: Area) => {
      controller.updateArea(index, newArea)
      controllerAreasRef.current = controller.areasList()
      setCommittedAreas(controller.areasList())
    },
    [controller],
  )

  // ── pointer handlers (host wires these to its draw overlay; active only when tool != 'pan') ──
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const p = unproject(e.clientX, e.clientY)
      if (!p) return
      // HOVER-TO-MOVE: pressing on a committed area grabs it to drag — in ANY tool, with no need to
      // switch to the Move tool first. Suppressed only mid-polygon (there a click adds a vertex).
      const midPolyDraft = tool === 'polygon' && polyDraft.length > 0
      if (!midPolyDraft) {
        const areas = controller.areasList()
        const i = hitTestTopmostArea(areas, p)
        if (i >= 0) {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          dragRef.current = { index: i, startWorld: p, origArea: areas[i] }
          return
        }
      }
      if (tool === 'rect') {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setRectDraft({ start: p, end: p })
      } else if (tool === 'polygon') {
        setPolyDraft(prev => [...prev, p])
      }
    },
    [tool, polyDraft.length, unproject, controller],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // An active drag translates the grabbed area — in ANY tool (hover-to-move OR the Move tool).
      // The OUTLINE follows the cursor every move (cheap); the O(N) mask + count recompute is DEBOUNCED
      // (it doesn't need to be realtime, and per-move it's what lags a drag over millions of points).
      if (dragRef.current) {
        const p = unproject(e.clientX, e.clientY)
        if (!p) return
        const d = dragRef.current
        const next = translateArea(d.origArea, p[0] - d.startWorld[0], p[1] - d.startWorld[1])
        setLiveDragArea({ index: d.index, area: next })
        scheduleRecompute(() => moveAreaLive(d.index, next))
        return
      }
      if (tool === 'rect' && rectDraft) {
        const p = unproject(e.clientX, e.clientY)
        if (p) setRectDraft(d => (d ? { ...d, end: p } : d))
        return
      }
      // Not dragging/drawing: reflect whether the cursor is over a grabbable committed area, so the
      // host can show the `move` cursor (the affordance that a drag will move it, no Move tool needed).
      const p = unproject(e.clientX, e.clientY)
      const midPolyDraft = tool === 'polygon' && polyDraft.length > 0
      const over = !!p && !midPolyDraft && hitTestTopmostArea(controller.areasList(), p) >= 0
      setHoverMovable(prev => (prev === over ? prev : over))
    },
    [tool, rectDraft, polyDraft.length, unproject, controller, moveAreaLive, scheduleRecompute],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // End a drag-move (any tool) FIRST — so a grab in rect mode ends cleanly without committing a rect.
      if (dragRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        dragRef.current = null
        flushRecompute() // settle the mask + count to the FINAL dragged position immediately
        setLiveDragArea(null)
        return
      }
      if (tool === 'rect' && rectDraft) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        const { start, end } = rectDraft
        setRectDraft(null)
        if (Math.abs(start[0] - end[0]) < 1e-6 && Math.abs(start[1] - end[1]) < 1e-6) return
        commitArea({ kind: 'rect', box: [start[0], start[1], end[0], end[1]], mode })
        return
      }
    },
    [tool, rectDraft, mode, commitArea, flushRecompute],
  )

  // Polygon preview — the OUTLINE updates as vertices drop (via `polyDraft` → `shapes`); the lit set +
  // count are DEBOUNCED (they don't need to be realtime, and each recompute is an O(N) mask rebuild).
  useEffect(() => {
    if (tool === 'polygon' && polyDraft.length >= 3) {
      scheduleRecompute(() =>
        applyDisplay(previewMask(controller.selection, polyDraft, mode, positions, totalPoints, pointIndex)),
      )
      previewActiveRef.current = true
    } else if (previewActiveRef.current) {
      previewActiveRef.current = false
      cancelRecompute()
      applyDisplay(controller.selection)
    }
  }, [tool, polyDraft, mode, positions, totalPoints, pointIndex, controller, applyDisplay, scheduleRecompute, cancelRecompute])

  const finishPolygon = useCallback(() => {
    cancelRecompute() // drop any pending preview so it can't overwrite the commit
    if (polyDraft.length >= 3) {
      commitArea({ kind: 'polygon', polygon: polyDraft.map(v => [v[0], v[1]] as Vec2), mode })
    }
    setPolyDraft([])
  }, [polyDraft, mode, commitArea, cancelRecompute])

  // The outline reflects the live-dragged geometry immediately (mask/count trail on the debounce).
  const displayAreas = useMemo(() => {
    if (!liveDragArea) return committedAreas
    return committedAreas.map((a, i) => (i === liveDragArea.index ? liveDragArea.area : a))
  }, [committedAreas, liveDragArea])

  const shapes = useMemo(
    () => selectionShapes(displayAreas, rectDraft, polyDraft),
    [displayAreas, rectDraft, polyDraft],
  )

  return {
    selected,
    selCount,
    selEpoch,
    shapes,
    polyDraftLength: polyDraft.length,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp },
    finishPolygon,
    clearSelection,
    resetDraft,
    cursor: hoverMovable || tool === 'move' ? 'move' : 'crosshair',
  }
}

// ── the shared deck outline layer (used by the hook's hosts AND GridWorkspace) ──────────────────
// Committed areas (`role:'area'`, PERSIST after finish) + the in-progress draft (`role:'draft'`),
// styled by the single shared `outlineStyle`. `id` lets a host (the grid) prefix it with a cell id
// so `makeLayerFilter` scopes it to that cell's viewport.
export function buildSelectionOutlineLayer(
  shapes: OverlayShape[],
  id = 'sel-shapes',
): PolygonLayer<OverlayShape> | null {
  if (shapes.length === 0) return null
  return new PolygonLayer<OverlayShape>({
    id,
    data: shapes,
    getPolygon: (d: OverlayShape) => d.polygon,
    stroked: true,
    filled: true,
    getFillColor: (d: OverlayShape) => outlineStyle(d.role).fillColor as [number, number, number, number],
    getLineColor: (d: OverlayShape) => outlineStyle(d.role).lineColor as [number, number, number, number],
    getLineWidth: (d: OverlayShape) => outlineStyle(d.role).lineWidth,
    lineWidthUnits: 'pixels',
    pickable: false,
    updateTriggers: { getPolygon: [shapes], getLineColor: [shapes], getFillColor: [shapes] },
  })
}

// Re-export the pure builder for tests / hosts that want just the shapes.
export { selectionShapes }
