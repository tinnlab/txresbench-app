// GridOverlayLayer.tsx — SPLIT B (ITEM-16, DEC-18 / DEC-20).
//
// THE POINTER-DRIVEN CHROME LIVES HERE: the selection draw overlay, the per-open-pane annotation
// draw overlays, the cross-window drop outline, the aim-to-place banner, the keyboard-focus outline,
// and the main hover tooltip — together with the four transient states that drive them
// (`rectDraft`, `polyDraft`, `selHoverMove`, `hovered`) and the pointer/wheel handlers that write them.
//
// ── Why this is a split at all (it is NOT the camera's problem) ───────────────────────────────────
// Split A took the camera out of the shell, so a WHEEL no longer re-renders it. But four states left
// behind re-rendered the whole 6,000-line closure on gestures the camera never touches:
//   * `rectDraft`   — written on EVERY pointermove of a marquee drag,
//   * `hovered`     — written once per rAF while the cursor sweeps a dense scatter,
//   * `selHoverMove`— written on every hover transition over a committed area,
//   * `polyDraft`   — written per lasso vertex.
// Each of those is a per-gesture (`rectDraft`/`hovered`: per-FRAME) update whose only consumers are
// the overlays in this file. Owning them here means a marquee drag and a hover sweep re-render this
// component and nothing else. That is the same structural claim Split A makes for the camera, on the
// other half of the interaction surface.
//
// ── What crosses the boundary, and in which direction ────────────────────────────────────────────
// DOWN, as explicit props: the gate flags (`drawActive`/`annotateActive`/`isPlacing`/…), the geometry
// (`denseRects`/`plotInset`/`focusedRect`), the SHELL-owned selection commit path (`commitRect`/
// `commitPolygon`/`publishCellAreas`/`setCommittedByCell`) and the annotate editor handle. None of
// these changes per frame; they change when the shell re-renders for its own reasons, which is
// unchanged behaviour.
//
// UP, through REF handles — never as a context value (DEC-20), and never as a per-frame reactive
// callback that would defeat the split:
//   * `apiRef.current`       — `{ clearDrafts, finishPolygon }`. The shell has FOUR sites that must
//                              drop an in-progress draft (leaving Select, the rail's shape switch,
//                              `clearGridSelection`, and the rail's Finish button) and they can no
//                              longer reach `setRectDraft`/`setPolyDraft` directly.
//   * `deckHoverRef.current` — the deck's `onHover` sink. `<GridDeckLayer>` is this component's
//                              SIBLING, so the handler cannot be handed across directly; the shell
//                              passes deck a STABLE wrapper that forwards through this ref, which
//                              also preserves `GridDeckLayer`'s `memo`.
//
// UP, as reactive callbacks — deliberately narrow, and only for values a sibling genuinely needs:
//   * `onPolyDraftCountChange(n)` — the tool rail renders Finish-enabled from the vertex COUNT.
//                              Fires per vertex CLICK, never per frame.
//   * `onHoverPublish(hoveredCellId, highlight)` — see below.
//
// ── Why the CROSS-PLOT HIGHLIGHT effect moved here too (not in ITEM-16's plan list) ──────────────
// `hovered` alone cannot leave the shell: the shell derives the cross-plot highlight map from it
// (`hoverHighlightLayers` → deck; `HoverHighlightContext` → chart cells) and `<GridDeckLayer>` needs
// the hovered cell id to suppress the duplicate cross tooltip. Publishing raw `hovered` upward would
// therefore have bought NOTHING — the shell would still re-render once per hover frame, plus a hop.
// So the derivation moved with the state and the shell receives only its RESULT, guarded:
//   * cursor jitter within one point (a new `hovered` object, the SAME highlight) → the shell is not
//     re-rendered at all, where before it re-rendered once per frame;
//   * a genuine point change → ONE shell render, where before it took two (`setHovered`, then the
//     effect's `setCrossHighlight`).
// The `sameHighlight` equality guard stays on the SHELL's setter, so the published map's identity
// semantics are byte-identical to the pre-split effect.
//
// ── What did NOT move, against ITEM-16's written list (re-derivation, 2026-07-29) ────────────────
//   * `crossTooltips` + its `<VizTooltip>`s — ALREADY MOVED to `GridDeckLayer` by Split A (DRIFT-10).
//     ITEM-16 says it "reunites them" with the main tooltip. It must NOT: `crossTooltips` PROJECTS
//     each highlighted point through that cell's LIVE camera, so it recomputes per frame. Pulling it
//     here would drag `controlledViewState` into this component and re-create, one level down, the
//     exact defect Split A removed. They stay apart; the paint-order delta DRIFT-10 recorded stands.
//   * `tooltipFields` — a memo over `tooltipContext`/`tooltipLabels`, not a per-frame value, and
//     `GridDeckLayer` (a SIBLING) consumes it. Moving it here would force a second reactive up-flow
//     for zero benefit. It stays in the shell and crosses DOWN as a prop to both children.
//   * `selTool` / `selSpaceHeld` / `committedByCell` — the shell's tool rail and its selection
//     publication path own these; they are not draft state. DRIFT-9's criterion applies: "named in
//     the move list" is not the test, "written per gesture and read only by this layer" is.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { cellAtPoint, unprojectInCell, type ScreenPoint } from './gridSelection'
import { hitTestTopmostArea, translateArea, type Vec2 } from '../selection/areaGestures'
import type { Area } from '../selection/SelectionController'
import { bumpZoom, panTarget, zoomToCursorTarget } from '../selection/useSelectionCamera'
import { MIN_ZOOM, MAX_ZOOM, type GridViewState } from './linkZoom'
import { routeGridHover, type PaneRect } from '../layers/multiView'
import { SCATTER_LAYER_NAME, datasetAxisLabels, paneTestId, type GridCell } from './gridModel'
import { VizTooltip } from '../tooltip/VizTooltip'
import {
  buildScatterTooltipFields,
  resolveTooltip,
  type TooltipCatalogLabels,
  type TooltipContext,
  type TooltipField,
} from '../tooltip/tooltipModel'
import type { AnnotateEditorApi } from '../annotate/useAnnotateEditor'
import type { SelTool } from '../controls/VizToolRail'
import type { ChartContribution } from './chartLayerSink'
import type { DatasetEntry } from '../../adapter/DatasetStore'
import { useGridWorkspaceSeam, type CellDataResolved } from './GridWorkspaceContext'

/** A dense-scatter hover: the picked row + its SCREEN position + the cell it belongs to. */
export interface GridHover {
  index: number
  x: number
  y: number
  cellId: string
}

// SPLIT S (ITEM-35): `DeckHoverInfo` moved to the neutral `gridModel.ts` — `useGridHover` types its
// sink with it and a hook may not import a layer (INV-10 (d)). Re-exported so existing importers are
// unaffected; same move, same reason, as `GridOverlayApi` at Split I. See DRIFT-58.
export type { DeckHoverInfo } from './gridModel'

/** The imperative handle this layer publishes UPWARD (filled during render, like Split A's camera
 *  handles). Every member is idempotent, so a caller may invoke it from a state updater that
 *  StrictMode double-invokes — which is exactly what `setActiveTool` does. */
// SPLIT I (ITEM-25): `GridOverlayApi` moved to the neutral `gridModel.ts`. The selection plane
// holds the ref this handle fills, and a hook importing a LAYER is exactly the back door INV-10 (d)
// forbids — so the shared TYPE lives in the module both already import. Re-exported here so every
// existing importer of this layer is unchanged.
export type { GridOverlayApi } from './gridModel'
import type { GridOverlayApi, DeckHoverInfo } from './gridModel'

export interface GridOverlayLayerProps {
  // ── selection draw overlay ─────────────────────────────────────────────────────────────────────
  /** Select tool active over ≥1 dense pane. Gates the whole-workspace draw sheet. */
  readonly drawActive: boolean
  readonly selTool: SelTool
  /** SPACE held ⇒ the draw sheet pans instead of drawing (and shows a `grab` cursor). */
  readonly selSpaceHeld: boolean
  /** Client → container-local coordinates. `useCallback([])` in the shell, so stable. */
  readonly toLocal: (e: { clientX: number; clientY: number }) => ScreenPoint
  /** The SHELL's selection commit path — it owns `committedByCell` and the coordination publish. */
  readonly commitRect: (start: ScreenPoint, end: ScreenPoint, cellId: string) => void
  readonly commitPolygon: (ring: ScreenPoint[], cellId: string) => void
  readonly publishCellAreas: (cellId: string, areas: Area[]) => void
  readonly setCommittedByCell: React.Dispatch<React.SetStateAction<Record<string, Area[]>>>
  /** The tool rail renders "Finish" from the vertex count. Fires per vertex CLICK, not per frame. */
  readonly onPolyDraftCountChange: (n: number) => void

  // ── annotation draw overlays (ONE PER OPEN PANE — INV-8) ───────────────────────────────────────
  readonly annotateActive: boolean
  // SPLIT D (ITEM-15): `annotateOpenIds` is no longer a prop. The set moved into the per-workspace
  // `paneDocks` store (`PaneDocks.store.ts`), because it is read by FOUR surfaces — this layer, the
  // pane chrome, the dock layer and the shell's `annotateMode` — and no layer may import another's
  // private module (INV-10 (d)). This layer subscribes to the set for its per-open-pane overlay loop
  // and reads it out of `getState()` for the pointer-down intent gate, which is strictly fresher
  // than the render-mirrored `annotateOpenIdsRef` it replaces.
  /** The pane the in-flight annotate gesture is bound to (written synchronously on press). */
  readonly gestureAnnotateCellRef: React.RefObject<string | null>
  readonly setBoundAnnotateCellId: (id: string | null) => void
  readonly annotateEditor: AnnotateEditorApi
  readonly denseRects: readonly PaneRect[]
  readonly plotInset: (r: PaneRect) => PaneRect

  // ── chrome overlays ────────────────────────────────────────────────────────────────────────────
  readonly containerId: string
  readonly isBodyDropTarget: boolean
  readonly isPlacing: boolean
  readonly focusedRect: PaneRect | null
  readonly effFocusedId: string | null

  // ── hover + tooltip ────────────────────────────────────────────────────────────────────────────
  readonly tooltipsEnabled: boolean
  /** The WORKSPACE tooltip fields. Stays in the shell (a sibling consumes it) — see the header. */
  readonly tooltipFields: TooltipField[] | null
  readonly cells: readonly GridCell[]
  readonly cellMap: Record<string, GridCell>
  readonly cellData: (cell: GridCell) => CellDataResolved
  readonly datasetTooltips?: Readonly<Record<string, TooltipContext>>
  readonly datasetTooltipLabels?: Readonly<Record<string, TooltipCatalogLabels>>
  readonly datasetEntries: Readonly<Record<string, DatasetEntry>>
  /** A chart cell's raw-dot hover, published by the chart/data-table surfaces. Feeds the SAME
   *  cross-plot highlight derivation as a dense scatter hover. */
  readonly chartHover: { cellId: string; index: number } | null
  readonly chartDeckIds: ReadonlySet<string>
  readonly chartDeckRects: readonly PaneRect[]
  readonly chartContribs: ReadonlyMap<string, ChartContribution>
  /** The ONE reactive up-flow of the hover path: the derived cross-plot highlight + the hovered cell
   *  id. The shell applies its own `sameHighlight` guard, so jitter within a point publishes nothing. */
  readonly onHoverPublish: (hoveredCellId: string | null, highlight: Record<string, number>) => void

  // ── the upward handles ─────────────────────────────────────────────────────────────────────────
  readonly deckHoverRef: React.RefObject<((info: DeckHoverInfo) => void) | null>
  readonly apiRef: React.RefObject<GridOverlayApi | null>
}

function GridOverlayLayerImpl({
  drawActive,
  selTool,
  selSpaceHeld,
  toLocal,
  commitRect,
  commitPolygon,
  publishCellAreas,
  setCommittedByCell,
  onPolyDraftCountChange,
  annotateActive,
  gestureAnnotateCellRef,
  setBoundAnnotateCellId,
  annotateEditor,
  denseRects,
  plotInset,
  containerId,
  isBodyDropTarget,
  isPlacing,
  focusedRect,
  effFocusedId,
  tooltipsEnabled,
  tooltipFields,
  cells,
  cellMap,
  cellData,
  datasetTooltips,
  datasetTooltipLabels,
  datasetEntries,
  chartHover,
  chartDeckIds,
  chartDeckRects,
  chartContribs,
  onHoverPublish,
  deckHoverRef,
  apiRef,
}: GridOverlayLayerProps) {
  const {
    coordinationRef,
    denseRectsRef,
    viewStateRef,
    onViewStateChangeRef,
    committedByCellRef,
    selMultiRef,
    activeCellRef,
    polySlotRef,
    dragRef,
    paneDocks,
  } = useGridWorkspaceSeam()

  // SPLIT D (ITEM-15): the per-open-pane annotation draw overlays are keyed off this set. Subscribed
  // rather than prop-drilled so the shell is not re-rendered when a SECOND annotate dock opens.
  const annotateOpenIds = useStore(paneDocks, s => s.annotateOpenIds)

  // ── the draft state (was `GridWorkspace`'s, and re-rendered it on every pointermove) ────────────
  const [rectDraft, setRectDraft] = useState<{ start: ScreenPoint; end: ScreenPoint } | null>(null)
  const [polyDraft, setPolyDraft] = useState<ScreenPoint[]>([])
  // true while the cursor hovers a grabbable committed area → the overlay shows a `move` cursor and
  // a press grabs it, in ANY tool (hover-to-move — no need to select the Move tool first).
  const [selHoverMove, setSelHoverMove] = useState(false)
  // in-progress SPACE/middle pan on the draw sheet.
  const selPanRef = useRef<{ cell: string; startLocal: ScreenPoint; startTarget: Vec2; vs0: GridViewState } | null>(
    null,
  )

  // The tool rail's Finish affordance reads the vertex COUNT, so it is the one draft value a sibling
  // needs. Published from an effect (never during render) so the shell's setState is a commit-phase
  // update, and only on a real change.
  useEffect(() => {
    onPolyDraftCountChange(polyDraft.length)
  }, [polyDraft.length, onPolyDraftCountChange])

  /** If the cursor is inside one of a cell's committed areas, return that cell + the topmost area's
   *  INDEX + world grab point (so a drag translates that one region). */
  const grabCommittedAt = useCallback(
    (p: ScreenPoint): { cell: string; world: Vec2; area: Area; index: number } | null => {
      const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
      if (!cell) return null
      const rect = denseRectsRef.current.find(r => r.id === cell)
      const vs = viewStateRef.current[cell]
      const areas = committedByCellRef.current[cell]
      if (!rect || !vs || !areas || areas.length === 0) return null
      const w = unprojectInCell(rect, vs, p[0], p[1])
      if (!w) return null
      const idx = hitTestTopmostArea(areas, [w[0], w[1]])
      if (idx >= 0) return { cell, world: [w[0], w[1]], area: areas[idx], index: idx }
      return null
    },
    [denseRectsRef, viewStateRef, committedByCellRef],
  )

  const onDrawPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = toLocal(e)
      // PAN gesture (MIDDLE, or SPACE + left) → drive the under-cursor cell's camera; not a draw.
      if (e.button === 1 || (e.button === 0 && selSpaceHeld)) {
        const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
        const vs = cell ? viewStateRef.current[cell] : undefined
        if (cell && vs) {
          e.currentTarget.setPointerCapture(e.pointerId)
          selPanRef.current = { cell, startLocal: p, startTarget: [vs.target[0], vs.target[1]], vs0: vs }
        }
        return
      }
      // HOVER-TO-MOVE: a press on a cell's committed area grabs it to drag — in ANY tool (no need
      // for the Move tool), except mid-polygon (there a click adds a vertex).
      const midPolyDraft = selTool === 'polygon' && polyDraft.length > 0
      if (!midPolyDraft) {
        const grab = grabCommittedAt(p)
        if (grab) {
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { cell: grab.cell, index: grab.index, startWorld: grab.world, origArea: grab.area }
          return
        }
      }
      const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
      if (!cell) return
      if (selTool === 'rect') {
        e.currentTarget.setPointerCapture(e.pointerId)
        activeCellRef.current = cell
        setRectDraft({ start: p, end: p })
      } else if (selTool === 'polygon') {
        // Polygon: the FIRST vertex fixes the cell; later clicks in another cell are ignored.
        if (polyDraft.length === 0) activeCellRef.current = cell
        else if (activeCellRef.current && cell !== activeCellRef.current) return
        const next = [...polyDraft, p]
        setPolyDraft(next)
        // AUTO-UPDATE the selection LIVE as vertices are added — no need to click Finish. Once the ring
        // is valid (≥3 vertices) each new vertex re-commits; Finish just clears the in-progress outline.
        if (next.length >= 3 && activeCellRef.current) commitPolygon(next, activeCellRef.current)
      }
    },
    [
      selTool,
      polyDraft,
      toLocal,
      grabCommittedAt,
      selSpaceHeld,
      commitPolygon,
      denseRectsRef,
      viewStateRef,
      activeCellRef,
      dragRef,
    ],
  )

  const onDrawPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // An active PAN drives the grabbed cell's camera (link-zoom aware via onViewStateChange).
      const span = selPanRef.current
      if (span) {
        const rect = denseRectsRef.current.find(r => r.id === span.cell)
        if (!rect) return
        const p = toLocal(e)
        const w0 = unprojectInCell(rect, span.vs0, span.startLocal[0], span.startLocal[1])
        const wN = unprojectInCell(rect, span.vs0, p[0], p[1])
        if (w0 && wN) {
          const nt = panTarget(span.startTarget, w0, wN)
          onViewStateChangeRef.current({ viewId: span.cell, viewState: { ...span.vs0, target: [nt[0], nt[1], 0] } })
        }
        return
      }
      // An active drag translates the grabbed area — in ANY tool (hover-to-move OR the Move tool).
      if (dragRef.current) {
        const d = dragRef.current
        const rect = denseRectsRef.current.find(r => r.id === d.cell)
        const vs = viewStateRef.current[d.cell]
        if (!rect || !vs) return
        const p = toLocal(e)
        const w = unprojectInCell(rect, vs, p[0], p[1])
        if (!w) return
        const moved = translateArea(d.origArea, w[0] - d.startWorld[0], w[1] - d.startWorld[1])
        // Translate ONLY the grabbed region (by index), then re-publish the cell's UNION.
        const arr = (committedByCellRef.current[d.cell] ?? []).slice()
        arr[d.index] = moved
        setCommittedByCell(prev => ({ ...prev, [d.cell]: arr }))
        publishCellAreas(d.cell, arr)
        return
      }
      if (selTool === 'rect' && rectDraft) {
        const p = toLocal(e)
        setRectDraft(d => (d ? { ...d, end: p } : d))
        return
      }
      // Not dragging/drawing: reflect whether the cursor is over a grabbable committed area (move cursor).
      const midPolyDraft = selTool === 'polygon' && polyDraft.length > 0
      const over = !midPolyDraft && grabCommittedAt(toLocal(e)) != null
      setSelHoverMove(prev => (prev === over ? prev : over))
    },
    [
      selTool,
      rectDraft,
      polyDraft.length,
      toLocal,
      publishCellAreas,
      grabCommittedAt,
      setCommittedByCell,
      denseRectsRef,
      viewStateRef,
      committedByCellRef,
      onViewStateChangeRef,
      dragRef,
    ],
  )

  const onDrawPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // End a PAN first.
      if (selPanRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        selPanRef.current = null
        return
      }
      // End a drag-move (any tool) FIRST — so a grab in rect mode ends cleanly without committing a rect.
      if (dragRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        const d = dragRef.current
        dragRef.current = null
        // DRAG-OUT-TO-REMOVE: releasing a dragged region OUTSIDE its plot's border deletes it (the
        // multi-region remove affordance). The region followed the cursor during the drag, so the
        // release point being outside the cell rect means the user dropped it off-plot.
        const rect = denseRectsRef.current.find(r => r.id === d.cell)
        const p = toLocal(e)
        const outside = !!rect && (p[0] < rect.x || p[0] > rect.x + rect.width || p[1] < rect.y || p[1] > rect.y + rect.height)
        if (outside) {
          const arr = (committedByCellRef.current[d.cell] ?? []).slice()
          arr.splice(d.index, 1)
          setCommittedByCell(prev => ({ ...prev, [d.cell]: arr }))
          publishCellAreas(d.cell, arr)
        }
        return
      }
      if (selTool !== 'rect' || !rectDraft) return
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      const { start } = rectDraft
      const end = toLocal(e)
      const cell = activeCellRef.current
      setRectDraft(null)
      activeCellRef.current = null
      if (!cell) return
      // Contract row 13: a degenerate CLICK (no drag). A press ON a committed region was already
      // handled as a grab above, so this click is on EMPTY space. In SINGLE mode ⇒ clear the whole
      // selection (click empty space to deselect); the coordination clear bumps the exclusive epoch so
      // every producer (incl. the violin) drops its outline too. In MULTI mode a stray click does nothing.
      if (Math.abs(start[0] - end[0]) < 2 && Math.abs(start[1] - end[1]) < 2) {
        if (!selMultiRef.current) {
          setCommittedByCell({})
          coordinationRef.current.clearSelection()
        }
        return
      }
      commitRect(start, end, cell)
    },
    [
      selTool,
      rectDraft,
      toLocal,
      commitRect,
      publishCellAreas,
      setCommittedByCell,
      denseRectsRef,
      committedByCellRef,
      selMultiRef,
      coordinationRef,
      activeCellRef,
      dragRef,
    ],
  )

  // WHEEL over a cell while a selection tool is active → zoom-to-cursor that cell (link-zoom aware).
  // Loose event shape so the NON-passive native listener (`wheelRefFor` below) can drive it — a
  // React JSX `onWheel` is passive, so its preventDefault() no-ops + warns.
  const onDrawWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; preventDefault(): void }) => {
      e.preventDefault()
      const p = toLocal(e)
      const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
      if (!cell) return
      const rect = denseRectsRef.current.find(r => r.id === cell)
      const vs = viewStateRef.current[cell]
      if (!rect || !vs) return
      const w0 = unprojectInCell(rect, vs, p[0], p[1])
      if (!w0) return
      const nz = bumpZoom(vs.zoom, e.deltaY, 0.01, MIN_ZOOM, MAX_ZOOM) as number
      const w1 = unprojectInCell(rect, { ...vs, zoom: nz }, p[0], p[1])
      if (!w1) return
      const nt = zoomToCursorTarget([vs.target[0], vs.target[1]], w0, w1)
      onViewStateChangeRef.current({ viewId: cell, viewState: { target: [nt[0], nt[1], 0], zoom: nz } })
    },
    [toLocal, denseRectsRef, viewStateRef, onViewStateChangeRef],
  )

  // Attach `onDrawWheel` as a NON-passive native `wheel` listener via a callback ref (React's JSX
  // `onWheel` is passive → preventDefault warns + can't stop ancestor scroll). Latest-ref avoids
  // re-binding each render; detaches on unmount / overlay teardown.
  //
  // CONVERGENCE H2 — this MUST be one binding PER OVERLAY, keyed. A single shared callback ref with
  // ONE detach slot was correct only while there was exactly one `inset:0` sheet. The per-pane
  // overlay fix multiplied the ELEMENT without multiplying the REF: each mount tore down the
  // PREVIOUS element's listener, so with N docks open only the last-mounted pane zoomed — and
  // unmounting that one detached without re-attaching to the survivors, because React never
  // re-invokes a STABLE callback ref for an already-mounted node. Each overlay now owns its own
  // listener and its own detacher, under its own key.
  const selWheelLatest = useRef(onDrawWheel)
  selWheelLatest.current = onDrawWheel
  const wheelDetachers = useRef(new Map<string, () => void>())
  const wheelRefCache = useRef(new Map<string, (el: HTMLDivElement | null) => void>())
  /** A callback ref bound to ONE overlay key. Memoized per key so its identity is stable across
   *  renders (an unstable ref would detach + re-attach on every render). */
  const wheelRefFor = useCallback((key: string) => {
    const cached = wheelRefCache.current.get(key)
    if (cached) return cached
    const cb = (el: HTMLDivElement | null) => {
      const prev = wheelDetachers.current.get(key)
      if (prev) {
        prev()
        wheelDetachers.current.delete(key)
      }
      if (!el) return
      const h = (e: WheelEvent) => selWheelLatest.current(e)
      el.addEventListener('wheel', h, { passive: false })
      wheelDetachers.current.set(key, () => el.removeEventListener('wheel', h))
    }
    wheelRefCache.current.set(key, cb)
    return cb
  }, [])
  // Layer teardown: release every surviving binding. A per-key ref is only invoked with `null`
  // when ITS OWN node unmounts, which does not happen when the whole tree goes at once.
  useEffect(() => {
    const detachers = wheelDetachers.current
    return () => {
      for (const d of detachers.values()) d()
      detachers.clear()
    }
  }, [])

  // ── Annotate overlay pointer routing (mirrors the selection overlay) ────────
  // One overlay per pane whose annotate dock is OPEN. LEFT drag → the editor (draw / reshape /
  // brush); MIDDLE or SPACE+LEFT → pan the under-cursor cell (camera math reused); wheel → zoom (via
  // `wheelRefFor(key)` — ONE keyed binding per overlay).
  const annotatePanRef = useRef<{ cell: string; startLocal: ScreenPoint; startTarget: Vec2; vs0: GridViewState } | null>(
    null,
  )
  const onAnnotatePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = toLocal(e)
      // PAN (middle, or space+left) → under-cursor cell's camera; not a draw.
      if (e.button === 1 || (e.button === 0 && selSpaceHeld)) {
        const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
        const vs = cell ? viewStateRef.current[cell] : undefined
        if (cell && vs) {
          e.currentTarget.setPointerCapture(e.pointerId)
          annotatePanRef.current = { cell, startLocal: p, startTarget: [vs.target[0], vs.target[1]], vs0: vs }
        }
        return
      }
      // Draw (ITEM-10 / INV-13): the press binds to the pane UNDER THE CURSOR and draws on that SAME
      // press. There is no "active pane" concept left to mediate this.
      const cell = cellAtPoint(denseRectsRef.current, p[0], p[1])
      // BLIND-AUDIT H3 (INV-13) — gate on USER INTENT, not capability: authoring REQUIRES that pane's
      // dock to be open. The per-pane overlay geometry below enforces the same rule spatially, and
      // this check is the defensive twin of it.
      if (!cell || !paneDocks.getState().annotateOpenIds.has(cell)) return
      if (cell !== gestureAnnotateCellRef.current) {
        // Re-binding to a DIFFERENT pane: drop any in-progress draft first, so a half-drawn polygon
        // (in the OLD pane's coords) can't be adopted or Finished into the new pane. `resetDraft`
        // clears the draft REF synchronously (H1), so the delegated handler below cannot see it.
        annotateEditor.resetDraft()
        // SYNCHRONOUS bind — `resolveStore`/`annotateUnproject` both read this ref, so the delegated
        // handler below already sees the pressed pane. The state mirror is for the cursor subscription.
        gestureAnnotateCellRef.current = cell
        setBoundAnnotateCellId(cell)
      }
      annotateEditor.pointerHandlers.onPointerDown(e)
    },
    [
      toLocal,
      selSpaceHeld,
      annotateEditor,
      denseRectsRef,
      viewStateRef,
      paneDocks,
      gestureAnnotateCellRef,
      setBoundAnnotateCellId,
    ],
  )
  const onAnnotatePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const span = annotatePanRef.current
      if (span) {
        const rect = denseRectsRef.current.find(r => r.id === span.cell)
        if (!rect) return
        const p = toLocal(e)
        const w0 = unprojectInCell(rect, span.vs0, span.startLocal[0], span.startLocal[1])
        const wN = unprojectInCell(rect, span.vs0, p[0], p[1])
        if (w0 && wN) {
          const nt = panTarget(span.startTarget, w0, wN)
          onViewStateChangeRef.current({ viewId: span.cell, viewState: { ...span.vs0, target: [nt[0], nt[1], 0] } })
        }
        return
      }
      annotateEditor.pointerHandlers.onPointerMove(e)
    },
    [toLocal, annotateEditor, denseRectsRef, onViewStateChangeRef],
  )
  const onAnnotatePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (annotatePanRef.current) {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        annotatePanRef.current = null
        return
      }
      annotateEditor.pointerHandlers.onPointerUp(e)
    },
    [annotateEditor],
  )

  // ── polygon lifecycle ──────────────────────────────────────────────────────────────────────────
  const finishPolygon = useCallback(() => {
    // The polygon is already committed LIVE as vertices were added (#4); Finish just closes the
    // in-progress ring so the NEXT polygon starts a fresh region.
    polySlotRef.current = null
    setPolyDraft([])
    activeCellRef.current = null
  }, [polySlotRef, activeCellRef])

  // CANCEL (Esc) the in-progress polygon: drop the auto-committed slot + its published contribution,
  // then reset the draft. The already-FINISHED regions are untouched.
  const cancelPolygon = useCallback(() => {
    const cell = activeCellRef.current
    const slot = polySlotRef.current
    if (cell != null && slot != null) {
      const remaining = (committedByCellRef.current[cell] ?? []).slice()
      remaining.splice(slot, 1)
      setCommittedByCell(prev => ({ ...prev, [cell]: remaining }))
      publishCellAreas(cell, remaining)
    }
    polySlotRef.current = null
    setPolyDraft([])
    activeCellRef.current = null
  }, [publishCellAreas, setCommittedByCell, committedByCellRef, polySlotRef, activeCellRef])

  // Keyboard finish/cancel for the polygon LASSO (all plot types share this idiom): Enter closes the
  // ring, Esc discards the in-progress lasso. Active only while a polygon draft is under way.
  useEffect(() => {
    if (selTool !== 'polygon' || polyDraft.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finishPolygon()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelPolygon()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selTool, polyDraft.length, finishPolygon, cancelPolygon])

  /** Drop any in-progress draft + its gesture bookkeeping. The SHELL's four reset sites reach this
   *  through `apiRef`; it is deliberately idempotent because `setActiveTool` calls it from inside a
   *  state updater that StrictMode double-invokes. */
  const clearDrafts = useCallback(() => {
    setRectDraft(null)
    setPolyDraft([])
    polySlotRef.current = null
    dragRef.current = null
    activeCellRef.current = null
  }, [polySlotRef, dragRef, activeCellRef])

  // THE UPWARD HANDLE. Assigned during render (Split A's idiom for `viewStateRef`): the shell's reset
  // sites are event/updater-time callers, so they always observe this commit's closure.
  const api = useMemo<GridOverlayApi>(() => ({ clearDrafts, finishPolygon }), [clearDrafts, finishPolygon])
  apiRef.current = api

  // ── Hover tooltip (ITEM-5) ────────────────────────────────────────────────
  // deck's `onHover` hands us a picked point INDEX + the picked layer; a base scatter
  // layer id ends `::scatter`. The tooltip DATA read is O(1) (index into the resident
  // columns in `tooltipContext`); we only rAF-throttle the React setState (mirrors
  // DeckScatterCanvas) so rapid mouse moves coalesce to one update per frame. NO fetch.
  const [hovered, setHovered] = useState<GridHover | null>(null)
  const hoverRaf = useRef<number | null>(null)
  const hoverPending = useRef<GridHover | null>(null)
  const flushHover = useCallback(() => {
    hoverRaf.current = null
    setHovered(hoverPending.current)
  }, [])
  // CROSS-PLOT hover-highlight: mirror the hovered point's ROW into every cell that shares its IDENTITY
  // SPACE — never across the isolated-dataset boundary. Two rules: (a) both cells canonical (have
  // `pointIds`) → match the hovered point's canonical id via an O(1) cached id→row map (NEVER a per-frame
  // O(N) scan, and NEVER a raw index vs. an unrelated dataset's ids); (b) both DEFAULT (no `datasetId`, no
  // `pointIds`) → the same row index. An isolated dataset (a `datasetId` with no `pointIds`) cross-links to
  // nothing. Rings on dense cells + chart emphasis via `HoverHighlightContext`.
  //
  // MOVED HERE BY SPLIT B (see the header): the derivation follows `hovered`, and only its RESULT
  // crosses back up. The `sameHighlight` guard lives on the shell's setter, so a hover that does not
  // change the highlight map re-renders nothing above this component.
  const idRowCacheRef = useRef(new WeakMap<Uint32Array, Map<number, number>>())
  useEffect(() => {
    const hp = hovered ?? chartHover // dense scatter OR chart raw-dot hover — same {cellId, index} shape.
    const srcCell = hp ? cellMap[hp.cellId] : undefined
    // No hover, or the source cell was removed/type-swapped while a hover was latched → clear.
    if (!hp || !srcCell) {
      onHoverPublish(hovered?.cellId ?? null, {})
      return
    }
    const srcData = cellData(srcCell)
    const srcHasIds = !!srcData.pointIds
    const srcCanonId = srcHasIds ? srcData.pointIds![hp.index] : null
    const idRow = (ids: Uint32Array): Map<number, number> => {
      let m = idRowCacheRef.current.get(ids)
      if (!m) {
        m = new Map()
        for (let i = 0; i < ids.length; i++) if (!m.has(ids[i])) m.set(ids[i], i)
        idRowCacheRef.current.set(ids, m)
      }
      return m
    }
    const next: Record<string, number> = {}
    for (const cell of cells) {
      if (cell.id === hp.cellId) {
        next[cell.id] = hp.index
        continue
      }
      const cd = cellData(cell)
      if (cd.nPoints === 0) continue
      if (srcHasIds && cd.pointIds) {
        const row = idRow(cd.pointIds).get(srcCanonId!)
        if (row != null) next[cell.id] = row
      } else if (!srcHasIds && !cd.pointIds && !cell.datasetId && !srcCell.datasetId && hp.index < cd.nPoints) {
        next[cell.id] = hp.index
      }
    }
    onHoverPublish(hovered?.cellId ?? null, next)
  }, [hovered, chartHover, cells, cellMap, cellData, onHoverPublish])

  const lastHoverChart = useRef<string | null>(null)
  const onDeckHover = useCallback(
    (info: DeckHoverInfo) => {
      // WHOSE hover this is comes from `routeGridHover` (`layers/multiView`), the sibling of the
      // `layerFilter` that decided where these layers were allowed to DRAW — so a pane can never
      // paint a plot the pointer cannot touch. Both resolve ownership against the viewport deck
      // reports; neither parses an owner out of a layer id, which is what left every COMPOSED
      // pane's chart hoverless and every composed scatter pick tooltip-less. See its header.
      const { chartCellId: overChart, scatterCellId } = routeGridHover(info, chartDeckIds, SCATTER_LAYER_NAME)
      if (lastHoverChart.current && lastHoverChart.current !== overChart) {
        chartContribs.get(lastHoverChart.current)?.onHover?.(null)
      }
      lastHoverChart.current = overChart
      if (overChart) {
        // Pixels are made cell-relative (deck reports canvas coords) via the pane rect.
        const rect = chartDeckRects.find(r => r.id === overChart)
        chartContribs.get(overChart)?.onHover?.(rect ? { ...info, x: info.x - rect.x, y: info.y - rect.y } : info)
        // Clear any lingering dense scatter tooltip — the pointer left the scatter for this chart.
        if (hoverPending.current !== null) {
          hoverPending.current = null
          if (typeof requestAnimationFrame === 'undefined') flushHover()
          else if (hoverRaf.current == null) hoverRaf.current = requestAnimationFrame(flushHover)
        }
        return
      }
      // MD-8: the picked index is into the HOVERED cell's OWN layer buffer, so the tooltip must read
      // that cell's dataset columns — the workspace `tooltipContext` for a default cell, the per-dataset
      // resident columns for a multi-dataset cell (resolved at render in `hoveredFields`). We record the
      // cell id here; a hover with no resolvable cell is dropped.
      hoverPending.current =
        scatterCellId !== '' ? { index: info.index, x: info.x, y: info.y, cellId: scatterCellId } : null
      if (typeof requestAnimationFrame === 'undefined') flushHover()
      else if (hoverRaf.current == null) hoverRaf.current = requestAnimationFrame(flushHover)
    },
    [flushHover, chartDeckIds, chartContribs, chartDeckRects],
  )
  // Published UP as a ref, not a prop: `<GridDeckLayer>` is this component's SIBLING, and it is
  // `memo`'d — the shell forwards through a STABLE wrapper so deck's props never churn.
  deckHoverRef.current = onDeckHover

  useEffect(
    () => () => {
      if (hoverRaf.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(hoverRaf.current)
      }
    },
    [],
  )

  // MD-8: resolve the tooltip fields for the HOVERED cell. Default cell → the workspace fields
  // (byte-identical). Multi-dataset cell → a caller-supplied per-dataset `TooltipContext` if present,
  // else a minimal context over the dataset's RESIDENT positions (x/y only — the only columns held
  // resident per the O(1) contract), labeled from that dataset's catalog layout.
  const hoveredFields = useMemo(() => {
    if (!hovered) return null
    const cell = cellMap[hovered.cellId]
    if (!cell) return null
    if (!cell.datasetId) return tooltipFields
    const dsCtx = datasetTooltips?.[cell.datasetId]
    if (dsCtx) return buildScatterTooltipFields(dsCtx, datasetTooltipLabels?.[cell.datasetId])
    const cd = cellData(cell)
    if (cd.status !== 'ready' || cd.positions.length === 0) return null
    const labels =
      datasetTooltipLabels?.[cell.datasetId] ??
      datasetAxisLabels(datasetEntries[cell.datasetId]?.catalog, cell.layoutId)
    return buildScatterTooltipFields({ positions: cd.positions }, labels)
  }, [hovered, cellMap, tooltipFields, datasetTooltips, datasetTooltipLabels, cellData, datasetEntries])

  return (
    <>
      {/* Selection draw overlay (ITEM-25 producer): present only in select mode. Sits
          ABOVE the deck (z0) / content (z1) / panels (z2) so it captures the whole
          workspace's pointer stream — which also disables pan while selecting (pan
          returns when the tool is off and this overlay is gone). Draft shapes are drawn
          as plain positioned DIVs (no SVG). */}
      {drawActive && (
        <div
          data-testid="viz-grid-select-overlay"
          ref={wheelRefFor('select')}
          onPointerDown={onDrawPointerDown}
          onPointerMove={onDrawPointerMove}
          onPointerUp={onDrawPointerUp}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            pointerEvents: 'auto',
            cursor: selSpaceHeld ? 'grab' : selHoverMove || selTool === 'move' ? 'move' : 'crosshair',
            touchAction: 'none',
          }}
        >
          {rectDraft && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(rectDraft.start[0], rectDraft.end[0]),
                top: Math.min(rectDraft.start[1], rectDraft.end[1]),
                width: Math.abs(rectDraft.end[0] - rectDraft.start[0]),
                height: Math.abs(rectDraft.end[1] - rectDraft.start[1]),
                border: '1.5px solid rgba(56,132,255,0.9)',
                background: 'rgba(56,132,255,0.12)',
                pointerEvents: 'none',
              }}
            />
          )}
          {polyDraft.map((p, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: p[0] - 3,
                top: p[1] - 3,
                width: 6,
                height: 6,
                borderRadius: 6,
                background: 'rgba(56,132,255,0.95)',
                pointerEvents: 'none',
              }}
            />
          ))}
        </div>
      )}

      {/* Annotation draw overlay — ONE PER PANE WHOSE DOCK IS OPEN (blind-audit H2).
          It used to be a SINGLE `inset:0` sheet over the whole workspace, gated on
          `annotateOpenIds.size > 0`. That made one open dock modalize every OTHER pane: deck
          picking, hover tooltips, marquee select and camera drag all died on panes the user was
          not annotating — including panes that cannot annotate at all. The state, the panels and
          the entry point were already per-pane; the POINTER SURFACE was the last layer still
          global, which is the same singular-vs-plural defect one level down. Fixed by GEOMETRY
          (each overlay covers only its own pane's plot rect), not by a hit-test early-return, so
          a pane with no open dock is not covered by anything and behaves exactly as it does with
          the annotate feature switched off.
          `plotInset` keeps the overlay off the pane's 32px toolbar strip, so the pane's own
          Annotate/Segment/Edit buttons stay clickable while its dock is open.
          Each still routes LEFT drags into the per-cell editor; MIDDLE / SPACE+LEFT pans, wheel
          zooms via its OWN keyed binding (`wheelRefFor('annot-<paneId>')`) — a single shared ref
          left every pane but the last-mounted one unable to zoom (convergence H2). */}
      {annotateActive &&
        denseRects
          .filter(r => annotateOpenIds.has(r.id))
          .map(plotInset)
          .map(r => (
            <div
              key={`annot-overlay-${r.id}`}
              data-testid={`viz-grid-annotate-overlay-${paneTestId(cellMap, r.id)}`}
              data-annotate-overlay="1"
              ref={wheelRefFor(`annot-${r.id}`)}
              onPointerDown={onAnnotatePointerDown}
              onPointerMove={onAnnotatePointerMove}
              onPointerUp={onAnnotatePointerUp}
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: r.width,
                height: r.height,
                zIndex: 3,
                pointerEvents: 'auto',
                cursor: selSpaceHeld ? 'grab' : annotateEditor.cursor,
                touchAction: 'none',
              }}
            />
          ))}

      {/* Cross-window "append here" drop outline (P4): shown when a grip drag hovers this container's
          empty body. VISUAL ONLY (`pointerEvents:none`) — the dragging grip owns the pointer. */}
      {isBodyDropTarget && (
        <div
          data-testid={`viz-grid-bodydrop-${containerId}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            pointerEvents: 'none',
            outline: '2px solid rgba(59,130,246,0.9)',
            outlineOffset: -2,
            background: 'rgba(59,130,246,0.08)',
          }}
        />
      )}

      {/* Aim-to-place reminder (P5): shown in EVERY window while placing a new plot. Pointer-transparent
          so it never blocks the click that places / the cursor tracking. */}
      {isPlacing && (
        <div
          data-testid={`viz-placement-hint-${containerId}`}
          role="status"
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 6,
            pointerEvents: 'none',
            padding: '4px 12px',
            borderRadius: 6,
            background: 'var(--primary, #2563eb)',
            color: 'var(--primary-foreground, #fff)',
            font: '12px system-ui, sans-serif',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          Click a spot to place the new plot · Esc to cancel
        </div>
      )}

      {/* Keyboard-focus outline (a11y): shows WHICH dense cell the arrow/zoom keys drive. VISUAL ONLY
          (`pointerEvents:none`); the live region announces the same for screen readers. */}
      {focusedRect && (
        <div
          data-testid={`viz-grid-a11y-focus-${paneTestId(cellMap, effFocusedId ?? '')}`}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: focusedRect.x,
            top: focusedRect.y,
            width: focusedRect.width,
            height: focusedRect.height,
            zIndex: 4,
            pointerEvents: 'none',
            outline: '2px dashed var(--primary, #2563eb)',
            outlineOffset: -3,
          }}
        />
      )}

      {/* Rich O(1) hover tooltip (ITEM-5): resolveTooltip only INDEXES the resident
          columns at the picked point — constant-time regardless of N. pointer-transparent,
          positioned inside the (relative) container. Hidden while drawing a selection.
          The CROSS-PLOT tooltips render from `GridDeckLayer` (Split A / DRIFT-10) — they project
          through the live camera, so they stay with the camera. Both are direct children of the
          same positioned container, so `VizTooltip`'s `offsetParent` clamp is unchanged. */}
      {tooltipsEnabled && hoveredFields && hovered && !drawActive && (
        <VizTooltip rows={resolveTooltip(hoveredFields, hovered.index).rows} x={hovered.x} y={hovered.y} />
      )}
    </>
  )
}

/** `memo` so the shell's OWN re-renders skip this subtree when its props are unchanged. It does not
 *  affect the draft/hover path — those are this component's own state, so a marquee drag or a hover
 *  frame always renders this component and only it. */
export const GridOverlayLayer = memo(GridOverlayLayerImpl)
GridOverlayLayer.displayName = 'GridOverlayLayer'
