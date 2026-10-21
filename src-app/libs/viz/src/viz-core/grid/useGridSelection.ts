// useGridSelection.ts — SPLIT I (ITEM-25): the grid's SELECTION PUBLISH / PROVENANCE / COMMIT plane.
//
// Everything between a committed AREA and a published SELECTION, moved verbatim out of
// `GridWorkspace`: the KD-tree `selectionIndex`, the per-cell publish (`publishCellSelection`), the
// multi-region fold + publish (`publishCellAreas`), the two commit paths (`commitRect` /
// `commitPolygon`), the whole PROVENANCE half (`paneIdsOf`, `snapshotContext`,
// `recordCellProvenance`, `resolveProvenancePane`, `liveProvenanceContext`, the revalidation
// gatekeeper effect and the host `registerSelectionPanes` effect), the draft/mode state the tool
// rail and the overlay drive (`committedByCell`, `selMulti`, `polyDraftCount`, `selSpaceHeld`, the
// four gesture refs), `clearGridSelection`, and the EXCLUSIVE-selection reconcile effect.
//
// DEC-26's census listed "selection publish / provenance / commit + drafts" (324) and "provenance
// pane resolve + live context" (64) as two rows; they are ONE plane — `liveProvenanceContext` is a
// one-line delegation to `snapshotContextRef`, and the revalidation effect that consumes both
// resolvers is the same gatekeeper `recordCellProvenance` writes for. Splitting them would have put
// a `useRef` on one side of a module boundary and its only writer on the other.
//
// SHAPE — a value bundle, like Split G and for the same reason (DEC-27/DEC-28): four of its outputs
// are seam REFS the overlay layer already reads through the ITEM-14 context, one is a `useState`
// SETTER the overlay layer writes as a prop, and promoting the draft state to a store would change
// the update semantics of a value written on every commit — which is what TEST-P5 measures. It is a
// pure move, and a store hoist is not one.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `committedByCell`  5 writers: the exclusive-reconcile effect, both commit paths and
//                      `clearGridSelection` all move with it; the fifth is `GridOverlayLayer`, which
//                      receives `setCommittedByCell` as a PROP. A prop is typed, so `tsc` sees it —
//                      but it is named here because it is the one writer no `grep` of this module
//                      finds.
//   `selMultiRef`, `committedByCellRef`, `polySlotRef`, `dragRef`  seam members (DEC-20). They are
//                      declared here and RETURNED, so the shell's `seam` memo is byte-identical and
//                      the overlay keeps reading the SAME ref objects. Split G's `sharedMaskSessions`
//                      pattern, applied a second time.
//   `polyDraftCount`   written only by the overlay, through the returned setter (an `onChange` prop).
//   `selSpaceHeld`     written only by the key effect that moves with it; lexical, `tsc`-complete.
//   `activeCellRef`    NOT moved — `requestExportCell` (the export-request region, a later split)
//                      writes it. It is passed IN, which is the honest form of "this ref has two
//                      owners and only one of them is leaving".
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { buildPointIndex } from '../spatial/pointIndex'
import { IndexMask } from '../data/selection'
import { areaMask, type Area } from '../selection/SelectionController'
import { areaToOp, hashPositions, type ProvenancePane } from '../selection/provenance'
import { revalidateSelectionIn } from '../../adapter/selectionRevalidate'
import type { VizSelectionContext, VizSelectionOp } from '../option/types'
import { combineMask, commitCandidatesFor, type Vec2 } from '../selection/areaGestures'
import { mapRowsToIds } from '../coordination/selectionSync'
import { cellProducesSelection, type CellRenderData, type GridCell, type GridOverlayApi } from './gridModel'
import { unprojectInCell, type ScreenPoint } from './gridSelection'
import { cellPlotId } from '../charts/plotCellId'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'
import type { PaneRect } from '../layers/multiView'
import type { VizStores } from '../../adapter/vizStores'
import type { createCoordinationHandle } from '../../adapter/coordinationHandle'
import type { GridViewState } from './linkZoom'
import type { PointIndex } from '../spatial/pointIndex'

type CoordinationHandle = ReturnType<typeof createCoordinationHandle>

export interface GridSelectionInputs {
  readonly coordination: CoordinationHandle
  readonly coordinationRef: RefObject<CoordinationHandle>
  readonly storesRef: RefObject<VizStores>
  readonly positions: Float32Array
  readonly cells: readonly GridCell[]
  readonly cellData: (cell: GridCell) => CellRenderData
  readonly cellDataRef: RefObject<(cell: GridCell) => CellRenderData>
  readonly cellMapRef: RefObject<Record<string, GridCell>>
  readonly cellSelectionSpaceRef: RefObject<(cell: GridCell, hasIds: boolean) => string>
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly perCellRangeRef: RefObject<Record<string, readonly [number, number]>>
  readonly perCellHiddenCodes: Record<string, Set<number>>
  readonly perCellHiddenCodesRef: RefObject<Record<string, Set<number>>>
  readonly pointIndexFor: (pos: Float32Array) => PointIndex
  readonly denseRectsRef: RefObject<readonly PaneRect[]>
  readonly viewStateRef: RefObject<Record<string, GridViewState>>
  readonly onSelectionPanes: GridSelectionPanesRegistrar | undefined
  readonly lastClassificationRef: RefObject<string | null>
  /** The overlay's imperative handle. Declared in the shell (`setActiveTool` resets drafts through it,
   *  and that callback is declared BEFORE this plane's call site), so it is borrowed, not owned. */
  readonly overlayApiRef: RefObject<GridOverlayApi | null>
}

/** The host registrar shape — structurally the `onSelectionPanes` prop, restated here so this module
 *  does not import the shell's props interface (which would be a cycle). */
export type GridSelectionPanesRegistrar = (
  resolvePane: (pane: string | null) => ProvenancePane | null,
  liveContext: (prov: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }) => VizSelectionContext,
) => void | (() => void)

export interface GridSelection {
  readonly committedByCell: Record<string, Area[]>
  readonly setCommittedByCell: React.Dispatch<React.SetStateAction<Record<string, Area[]>>>
  readonly committedByCellRef: RefObject<Record<string, Area[]>>
  readonly selMulti: boolean
  readonly setSelMulti: React.Dispatch<React.SetStateAction<boolean>>
  readonly selMultiRef: RefObject<boolean>
  readonly polySlotRef: RefObject<number | null>
  readonly dragRef: RefObject<{ cell: string; index: number; startWorld: Vec2; origArea: Area } | null>
  readonly anyCommittedArea: boolean
  readonly selSpaceHeld: boolean
  readonly polyDraftCount: number
  readonly setPolyDraftCount: React.Dispatch<React.SetStateAction<number>>
  readonly finishPolygon: () => void
  readonly commitRect: (start: ScreenPoint, end: ScreenPoint, cellId: string) => void
  readonly commitPolygon: (pts: readonly ScreenPoint[], cellId: string) => void
  readonly publishCellAreas: (cellId: string, areas: readonly Area[]) => void
  readonly clearGridSelection: () => void
}

/** The selection publish / provenance / commit plane. */
export function useGridSelection({
  coordination,
  coordinationRef,
  storesRef,
  positions,
  cells,
  cellData,
  cellDataRef,
  cellMapRef,
  cellSelectionSpaceRef,
  perCellRange,
  perCellRangeRef,
  perCellHiddenCodes,
  perCellHiddenCodesRef,
  pointIndexFor,
  denseRectsRef,
  viewStateRef,
  onSelectionPanes,
  lastClassificationRef,
  overlayApiRef,
}: GridSelectionInputs): GridSelection {
  // Cross-cell lifecycle parity: reconcile the grid's committed scatter outlines against the EXCLUSIVE
  // selection signal. A single-mode select by ANOTHER surface (a violin) or a Clear drops every grid
  // outline the grid no longer owns — so scatter↔violin behaves exactly like scatter↔scatter.
  const exclusiveSel = coordination.useExclusiveSelection()
  const lastExclusiveEpochRef = useRef(exclusiveSel.epoch)
  useEffect(() => {
    if (exclusiveSel.epoch === lastExclusiveEpochRef.current) return
    lastExclusiveEpochRef.current = exclusiveSel.epoch
    const owner = exclusiveSel.origin
    setCommittedByCell(prev => {
      const keys = Object.keys(prev)
      if (owner == null) return keys.length ? {} : prev // Clear ⇒ drop all
      if (keys.length === 1 && keys[0] === owner) return prev // already just the owner ⇒ no-op
      const next: Record<string, Area[]> = {}
      if (prev[owner]) next[owner] = prev[owner]
      return next
    })
  }, [exclusiveSel.epoch, exclusiveSel.origin])

  // ITEM-14 — THE AUTOMATIC RE-EVALUATION TRIGGER (DEC-19), split by change class (DEC-22/INV-8).
  //
  // This effect is the grid's half of the trigger: it is the only place that can OBSERVE a data,
  // filter or hidden change as it happens (the controller holds no per-cell buffers). It delegates
  // the decision AND the work to `revalidateSelectionIn` — the single shared implementation the
  // controller's public `revalidateSelection()` also calls — so there is exactly one split rule.
  //
  // Deps are the three things that can move: the per-cell data resolver, the live filter ranges, and
  // the hidden-code map. A context tick costs a `classifyChange` + a context write and ZERO
  // containment tests; only a moved positions hash re-runs geometry.
  const resolveProvenancePane = useCallback(
    (pane: string | null): ProvenancePane | null => {
      if (!pane) return null
      const cell = cellMapRef.current[pane]
      if (!cell) return null
      const cd = cellDataRef.current(cell)
      if (cd.positions.length === 0) return null
      return {
        positions: cd.positions,
        nPoints: cd.nPoints,
        pointIds: cd.pointIds,
        space: cellSelectionSpaceRef.current(cell, cd.pointIds != null),
      }
    },
    [],
  )
  const liveProvenanceContext = useCallback(
    (prov: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }) =>
      snapshotContextRef.current(paneIdsOf(prov.ops)),
    [],
  )
  // L15 — a change signature for the GROUP-hidden vocabulary `snapshotContext` reads but that is
  // unreachable from `perCellHiddenCodes`. A plain string so the effect's identity compare is cheap.
  const hiddenGroupsSig = useMemo(
    () => cells.map(c => `${c.id}:${(c.hiddenGroups ?? []).join(',')}`).join('|'),
    [cells],
  )
  useEffect(() => {
    const coord = storesRef.current.coordination.getState()
    if (!coord.selectionProvenance) return
    const cls = revalidateSelectionIn(coord, resolveProvenancePane, liveProvenanceContext)
    if (typeof window !== 'undefined' && import.meta.env.DEV && cls !== 'skipped') {
      lastClassificationRef.current = cls
    }
    // L15 — `hiddenGroupsSig` is in the deps because `snapshotContext` also reads
    // `cell.hiddenGroups` (the grouped/chart-cell hidden vocabulary), which is NOT reachable from
    // `perCellHiddenCodes`. Without it, toggling a group legend on a chart cell never ticked the
    // gatekeeper, so the recorded `context.hidden` silently lagged the display state until some
    // unrelated dep moved. Benign for ids (a context change never changes them, DEC-20) but it made
    // `getSelectionStaleness()` and the recorded provenance wrong.
  }, [cellData, perCellRange, perCellHiddenCodes, hiddenGroupsSig, resolveProvenancePane, liveProvenanceContext])

  // H1 — hand the SAME two resolvers to the host (`<Viz>` → `controller.registerSelectionPanes`).
  //
  // The grid holds the per-cell buffers; the controller owns the public DEC-23 surface. Without this
  // the controller's `resolvePanes`/`liveContextProbe` stay null, so `getSelectionStaleness()` answers
  // `'unknown'` forever and `revalidateSelection()` is a permanent no-op — the API is inert. Both
  // callbacks are `[]`-stable, so this registers once per mount and releases on unmount.
  useEffect(() => {
    if (!onSelectionPanes) return
    const unregister = onSelectionPanes(resolveProvenancePane, liveProvenanceContext)
    return () => {
      if (typeof unregister === 'function') unregister()
    }
  }, [onSelectionPanes, resolveProvenancePane, liveProvenanceContext])

  const [polyDraftCount, setPolyDraftCount] = useState(0)
  /** The rail's Finish button. A stable wrapper so the rail's prop identity never churns. */
  const finishPolygon = useCallback(() => {
    overlayApiRef.current?.finishPolygon()
  }, [])

  // The committed selection AREAS per cell, in that cell's WORLD coords (selection-unification: the grid
  // gains the persistent committed outline + drag-to-move that SelectableScatter has). MULTIPLE regions
  // per cell: in SINGLE mode a new region REPLACES the cell's list; in MULTI mode it APPENDS (the union
  // of all regions is published). Default single (byte-identical to the old one-area-per-cell behavior).
  // ⇒ The FULL selection contract these dense-cell handlers implement (and which the violin mirrors)
  //   is the header comment of `viz-core/selection/SelectionController.ts`. Divergence = bug.
  const [committedByCell, setCommittedByCell] = useState<Record<string, Area[]>>({})
  // Single vs MULTIPLE region select (rail switch). Ref for the pointer handlers.
  const [selMulti, setSelMulti] = useState(false)
  const selMultiRef = useRef(selMulti)
  selMultiRef.current = selMulti
  // The index (within committedByCell[activeCell]) the IN-PROGRESS polygon occupies, so live vertex
  // updates REPLACE that one slot instead of appending a region per vertex. null ⇒ no polygon in progress.
  const polySlotRef = useRef<number | null>(null)
  // in-progress Move-tool drag: the grabbed cell + the area's INDEX + geometry at grab time (translate a
  // FRESH copy every move so the drag never accumulates rounding drift).
  const dragRef = useRef<{ cell: string; index: number; startWorld: Vec2; origArea: Area } | null>(null)
  const committedByCellRef = useRef(committedByCell)
  committedByCellRef.current = committedByCell
  // CONVERGENCE M4 — what enables `select.move`. The Move tool translates a committed AREA, so its
  // precondition is "an area exists to move", NOT "points are currently selected" (`anySelectionActive`,
  // which is a point-id predicate). Those two come apart in both directions: an area drawn over empty
  // space selects zero points yet is perfectly movable, and a selection restored/driven from another
  // surface can light up point ids with no area in this workspace to grab.
  const anyCommittedArea = useMemo(
    () => Object.values(committedByCell).some(areas => (areas?.length ?? 0) > 0),
    [committedByCell],
  )

  // ── pan/zoom that STAYS LIVE while a selection tool is active (the overlay would otherwise block
  // the deck controller). Per-cell + link-zoom aware: the gesture drives the camera of the cell UNDER
  // the cursor through the SAME `onViewStateChange` the controller uses, so link-zoom fan-out + clamp
  // are inherited, and the committed outline (per-cell world-space) stays anchored. WHEEL = zoom,
  // MIDDLE-drag or SPACE+drag = pan, LEFT-drag = draw. Shared camera MATH (bumpZoom/zoomToCursorTarget/
  // panTarget) — no per-host copy. */
  const [selSpaceHeld, setSelSpaceHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSelSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSelSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // CPU spatial index over the point cloud, built ONCE per positions buffer
  // (O(N log N)) and reused for every lasso/box hit-test — so a region selection is
  // O(log N + k) (a KD-tree range query), NOT an O(N) coordinate scan. Shared by both
  // commit paths below; rebuilt only when the positions buffer changes.
  const selectionIndex = useMemo(() => buildPointIndex(positions), [positions])

  // PRODUCE (MULTI-DATASOURCE / ITEM-16): publish a cell's lassoed LOCAL indices as canonical POINT
  // IDS (via the cell's dataset `pointIds`; identity copy when absent) into the cell's identity-SPACE.
  // A default/sole-dataset cell publishes to the DEFAULT space via the handle (byte-identical); a
  // multi-dataset cell publishes to its canonical/isolated space via the store.
  const publishCellSelection = useCallback((cell: GridCell, cd: CellRenderData, indices: Uint32Array) => {
    // ITEM-5 (declarative capability): a dense cell that declares `select:{produces:false}` is not a
    // selection SOURCE — a lasso/rect over it publishes nothing (mirrors ViolinView's `producesEnabled`
    // gate). Default (flag unset/true) ⇒ byte-identical.
    if (!cellProducesSelection(cell)) return
    const ids = mapRowsToIds(indices, cd.pointIds ?? undefined)
    const spaceId = cellSelectionSpaceRef.current(cell, cd.pointIds != null)
    if (spaceId === DEFAULT_SELECTION_SPACE) {
      // MULTI ⇒ accumulate this cell's ids with every OTHER plot's selection (combined highlight
      // fans across all plots). SINGLE ⇒ replace (one region total across the workspace).
      coordinationRef.current.setSelection(cell.id, ids, selMultiRef.current)
    } else {
      storesRef.current.coordination.getState().setSelectionInSpace(spaceId, cell.id, ids)
    }
  }, [])

  // Publish a cell's committed areas (multi-region): fold each area's mask through the SHARED
  // `areaMask` + `commitCandidatesFor` seam, then publish the combined indices. Single-region ⇒ a 1-area
  // fold (byte-identical to the old single-mask publish).
  //
  // ITEM-4 (provenance PREREQUISITE, DEC-11): this fold used to be `combined.union(m)` — union ONLY —
  // while `SelectionController.recompute()` (`selection/SelectionController.ts:221`) folds the same
  // area list through `combineMask(base, m, area.mode)`, honouring add / subtract / intersect. Two
  // independent implementations of one fold. Routing the grid through the SAME `combineMask` makes it
  // one, which INV-2 ("`ops` re-derive `ids` EXACTLY") requires: `deriveSelection` would otherwise be a
  // THIRD fold, and INV-2 would hold for the single-canvas producer while quietly lying about the grid
  // the moment anyone mints a non-`add` area here.
  //
  // BYTE-IDENTICAL TODAY, and proven so rather than assumed (TEST-20): every grid-committed area is
  // minted `mode:'add'` (`commitRect`/`commitPolygon` below), and `combineMask(empty, m, 'add')` IS
  // `empty.union(m)` === `m`.
  //
  // The EMPTY SEED is load-bearing and is what makes this the SAME fold rather than a similar one.
  // `recompute()` starts from `new IndexMask(totalPoints)` and folds EVERY entry including the first;
  // seeding instead with the first area's mask (as this function used to, via `combined ? … : m`)
  // agrees only while every area is `add`. A leading `intersect` would yield `m` here and the empty
  // set there — precisely the silent divergence INV-2 forbids.
  // The distinct pane ids an op list touches, in first-appearance order — the panes whose live
  // filter/hidden/positions state the context snapshot must cover.
  const paneIdsOf = (ops: readonly VizSelectionOp[]): string[] => {
    const out: string[] = []
    for (const o of ops) if (o.pane && !out.includes(o.pane)) out.push(o.pane)
    return out
  }

  // ITEM-6: snapshot the DISPLAY CONTEXT that explains a selection — what was filtered, what was
  // hidden, and a content hash of the data the ops were hit-tested against.
  //
  // Reads the LIVE per-cell state (DEC-4), never `option.filters`. NOTE the rationale has changed
  // since the plan was written (DRIFT-1.5): `fix/visualmap-filters-roundtrip` merged, so
  // `perCellRange` IS now the store-backed source `option.filters` emits from — the two agree at
  // rest. Reading live still matters, because the context must be captured at the instant of the
  // gesture, and `option.filters` is a re-emission that lags a publish tick.
  //
  // `panes` is the STALENESS DETECTOR (INV-8): a moved positions hash means the underlying data
  // changed, so cached ids may reference points that no longer exist and a full re-derive is owed.
  const snapshotContext = useCallback(
    (paneIds: readonly string[]): VizSelectionContext => {
      const filters: Record<string, readonly [number, number]> = {}
      const hidden: Record<string, readonly number[]> = {}
      const panes: Record<string, string> = {}
      // FILTERS + HIDDEN are captured WORKSPACE-WIDE, not just for the op-bearing panes: the context
      // is "what the user was looking at" (and what `partitionSelection` needs to explain an id), and
      // a clamp on a neighbouring pane is part of that picture. `panes` below is the opposite — it is
      // the STALENESS detector, so it covers ONLY the panes the ops touch: a pane no op ever hit
      // cannot invalidate the selection, and hashing it would make unrelated data churn look like a
      // reason to re-derive.
      for (const [pid, range] of Object.entries(perCellRangeRef.current)) {
        if (range) filters[pid] = [range[0], range[1]]
      }
      for (const [cid, codes] of Object.entries(perCellHiddenCodesRef.current)) {
        const pid = cellPlotId(cid)
        if (pid && codes && codes.size > 0) hidden[pid] = [...codes].sort((a, b) => a - b)
      }
      for (const id of paneIds) {
        const cell = cellMapRef.current[id]
        if (!cell) continue
        const plotId = cellPlotId(id)
        if (!plotId) continue
        // Dense cells hide CATEGORY CODES (`perCellHiddenCodes`); grouped/chart cells hide GROUPS
        // (`cell.hiddenGroups`). Both are the same vocabulary on the wire — sorted `number[]`,
        // never a `Set` (`types.ts:225-228`).
        const groups = cell.hiddenGroups
        if (groups && groups.length > 0) {
          const merged = new Set<number>([...(hidden[plotId] ?? []), ...groups])
          hidden[plotId] = [...merged].sort((a, b) => a - b)
        }
        const cd = cellDataRef.current(cell)
        if (cd.positions.length > 0) panes[id] = hashPositions(cd.positions)
      }
      return {
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        ...(Object.keys(hidden).length > 0 ? { hidden } : {}),
        ...(Object.keys(panes).length > 0 ? { panes } : {}),
      }
    },
    [],
  )
  const snapshotContextRef = useRef(snapshotContext)
  snapshotContextRef.current = snapshotContext

  // ITEM-5: turn a cell's committed area list into the op list that explains its published ids.
  // An EMPTY area list clears this cell's contribution — provenance must not outlive its ids.
  const recordCellProvenance = useCallback(
    (cellId: string, cell: GridCell, cd: CellRenderData, areas: readonly Area[]) => {
      if (!cellProducesSelection(cell)) return
      const coord = storesRef.current.coordination.getState()
      const space = cellSelectionSpaceRef.current(cell, cd.pointIds != null)
      const ops = areas.map(a => areaToOp(a, cellId, space))
      if (ops.length === 0) {
        // Only drop the whole record when no OTHER pane still contributes ops; a multi-pane
        // selection's other panes keep theirs (the same scoping `clearSelectionInSpace` uses).
        const rest = (coord.selectionProvenance?.ops ?? []).filter(o => o.pane !== cellId)
        coord.setSelectionProvenance(
          rest.length > 0 ? { ops: rest, context: snapshotContextRef.current(paneIdsOf(rest)) } : null,
        )
        return
      }
      // Replace THIS pane's ops in place, preserving the relative order of other panes' ops — the
      // list is a recipe and its order is load-bearing (DEC-5).
      const others = (coord.selectionProvenance?.ops ?? []).filter(o => o.pane !== cellId)
      const next = [...others, ...ops]
      coord.setSelectionProvenance({ ops: next, context: snapshotContextRef.current(paneIdsOf(next)) })
    },
    [],
  )

  const publishCellAreas = useCallback(
    (cellId: string, areas: readonly Area[]) => {
      const cell = cellMapRef.current[cellId]
      if (!cell) return
      const cd = cellDataRef.current(cell)
      if (cd.positions.length === 0) return
      const index = cell.datasetId ? pointIndexFor(cd.positions) : selectionIndex
      // #228 NOTE, because an earlier cut of that item changed this loop and the change was wrong.
      //
      // An area is captured by unprojecting screen pixels, so it is in the pane's WORLD space, and
      // the mask is computed against the RAW position buffer. Those are the same space, and they
      // stay the same space, because the coordinate binding moves the RASTER and never the points
      // (DEC-17). A version that placed the points with a `modelMatrix` made these two different
      // spaces and needed the area mapped back — along with the hover ring, the provenance replay,
      // the cross-pane tooltip and the vector export, each of which reads this same buffer and
      // projects it itself. Refusing a non-identity layout placement is what keeps all of them
      // correct by construction rather than by five transforms being kept in step.
      let combined = new IndexMask(cd.nPoints)
      for (const area of areas) {
        const m = areaMask(area, cd.positions, cd.nPoints, commitCandidatesFor(area, index))
        combined = combineMask(combined, m, area.mode)
      }
      publishCellSelection(cell, cd, areas.length === 0 ? new Uint32Array(0) : combined.toIndices())
      // ITEM-5/ITEM-6: record the PROVENANCE of what was just published, from the SAME `areas` list
      // that was just folded.
      //
      // DRIFT (impl-wins vs PLAN's ITEM-5): the plan specified recording an op at each of the four
      // mutation sites (commitRect / commitPolygon / translate / drag-out-remove) and "keeping the op
      // list index-aligned with `committedByCell[cellId]`". Deriving the ops HERE instead makes that
      // alignment TRUE BY CONSTRUCTION rather than maintained by discipline: every mutation path
      // already funnels through `publishCellAreas` with the cell's FULL current area list, so there
      // is no parallel array that can drift out of step, and a FUTURE fifth mutation path gets
      // provenance for free instead of silently producing an un-provenanced selection. It is also
      // strictly fewer edits to the highest-churn file in the package.
      recordCellProvenance(cellId, cell, cd, areas)
    },
    [selectionIndex, publishCellSelection, pointIndexFor, recordCellProvenance],
  )

  const commitRect = useCallback(
    (start: ScreenPoint, end: ScreenPoint, cellId: string) => {
      const rect = denseRectsRef.current.find(r => r.id === cellId)
      const vs = viewStateRef.current[cellId]
      const cell = cellMapRef.current[cellId]
      if (!rect || !vs || !cell) return
      // Retain the committed area in the cell's WORLD coords so its outline persists + is draggable.
      const w0 = unprojectInCell(rect, vs, start[0], start[1])
      const w1 = unprojectInCell(rect, vs, end[0], end[1])
      if (!w0 || !w1) return
      polySlotRef.current = null // a rect ends any in-progress polygon slot
      const newArea: Area = { kind: 'rect', box: [w0[0], w0[1], w1[0], w1[1]], mode: 'add' }
      // SINGLE ⇒ replace the cell's regions; MULTI ⇒ append (union of all).
      const existing = committedByCellRef.current[cellId] ?? []
      const areas = selMultiRef.current ? [...existing, newArea] : [newArea]
      // SINGLE ⇒ this is the ONLY region in the whole workspace, so clear every other cell's outline
      // too (keeps the on-screen outlines in lockstep with the single coordination selection).
      setCommittedByCell(prev => (selMultiRef.current ? { ...prev, [cellId]: areas } : { [cellId]: areas }))
      publishCellAreas(cellId, areas)
    },
    [publishCellAreas],
  )

  const commitPolygon = useCallback(
    (pts: readonly ScreenPoint[], cellId: string) => {
      const rect = denseRectsRef.current.find(r => r.id === cellId)
      const vs = viewStateRef.current[cellId]
      const cell = cellMapRef.current[cellId]
      if (!rect || !vs || !cell) return
      const ring: [number, number][] = []
      for (const p of pts) {
        const w = unprojectInCell(rect, vs, p[0], p[1])
        if (w) ring.push([w[0], w[1]])
      }
      if (ring.length < 3) return
      const newArea: Area = { kind: 'polygon', polygon: ring, mode: 'add' }
      const existing = committedByCellRef.current[cellId] ?? []
      let areas: Area[]
      if (polySlotRef.current == null) {
        // first valid commit of THIS polygon → a fresh slot (append in multi, replace in single)
        areas = selMultiRef.current ? [...existing, newArea] : [newArea]
        polySlotRef.current = areas.length - 1
      } else {
        // a LIVE vertex update (#4 auto-commit) → replace the same in-progress slot, never append.
        areas = existing.slice()
        areas[polySlotRef.current] = newArea
      }
      setCommittedByCell(prev => (selMultiRef.current ? { ...prev, [cellId]: areas } : { [cellId]: areas }))
      publishCellAreas(cellId, areas)
    },
    [publishCellAreas],
  )

  // (SPLIT B — ITEM-16: `finishPolygon`, `cancelPolygon` and the Enter/Esc lasso key effect moved
  //  into `GridOverlayLayer`. All three read or write `polyDraft` / `polySlotRef`, and the key effect
  //  is ARMED by `polyDraft.length`, so leaving any of them here would have kept the draft in this
  //  component in all but name. The rail's Finish button calls the handle declared above.)

  const clearGridSelection = useCallback(() => {
    overlayApiRef.current?.clearDrafts()
    setCommittedByCell({})
    coordinationRef.current.clearSelection() // DEFAULT space (single-dataset byte-identical)
    // MULTI-DATASOURCE: also clear every non-default identity space so a multi-dataset Clear resets all.
    const coord = storesRef.current.coordination.getState()
    for (const spaceId of Object.keys(coord.selectionBySpace)) {
      if (spaceId !== DEFAULT_SELECTION_SPACE) coord.clearSelectionInSpace(spaceId)
    }
  }, [])

  return {
    committedByCell,
    setCommittedByCell,
    committedByCellRef,
    selMulti,
    setSelMulti,
    selMultiRef,
    polySlotRef,
    dragRef,
    anyCommittedArea,
    selSpaceHeld,
    polyDraftCount,
    setPolyDraftCount,
    finishPolygon,
    commitRect,
    commitPolygon,
    publishCellAreas,
    clearGridSelection,
  }
}
