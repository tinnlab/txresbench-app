// GridDeckLayer.tsx — SPLIT A (ITEM-5 / ITEM-6, DEC-18 / DEC-20).
//
// THE CAMERA LIVES HERE, AND NOWHERE ELSE.
//
// Before this split every camera value — `localStates`, the coordination-store `viewStates`
// subscription, the derived `controlledViewState`/`deckViewState`, and the two memos that read them
// (`annotationLayers`' viewport cull and `crossTooltips`' world→screen projection) — was declared in
// `GridWorkspace`'s body. A wheel therefore re-rendered the WHOLE 6,000-line closure: the tool rail,
// the pane tree, every `<CellView>` element and every legend overlay were re-created ~30 times a
// second to move a camera that none of them read (measured: 375 elements/wheel at 4 panes, of which
// the chrome is the overwhelming majority, and `CellView` 168 element creations over one drive).
// `memo()` on the chrome could stop the chrome's BODY from re-running, but not the parent from
// re-creating its element — so INV-1 could only ever hold by memo discipline, never structurally.
//
// Moving the camera into this child makes it hold STRUCTURALLY: a camera change re-renders exactly
// this component and its `<DeckGL>`, because nothing above it subscribes to a camera value at all.
// That is the design's §4.3 promise and TEST-P1 / TEST-P6 are its acceptance criteria.
//
// ── What crosses the boundary, and in which direction (ITEM-6) ───────────────────────────────────
// DOWN, as explicit props: everything that is NOT camera-derived — the deck's `views`/`layerFilter`/
// hover handler, the non-camera layer lists, and the inputs the two camera-dependent memos need.
// Props are re-evaluated when the shell re-renders for its OWN reasons, which is unchanged behaviour.
//
// UP, through the ITEM-14 seam's REF handles — never as a context value (DEC-20):
//   * `viewStateRef.current`      — the camera READ handle. The shell keeps 12 pointer/keyboard call
//                                   sites that need the live camera at GESTURE time; they read this
//                                   ref synchronously, so they cannot observe a one-frame-stale
//                                   camera (INV-9). It is assigned during THIS component's render,
//                                   i.e. in the same commit that hands the new camera to deck.
//   * `onViewStateChangeRef.current` — the camera WRITE handle, invoked by the shell's 5 pan/zoom
//                                   sites (3 pointer + 2 a11y-keyboard). A missed write site is how
//                                   a split silently breaks keyboard panning, so the seam publishes
//                                   the handler itself rather than N bespoke callbacks.
//   * `localStatesRef.current`    — read by the shell's image-framing effect ("frame this image only
//                                   if the user has not moved its camera yet") and by `toggleLinked`
//                                   (seeding a space's shared scope from a cell's local camera).
//                                   Admitted to the seam BY THIS SPLIT, with both consumers visible
//                                   in the same diff — the admission rule DRIFT-4 states.
//
// ── Why this component is mounted UNCONDITIONALLY ────────────────────────────────────────────────
// The `<DeckGL>` element is conditional (`visible`), but the COMPONENT is not: `localStates` is
// React state, so unmounting on "no dense rects" would silently reset every pane's camera and would
// leave the three seam refs stale. It previously lived in a component that was always mounted, and
// it still does.
//
// ── Why the cross-plot tooltips moved with the camera ────────────────────────────────────────────
// `crossTooltips` PROJECTS a highlighted point through each cell's live camera, so it must recompute
// per frame. Left in the shell it would have re-rendered the shell on every camera frame — the exact
// cost this split exists to remove — so the memo AND its `<VizTooltip>`s moved here. They are
// returned as FRAGMENT SIBLINGS of the deck div (not children of it): the deck wrapper sets
// `zIndex: 0`, which establishes a stacking context that would trap a `zIndex: 20` tooltip beneath
// the z2/z4/z5 overlays. As siblings they keep the same positioned ancestor (so `VizTooltip`'s
// viewport clamp is unchanged) and the same paint layer. Split B (ITEM-16) owns the tooltip surface
// and will reunite them with the main hover tooltip.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import type { Layer } from '@deck.gl/core'
import { useStore } from 'zustand'
import { gridScopeId } from '../../adapter/Coordination.store'
import { buildAnnotationLayers, type AnnotationEditDraft } from '../annotate/buildAnnotationLayers'
import { cellVisibleWorldBounds, makeCellViewport } from './gridSelection'
import type { GridCell } from './gridModel'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  applyViewStateChange,
  buildControlledViewStates,
  cameraSignature,
  clampViewState,
  clampZoom,
  type GridViewState,
} from './linkZoom'
import type { PaneRect, ViewZoom } from '../layers/multiView'
import type { ChartContribution } from './chartLayerSink'
import { VizTooltip } from '../tooltip/VizTooltip'
import { resolveTooltip, type TooltipField } from '../tooltip/tooltipModel'
import { useGridWorkspaceSeam, type CellDataResolved } from './GridWorkspaceContext'

/** A single flat viewState applied to every OrthographicView (fixtures center on 0).
 *  Declared HERE, with the camera it seeds, and imported by the shell for the two sites that still
 *  need a fallback zoom (`toggleLinked`'s space seed and the a11y pan step). */
// SPLIT O (ITEM-31): `INITIAL_VIEW_STATE` moved to the neutral `gridModel.ts` — `useGridA11y`'s
// keyboard PAN reads its zoom to size a world-units step, and a hook may not import a layer
// (INV-10 (d), DRIFT-43/52). Re-exported so existing importers of this module are unaffected.
import { INITIAL_VIEW_STATE } from './gridModel'
export { INITIAL_VIEW_STATE }

export interface GridDeckLayerProps {
  /** Render the `<DeckGL>` at all (`glOk && there is at least one deck-hosted pane`). The COMPONENT
   *  stays mounted either way — see the header. */
  readonly visible: boolean
  /** Bumped by `useCanvasRecovery` on WebGL context restore; remounts the one deck. */
  readonly restoreKey: number
  /** The shell's `<DeckGL>` imperative handle (read by the popup-realm resize effect + export). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly deckRef: React.RefObject<any>
  readonly views: unknown[]
  readonly layerFilter: unknown
  readonly onDeckHover: unknown

  // ── layers ──────────────────────────────────────────────────────────────────────────────────────
  /** Everything drawn BEFORE the annotation overlays: scatter `layers`, selection outlines, hover
   *  highlights, chart contributions. Split in two so the annotation layers keep their exact
   *  position in the deck's draw order (they sit between the chart layers and the label masks).
   *  Typed `unknown` for the same reason the shell's old `allLayers` ended in `as never[]`: the
   *  deck layer classes across @deck.gl/layers + viv + the custom GPU layers do not share one
   *  assignable `Layer<P>` instantiation. */
  readonly layersBefore: readonly unknown[]
  /** Everything drawn AFTER the annotation overlays (the in-grid label masks). */
  readonly layersAfter: readonly unknown[]

  // ── camera derivation (structure-derived; none of these changes per frame) ───────────────────────
  /** cellId → coordinate-space key. Link-zoom is scoped per space. */
  readonly cellSpaces: Record<string, string>
  readonly linked: boolean
  readonly chartContribs: ReadonlyMap<string, ChartContribution>

  // ── `annotationLayers` inputs ───────────────────────────────────────────────────────────────────
  readonly cells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly annotateEpoch: number
  readonly annotateMode: boolean
  readonly boundAnnotateCellId: string | null
  readonly annotateEditDraft: AnnotationEditDraft | null

  // ── `crossTooltips` inputs ──────────────────────────────────────────────────────────────────────
  readonly tooltipsEnabled: boolean
  readonly tooltipFields: TooltipField[] | null
  readonly effectiveHighlight: Record<string, number | null>
  readonly hoveredCellId: string | null
  readonly denseCells: readonly GridCell[]
  readonly cellData: (cell: GridCell) => CellDataResolved
  readonly rects: readonly PaneRect[]
  readonly plotInset: (r: PaneRect) => PaneRect
  /** A selection/annotation draw gesture is in flight ⇒ tooltips are suppressed (as in the shell). */
  readonly drawActive: boolean

  /** Called once per committed camera change. The shell subscribes ONLY while a surface that must
   *  follow the camera is open (the plot-data table, which lists the points VISIBLE in the pane's
   *  current window). Absent/no-op ⇒ the shell is never re-rendered by the camera, which is the
   *  whole point of this split. */
  readonly onCameraCommit?: () => void
}

function GridDeckLayerImpl({
  visible,
  restoreKey,
  deckRef,
  views,
  layerFilter,
  onDeckHover,
  layersBefore,
  layersAfter,
  cellSpaces,
  linked,
  chartContribs,
  cells,
  denseIds,
  annotateEpoch,
  annotateMode,
  boundAnnotateCellId,
  annotateEditDraft,
  tooltipsEnabled,
  tooltipFields,
  effectiveHighlight,
  hoveredCellId,
  denseCells,
  cellData,
  rects,
  plotInset,
  drawActive,
  onCameraCommit,
}: GridDeckLayerProps) {
  const {
    stores,
    storesRef,
    annotateStoresRef,
    denseRectsRef,
    viewStateRef,
    onViewStateChangeRef,
    localStatesRef,
    seedViewStateRef,
  } = useGridWorkspaceSeam()

  // ── Link-zoom coordination (DEC-37), SCOPED BY COORDINATE SPACE ────────────
  // OFF (default): each cell zooms/pans independently — its own `localStates`
  // entry. ON: cells share a view state ONLY WITHIN their coordinate space (the
  // embedding-blind-zoom fix). Each dense cell declares a `spaceKey` (`cellSpaceKey`):
  // two scatters over the same embedding sync; a scatter and an image/spatial cell live
  // in DIFFERENT spaces and never sync. The shared state is sharded per space in the
  // Coordination store under `gridScopeId(spaceKey)`.
  const allViewStates = useStore(stores.coordination, s => s.viewStates)
  const [localStates, setLocalStates] = useState<Record<string, GridViewState>>({})
  // Mirrored UP through the seam: the shell's image-framing effect asks "has the user moved this
  // cell's camera yet?" and `toggleLinked` seeds a space's shared scope from a cell's local camera.
  // Both are non-reactive reads at effect/event time — exactly the file's established ref idiom.
  localStatesRef.current = localStates

  // The shared view state PER SPACE, read from the store's sharded scopes. Only spaces
  // present in this grid are materialized; a space with no stored scope yet is absent
  // (the cell falls back to INITIAL_VIEW_STATE via `buildControlledViewStates`).
  const sharedBySpace = useMemo(() => {
    const out: Record<string, GridViewState> = {}
    for (const space of new Set(Object.values(cellSpaces))) {
      const vs = allViewStates[gridScopeId(space)]
      if (vs) out[space] = { target: [vs.target[0], vs.target[1], 0], zoom: vs.zoom }
    }
    return out
  }, [allViewStates, cellSpaces])

  // Controlled `{ [viewId]: viewState }` deck consumes: each cell reads ITS SPACE's
  // shared state when linked, else its own local state (default until first moved).
  const controlledViewState = useMemo(
    () => buildControlledViewStates(cellSpaces, localStates, linked, sharedBySpace, INITIAL_VIEW_STATE),
    [cellSpaces, localStates, linked, sharedBySpace],
  )
  // THE CAMERA READ SEAM (ITEM-6). Assigned in render, so the shell's pointer/keyboard handlers read
  // the SAME camera object deck is being handed in this commit — never one frame behind (INV-9).
  viewStateRef.current = controlledViewState

  // The map the DECK consumes: dense (scalar) states + migrated chart cells' fitted (independent-axis)
  // states. Kept SEPARATE from `controlledViewState` so the dense camera math stays scalar-typed.
  const deckViewState = useMemo(() => {
    const merged: Record<string, { target: [number, number, number]; zoom: ViewZoom }> = { ...controlledViewState }
    for (const [id, c] of chartContribs) {
      merged[id] = { target: [c.viewState.target[0], c.viewState.target[1], 0], zoom: c.viewState.zoom }
    }
    return merged
  }, [controlledViewState, chartContribs])

  // A view moved: clamp zoom, then either fan the state to THAT CELL'S SPACE scope
  // (linked → only same-space cells move) or update only the moved cell (unlinked).
  const onViewStateChange = useCallback(
    ({ viewId, viewState }: { viewId: string; viewState: GridViewState }) => {
      // Migrated chart view moved (free-camera charts): route the camera back to the chart, which
      // owns its (independent-axis) fit + re-publishes. Handle BEFORE the dense scalar clamp.
      const chart = chartContribs.get(viewId)
      if (chart?.onViewStateChange) {
        const vz = clampZoom(viewState.zoom as never, MIN_ZOOM, MAX_ZOOM)
        chart.onViewStateChange({ target: [viewState.target[0], viewState.target[1]], zoom: vz })
        return
      }
      const clamped = clampViewState(viewState, MIN_ZOOM, MAX_ZOOM)
      if (linked) {
        const space = cellSpaces[viewId]
        if (space) {
          storesRef.current.coordination.getState().setGridViewState(space, {
            target: [clamped.target[0], clamped.target[1]],
            zoom: clamped.zoom,
          })
        }
      } else {
        setLocalStates(prev =>
          applyViewStateChange(prev, viewId, viewState, cellSpaces, false, MIN_ZOOM, MAX_ZOOM),
        )
      }
    },
    [linked, cellSpaces, chartContribs, storesRef],
  )
  // THE CAMERA WRITE SEAM (ITEM-6): the shell's 5 pan/zoom sites invoke the handler through this ref
  // rather than re-subscribing to it. Assigned in render for the same reason as `viewStateRef`.
  onViewStateChangeRef.current = onViewStateChange

  // The SIXTH camera write (see `GridViewStateSeed`): "frame this cell, unless it already has a
  // camera". `setLocalStates` is not exported to the shell — only this narrow, idempotent handle is,
  // so a caller cannot use it to move a camera the user owns.
  const seedViewState = useCallback((cellId: string, viewState: GridViewState) => {
    setLocalStates(prev => (prev[cellId] ? prev : { ...prev, [cellId]: viewState }))
  }, [])
  seedViewStateRef.current = seedViewState

  // ── THE CAMERA-COMMIT CHOKEPOINT (DEC-46) ────────────────────────────────────────────────────────
  // `onCameraCommit` is how a consumer that DERIVES from the camera but does not subscribe to it (the
  // dock's open plot-data table, whose rows are the points inside the pane's current window) learns it
  // must re-derive. It is invoked from HERE — one site, keyed on the camera deck is actually handed —
  // and deliberately NOT from `onViewStateChange`, because that callback is only ONE of the writers:
  //   1. the deck gesture (`onViewStateChange`, unlinked → `setLocalStates`);
  //   2. the same gesture LINKED → the coordination store's per-space scope;
  //   3. a HOST write — `VizController.dispatchAction({type:'gridViewState', …})` → the same scope;
  //   4. a SECOND, popped-out `<GridWorkspace>` panning the same space → the same scope;
  //   5. the image-framing SEED (`seedViewState` above, from `useGridRaster`'s load effect).
  // Only (1)/(2) pass through the callback. Notifying from it left 3/4/5 silently stale — the table
  // listed the pre-move window and its CSV export matched it. Every one of the five, by construction,
  // lands in `localStates` or in `allViewStates`, and therefore in `deckViewState`. That is the
  // chokepoint; a sixth writer added later needs no new call site, which is the point.
  //
  // Keyed on the camera's VALUE (`cameraSignature`), not the memo's identity: the shell turns a commit
  // into a re-render, which re-mints these memos, so an identity key would be a feedback loop.
  const lastCameraSigRef = useRef<string | null>(null)
  useEffect(() => {
    const sig = cameraSignature(deckViewState)
    if (lastCameraSigRef.current === sig) return
    const first = lastCameraSigRef.current === null
    lastCameraSigRef.current = sig
    // The first run is the MOUNT camera, not a move.
    if (!first) onCameraCommit?.()
  }, [deckViewState, onCameraCommit])

  // Dev-only per-cell viewState reader (dead-code-eliminated in prod): exposes each cell's
  // controlled zoom so a headless test can prove per-view independent zoom (wheeling over one
  // pane changes ONLY that pane's zoom). Mirrors the __VIZ_INCELL__ hook in the shell.
  //
  // `target` is published beside `zoom` (ITEM-16) because HALF a camera is not a camera. The
  // `driveWheelsRoundTrip` guard in `_renderPerf.ts` asserts a wheel round trip put the camera
  // back; a zoom-only reader would have let the PAN half of the drift through, and the pan half
  // is real — `clampViewState` clamps `zoom` but keeps the `target` deck computed for the
  // UNCLAMPED zoom, so every wheel spent against the MAX_ZOOM ceiling still slides the view.
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return
    ;(window as unknown as { __VIZ_GRID_VIEW__?: unknown }).__VIZ_GRID_VIEW__ = {
      zoom: Object.fromEntries(
        Object.entries(controlledViewState).map(([id, vs]) => [id, (vs as GridViewState).zoom]),
      ),
      target: Object.fromEntries(
        Object.entries(controlledViewState).map(([id, vs]) => [id, (vs as GridViewState).target]),
      ),
      // The cell → COORDINATE-SPACE map. Published because the camera's other writers address a
      // SPACE, not a cell: a host's `dispatchAction({type:'gridViewState', spaceKey, …})` and a
      // popped-out workspace both write `grid:<spaceKey>`. Without it a test of those paths has to
      // GUESS the key (it folds in `datasetId` and the cell kind), and a wrong guess is a silent
      // no-op that reads exactly like "the camera did not move" — the vacuity this seam exists to
      // remove for `zoom`/`target`, one level up.
      spaces: { ...cellSpaces },
    }
  }, [controlledViewState, cellSpaces])

  // Annotation overlay layers (ITEM-3) — the per-cell `AnnotateStore`'s committed geometry, cellId-
  // prefixed so `makeLayerFilter` routes each into its own cell's viewport (rides its pan/zoom). Its own
  // memo (like `selectionOutlineLayers`) so an annotation edit never rebuilds the scatter `layers` memo;
  // `annotateEpoch` (bumped by the store subscriptions) is the rebuild trigger.
  // Per-cell layer cache (convergence M7) — keyed by cellId, holding the deps that produced each
  // cell's layers so an unrelated pane's rebuild can be skipped entirely.
  const annotLayerCache = useRef(new Map<string, { deps: unknown[]; layers: Layer[] }>())
  const annotationLayers = useMemo(() => {
    const out: Layer[] = []
    const live = new Set<string>()
    for (const cell of cells) {
      if (!cell.annotate || !denseIds.has(cell.id)) continue
      const store = annotateStoresRef.current.get(cell.id)
      if (!store) continue
      live.add(cell.id)
      const st = store.getState()
      // Viewport cull (FB-17): the cell's VISIBLE full-res bounds enable the flatbush cull so a large
      // committed collection tessellates only the features in the camera window (defeating the prior
      // "cull never runs" finding). Recomputed as the camera moves via `controlledViewState`.
      const rect = denseRectsRef.current.find(r => r.id === cell.id)
      const vs = controlledViewState[cell.id]
      const bounds = rect && vs ? cellVisibleWorldBounds(rect, vs) : null
      // Live edit-tier preview only for the FOCUSED cell's editor (draft path / reshape / translate).
      const isEditing = annotateMode && cell.id === boundAnnotateCellId
      const draft = isEditing ? annotateEditDraft : null
      // CONVERGENCE M7 — PER-CELL memo. `editDraft` changes on EVERY pointermove of the rubber band,
      // and this used to be one memo over every annotate cell, so one pane's drawing gesture
      // re-tessellated every OTHER pane's committed layers too — falsifying DEC-13's premise that
      // the draft is a cheap, locally-scoped update. Only the DRAWING cell's key carries the draft,
      // so a move now rebuilds exactly one pane; the rest are handed back their previous Layer
      // instances, which is also deck's own "nothing changed here" signal.
      const deps: unknown[] = [
        st.byId, st.ids, st.selection,
        bounds?.[0], bounds?.[1], bounds?.[2], bounds?.[3],
        draft,
      ]
      const prev = annotLayerCache.current.get(cell.id)
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))) {
        out.push(...prev.layers)
        continue
      }
      const layers = buildAnnotationLayers({
        collection: { byId: st.byId, ids: st.ids },
        selection: st.selection,
        viewport: bounds ? { bounds } : null,
        editDraft: draft,
        cellId: cell.id,
      })
      annotLayerCache.current.set(cell.id, { deps, layers })
      out.push(...layers)
    }
    // Drop cache entries for cells that no longer render annotations (pane closed / removed).
    for (const id of annotLayerCache.current.keys()) if (!live.has(id)) annotLayerCache.current.delete(id)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, denseIds, annotateEpoch, controlledViewState, annotateMode, boundAnnotateCellId, annotateEditDraft])

  // Draw order is load-bearing: …scatter/selection/hover/chart → ANNOTATIONS → label masks.
  const allLayers = useMemo(
    () => [...layersBefore, ...annotationLayers, ...layersAfter] as never[],
    [layersBefore, annotationLayers, layersAfter],
  )

  // CROSS-PLOT tooltips: for every OTHER same-dataset DENSE cell the hover is highlighting, project the
  // corresponding point to that cell's screen position and show its tooltip too (so hovering one point
  // surfaces its data across all linked scatters). Gated by the tooltip toggle. Default-dataset dense
  // cells only (they share the workspace `tooltipFields`); chart cells show the highlight ring instead.
  const crossTooltips = useMemo(() => {
    if (!tooltipsEnabled || !tooltipFields) return []
    const out: { cellId: string; x: number; y: number; idx: number }[] = []
    for (const [cellId, idx] of Object.entries(effectiveHighlight)) {
      if (idx == null) continue
      if (hoveredCellId && cellId === hoveredCellId) continue // the source cell already shows the main tooltip
      const cell = denseCells.find(c => c.id === cellId)
      if (!cell || cell.datasetId) continue
      const cd = cellData(cell)
      if (idx < 0 || idx >= cd.nPoints) continue
      const px = cd.positions[idx * 2]
      const py = cd.positions[idx * 2 + 1]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const rect = rects.find(r => r.id === cellId)
      if (!rect) continue
      const inset = plotInset(rect)
      const vs = controlledViewState[cellId]
      if (!vs) continue
      const vp = makeCellViewport(inset.width, inset.height, vs)
      if (!vp) continue
      const s = vp.project([px, py])
      out.push({ cellId, x: inset.x + s[0], y: inset.y + s[1], idx })
    }
    return out
  }, [tooltipsEnabled, tooltipFields, effectiveHighlight, hoveredCellId, denseCells, cellData, rects, plotInset, controlledViewState])

  return (
    <>
      {/* Deck canvas: one context, N views over the DENSE cells, absolutely filling
          the workspace. MUST stay FIRST in DOM so `useCanvasRecovery`'s
          `querySelector('canvas')` grabs the SHARED deck canvas (not a chart's). */}
      {visible && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
          <DeckGL
            key={restoreKey}
            ref={deckRef}
            views={views as never}
            controller
            viewState={deckViewState as never}
            onViewStateChange={onViewStateChange as never}
            layers={allLayers}
            layerFilter={layerFilter as never}
            onHover={onDeckHover as never}
            // Pan/zoom cursor: a NORMAL arrow when idle (not deck's default `grab`, which reads as
            // "drag me" and makes pointing at a dot for its tooltip awkward), a POINTER over a pickable
            // point, and `grabbing` only while actively dragging to pan.
            getCursor={({ isDragging, isHovering }: { isDragging: boolean; isHovering: boolean }) =>
              isDragging ? 'grabbing' : isHovering ? 'pointer' : 'default'
            }
          />
        </div>
      )}
      {/* CROSS-PLOT tooltips: the same point's data shown in every other linked dense cell.
          A SIBLING of the deck div, never a child — see the header on stacking contexts. */}
      {!drawActive && tooltipFields &&
        crossTooltips.map(t => (
          <VizTooltip key={`cross-${t.cellId}`} rows={resolveTooltip(tooltipFields, t.idx).rows} x={t.x} y={t.y} />
        ))}
    </>
  )
}

/** `memo` so the shell's OWN re-renders (data load, selection, dock open) skip this subtree when its
 *  props are unchanged. It does not affect the camera path — the camera is this component's own
 *  state, so a camera change always renders it and only it. */
export const GridDeckLayer = memo(GridDeckLayerImpl)
GridDeckLayer.displayName = 'GridDeckLayer'
