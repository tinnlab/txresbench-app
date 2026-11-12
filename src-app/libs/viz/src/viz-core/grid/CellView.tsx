// CellView.tsx — the per-cell content renderer for the heterogeneous grid (Phase C1).
//
// The grid measures EVERY leaf pane's pixel rect; this component paints one cell's
// content into an absolutely-positioned div at that rect, branching on whether the
// cell's `kind` is a DENSE kind (`isDenseKind`) and, for chart cells, dispatching
// through the chart-type REGISTRY:
//
//   • DENSE kinds (scatter / image) draw underneath in the shared single-`<DeckGL>` /
//     N-views deck (DEC-20). Here the div stays pointer-transparent so deck's pixels
//     show through — the pane toolbar (`<PaneToolbar>`) re-arms `pointerEvents:auto`
//     on ITSELF, so it is the sole interactive element and pan falls through around it.
//   • CHART kinds each render their OWN `ChartCanvas` via the matching chart View. The
//     View is looked up GENERICALLY in the registry — `ChartBody` resolves the cell's
//     `kind` via `getChartType(kind).view` and renders it with the uniform
//     `ChartViewProps` (there is NO `switch (cell.kind)` here anymore). The div is
//     pointer-interactive so the chart owns its events; the chrome sits on top.
//
// Every cell (dense + chart) carries a `<PaneToolbar>` (the shell-redesign replacement
// for the old floating `CellChrome` pill, which was DELETED once it had no call site):
// a view-kind switcher, split, and remove, wired to the grid store. Its `extra` slot is
// where the per-pane colour-by picker hangs off.
//
// A registry MISS (an unregistered / unsupported kind) renders the visible `Unsupported`
// fallback and never crashes — the generic replacement for the old switch's `default`.
//
// viz-core rule: depends only on react + sibling viz-core modules (no @txresbench/*).

import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PaneRect } from '../layers/multiView'
import type { DataSource, DatasetCatalog } from '../data/wire'
import { type CellKind, type GridCell, cellTestId, isDenseKind } from './gridModel'
import { type DragRect, type DropTarget, type DropZone, PRIMARY_CONTAINER, useGripDrag, useGripDragState } from '@txresbench/dock'
// The collapsed colour-by trigger paints a GLYPH, and every glyph on the pane toolbar comes from the
// one vocabulary — an unregistered icon here is how two Pencils shipped (finding #14).
import { toolFor } from '../tools/registry'
import { type GutterSide, gutterFromParts, gutterPadding } from './plotGutter'
import type { ColorBy } from '../data/engine'
import type { SplitDir } from '@txresbench/dock'
import { PaneToolbar } from './PaneToolbar'
import { Button as KitButton, Select as KitSelect } from '@txresbench/kit'
import { ExternalLink, CornerUpLeft } from 'lucide-react'
import { useVizStores } from '../../adapter/vizStores'
import { registerPopupWindow, nextPopupContainerId } from '@txresbench/dock'
import { buildPopupFeatures, centeredGeometry } from '../popout/windowPortalCore'
import type { ContainerId } from '@txresbench/dock'
import { getChartType } from '../registry/registry'
import { makeChartModel, asRefusal, refusalMessage } from '../registry/model'
import { VizEventBusContext } from '../events/EventBusContext'
import type { ChartModel, CoordinationHandle } from '../registry/types'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import { Unsupported } from '../charts/Unsupported'
import { ChartUnbound } from '../charts/useAsyncChartData'
import { PlotCellIdContext, cellPlotId } from '../charts/plotCellId'

// ---------------------------------------------------------------------------
// Grip drag (POINTER-based). A cell is dragged by its chrome GRIP; the drag tracks via WINDOW-level
// `pointermove`/`pointerup` (NOT pointer capture) so it follows the cursor across whatever's underneath,
// including a dense cell's deck — `@txresbench/dock`'s `useGripDrag` owns that lifecycle. On move we hit-test
// the pointer against a per-window SNAPSHOT of the docked cell rects + the workspace rect (taken at
// drag start) via the pure `resolveDrop`:
//   • over another cell in the SAME container → SWAP target (highlight it);
//   • over a cell / body in ANOTHER window    → MOVE target (dock there);
//   • outside the source workspace            → TEAR-OFF target;
//   • else                                     → none.
// On `pointerup` we resolve + execute; `Escape` / `pointercancel` ABORT cleanly (no swap, no
// tear-off) — a canceled drag can never mis-fire (the old HTML5 `dragend` (0,0) ambiguity is gone,
// since cancel is now explicit and pointer coords are always real).
//
// A single module-level reactive drag state drives cross-cell highlighting (which cell/container is the
// current drop target). It is published only when the TARGET changes (not every pixel); the floating
// drag ghost is a re-homed DOM node owned by `useGripDrag`.
// ---------------------------------------------------------------------------

/** The grip's pointer-drag handler, supplied by `CellView` to `PaneToolbar`. Only `pointerdown` lives
 *  on the grip; the drag then tracks via WINDOW-level pointermove/up/cancel (robust across engines and
 *  the basis for the later cross-window drag). */
export interface GripHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
}

export interface CellViewProps {
  /** The cell config (id + view-kind + data binding). */
  cell: GridCell
  /** Which container renders this cell — `'grid'` (main) or a `popup:<n>` (PORTAL_DOCKING P3). A
   *  cell in a popup shows a Return affordance instead of pop-out; a grid cell pops out into a new
   *  window. Default `'grid'`. */
  containerId?: ContainerId
  /** The pane's measured pixel rect within the workspace. */
  rect: PaneRect
  /** The viz data plane the chart Views load from. */
  source: DataSource
  /** The dataset catalog `defaultBindings` reads column ids from. */
  catalog: DatasetCatalog
  /** Interleaved xy positions (reserved for C2 dense-cell chrome). */
  positions: Float32Array
  /** RGBA colors (reserved for C2 dense-cell chrome). */
  colors: Uint8Array
  /** Bumps when `colors` contents change (reserved for C2 dense-cell chrome). */
  colorEpoch?: number
  /** The cell's OWN per-cell `colorBy` RGBA buffer (from GridWorkspace's `perCellColors`), when the
   *  cell declares a `colorBy`. Undefined ⇒ no per-cell recolor (use the shared base `colors`). Used
   *  by the standalone popped-out dense render so the popup matches the in-grid recoloring. */
  cellColors?: Uint8Array
  /** Bumps when `cellColors` changes (the per-cell color epoch). */
  cellColorEpoch?: number
  /** The Selection coordination handle (STEP 3), threaded into each dispatched chart's
   *  `ChartViewProps.coordination`. Defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /**
   * Request an export scoped to THIS cell (ITEM-47 follow-up). When supplied, the cell's
   * chrome shows a ⤓ export button; clicking it calls this with the cell's id so the host
   * (via GridWorkspace's `onRequestExportCell`) opens its ExportDialog scoped to this pane.
   * OMITTED ⇒ no export button (back-compat).
   */
  onExportCell?: (cellId: string) => void
  /** Open the EDIT FORM for this cell (shell redesign). When supplied, the pane toolbar shows a ✎ Edit
   *  button; clicking it asks the host to open the edit form scoped to this pane. */
  onEditCell?: (cellId: string) => void
  /** Toggle the plotting-data TABLE overlay for this cell. When supplied, the pane toolbar shows a data
   *  button (between Export and Split). */
  onShowData?: (cellId: string) => void
  /** Whether THIS cell's data table is currently open (drives the toolbar button's pressed state). */
  dataOpen?: boolean
  /** Whether THIS cell's EDIT FORM is currently open (drives the edit button's active-tab indicator). */
  editOpen?: boolean
  /** Toggle THIS cell's ANNOTATE dock (finding #14 — the per-pane entry point that replaced the global
   *  rail mode). Supplied only for an annotate-CAPABLE cell ⇒ other panes show no button. */
  onAnnotateCell?: (cellId: string) => void
  /** Whether THIS cell's annotate dock is open (active-tab indicator, in sync with the dock's ×). */
  annotateOpen?: boolean
  /** Toggle THIS cell's SEGMENT (mask review/correct) dock. Supplied only for a segment-CAPABLE cell. */
  onSegmentCell?: (cellId: string) => void
  /** Whether THIS cell's segment dock is open (active-tab indicator, in sync with the dock's ×). */
  segmentOpen?: boolean
  /** SELECTION LINK: toggle link for this cell (start picking / open the manage popover). When supplied,
   *  the toolbar shows a link button LEFT of edit. */
  onToggleLink?: (cellId: string) => void
  /** This cell's link-group color (badges its link button); absent ⇒ unlinked. */
  linkColor?: string
  /** True while a link-picking session is active anywhere (highlights the link tool). */
  linkActive?: boolean
  /** Shell redesign: render the per-pane top TOOLBAR (occupies a 32px strip, plot below). Absent/false ⇒
   *  no toolbar (the plot fills the whole rect). */
  showToolbar?: boolean
  /** This chart cell is migrated to render as a view in the shared grid deck (shared-deck-charts):
   *  pass pointer events through to the deck (its ChartCanvas publishes layers, renders no own deck). */
  sharedDeckChart?: boolean
  /** Legend "beside" gutter to reserve on one side of the PLOT BODY. Insets the chart body container
   *  so its ChartCanvas measures the shrunk plot — matching the shared-deck view GridWorkspace shrinks
   *  by the same gutter. Absent ⇒ no gutter (overlay legend / dense cells handle it on the deck).
   *
   *  TWO PRIMITIVES, not a `{ w, side }` object (ITEM-1 / DEC-7). The producer
   *  (`GridWorkspace.legendGutterFor`) builds a fresh literal per call, so an object-valued prop
   *  changed identity on every render and was the single referentially-unstable prop at this call
   *  site — enough on its own to make `memo(CellView)` completely inert. Primitives compare by value
   *  and cannot go stale; `plotGutter.ts` owns the flatten/reassemble pair. */
  plotGutterW?: number
  plotGutterSide?: GutterSide
}

/** Per-pane toolbar height (px) — the strip the toolbar OCCUPIES at the top of a pane (deck view inset). */
export const PANE_TOOLBAR_H = 32

/**
 * Render one cell's content at its measured rect. Dense cells get a
 * pointer-transparent placeholder (deck draws underneath); chart cells host their
 * own `ChartCanvas` and capture pointer events.
 */
const T_COLORBY = toolFor('pane', 'colorby')

function CellViewImpl({
  cell,
  rect,
  source,
  catalog,
  positions,
  colors,
  colorEpoch,
  cellColors,
  cellColorEpoch,
  coordination = defaultCoordinationHandle,
  onExportCell,
  onEditCell,
  onShowData,
  dataOpen,
  editOpen,
  onAnnotateCell,
  annotateOpen,
  onSegmentCell,
  segmentOpen,
  onToggleLink,
  linkColor,
  linkActive,
  showToolbar = false,
  containerId = PRIMARY_CONTAINER,
  sharedDeckChart = false,
  plotGutterW,
  plotGutterSide,
}: CellViewProps) {
  // Reassembled on THIS side of the memo boundary — one allocation, off the camera path.
  const plotGutter = useMemo(
    () => gutterFromParts({ plotGutterW, plotGutterSide }),
    [plotGutterW, plotGutterSide],
  )
  // THE ID A READER ADDRESSES, resolved ONCE for the whole pane. Every `data-testid` and every
  // accessible name below is stamped from this, never from `cell.id`: on a composed grid the latter
  // is the host's fold key (`<viewId>::<local>`), so a spec, a screenshot diff or a screen-reader
  // announcement built on it carries a separator plus the identity of whichever declaration happened
  // to contribute the pane. `cell.id` survives in exactly two places in this file — `data-cell-id`
  // (the invertible channel the drag hit-test recovers) and the store calls, which are keyed by it.
  const testId = cellTestId(cell)
  const dense = isDenseKind(cell.kind)
  // A chart migrated to the shared deck (shared-deck-charts): still renders its ChartBody (which
  // publishes to the deck), but — like a dense cell — lets pointer events fall THROUGH to the shared
  // deck so the per-view controller drives its pan/zoom. Its own DOM overlays re-arm pointerEvents.
  const passThrough = dense || sharedDeckChart
  // Resolve the active store set from context (the module singletons when unprovided), so a
  // per-instance `<Viz>` drives ITS OWN grid store for every mutation + popout read (VIZ_ISOLATION
  // W2). The `coordination` prop is threaded separately by GridWorkspace (per-instance handle).
  const stores = useVizStores()
  // The plot-event bus (Phase 3 controlled close). Null when rendered without a `<Viz>` provider.
  const bus = useContext(VizEventBusContext)
  // PORTAL_DOCKING: this cell renders inside whatever container owns it (grid or a popup GridWorkspace).
  // Popping out = `movePane` this cell into a NEW popup container + open its window (the main grid then
  // reflows). Returning = `returnPaneToGrid`. There is no per-cell portal-move any more.
  const inPopup = containerId !== PRIMARY_CONTAINER
  const rootRef = useRef<HTMLDivElement>(null)
  // POP-OUT / TEAR-OFF (grid cell → new window). `window.open` needs a user GESTURE (a click grants
  // it); when it's blocked (popup blocker) we surface a "allow pop-ups + Retry" prompt whose Retry runs
  // from a real click. `tearoffBlocked` drives that prompt.
  const [tearoffBlocked, setTearoffBlocked] = useState(false)
  const openCellInPopup = useCallback((): boolean => {
    if (typeof window === 'undefined') return false
    const id = nextPopupContainerId()
    const features = buildPopupFeatures(
      centeredGeometry(960, 720, window.screen?.width ?? 1440, window.screen?.height ?? 900),
    )
    const w = window.open('about:blank', id, features)
    if (!w) {
      setTearoffBlocked(true) // blocked → prompt Retry (a click IS a valid gesture)
      return false
    }
    registerPopupWindow(id, w)
    stores.gridWorkspace.getState().movePane(cell.id, id, { kind: 'root' })
    setTearoffBlocked(false)
    return true
  }, [cell.id, stores])
  const returnToPrimary = useCallback(() => {
    stores.gridWorkspace.getState().returnPaneToGrid(cell.id)
  }, [cell.id, stores])
  const attemptTearOff = useCallback(() => {
    if (inPopup) return // a cell already in a popup doesn't tear off (cross-window move is P4)
    openCellInPopup()
  }, [inPopup, openCellInPopup])
  // Clear a stale blocked-prompt if the cell leaves the grid by ANY path while the prompt is showing.
  useEffect(() => {
    if (inPopup && tearoffBlocked) setTearoffBlocked(false)
  }, [inPopup, tearoffBlocked])
  // Grip drag (pointer-based). `drag` (module) tells this cell whether a drag is active + whether IT is
  // the current swap target (highlight). The SOURCE cell captures the pointer and drives the whole
  // lifecycle: snapshot the cell rects + grid rect at pointerdown, hit-test on move, resolve on up.
  const dragState = useGripDragState()
  // This cell is the current DROP TARGET when the pointer is over it — either a same-container SWAP, or
  // a cross-window MOVE that would dock the dragged pane BESIDE this cell (P4). The container match on
  // the move case scopes the highlight to THIS window's copy of the cell.
  const isDropTarget =
    dragState.active &&
    dragState.sourceId !== cell.id &&
    ((dragState.target.kind === 'swap' && dragState.target.paneId === cell.id) ||
      (dragState.target.kind === 'move' &&
        dragState.target.container === containerId &&
        dragState.target.overPaneId === cell.id))
  // The active "+"-cross zone on THIS cell (drives which arm of the drop indicator lights up): a `swap`
  // target = the CENTER; a same-container `move` = the edge derived from its split dir + before.
  const t = dragState.target
  const activeZone: DropZone | null = !isDropTarget
    ? null
    : t.kind === 'swap'
      ? 'center'
      : t.kind === 'move'
        ? t.dir === 'col'
          ? t.before
            ? 'left'
            : 'right'
          : t.before
            ? 'top'
            : 'bottom'
        : null
  // The GENERIC cross-window pointer-drag lifecycle (module drag singleton, ghost re-homed across
  // windows, per-window listeners + hit-test, Escape/blur abort, cleanup) is `@txresbench/dock`'s
  // `useGripDrag`. CellView supplies ONLY: a per-window rect snapshot (its DOM query against each
  // window's document) + what a resolved drop DOES — swap in the source container, MOVE to another
  // window's container, or tear-off to a new window.
  const gripDrag = useGripDrag({
    sourceId: cell.id,
    sourceContainerId: containerId,
    snapshot: (win, _cid) => {
      const container = win.document.querySelector('[data-testid="viz-grid-workspace"]')
      if (!container) return null
      // Recovered from `data-cell-id`, NOT from the testid: the ids below are fed straight back
      // into `swapCells` / `movePane`, so this has to be the grid's own key. A composing host makes
      // the testid the AUTHORED id, which is not unique across contributions and is not what the
      // store is keyed by — inverting through it would silently mis-target the drag.
      const panes: DragRect[] = Array.from(container.querySelectorAll('[data-cell-id]')).map(el => ({
        id: el.getAttribute('data-cell-id') as string,
        rect: el.getBoundingClientRect(),
      }))
      return { panes, containerRect: container.getBoundingClientRect() }
    },
    onResolve: target => {
      if (target.kind === 'swap') {
        // resolveDrop already excludes the source cell.
        stores.gridWorkspace.getState().swapCells(cell.id, target.paneId)
      } else if (target.kind === 'move') {
        // Dock into ANOTHER window's container: split beside the hovered pane, or append/root the body.
        const dropTarget: DropTarget = target.overPaneId
          ? { kind: 'split', atLeaf: target.overPaneId, dir: target.dir, before: target.before }
          : { kind: 'root' }
        stores.gridWorkspace.getState().movePane(cell.id, target.container as ContainerId, dropTarget)
      } else if (target.kind === 'tearoff') {
        attemptTearOff()
      }
    },
    ghostLabel: cell.kind,
    ghostTestId: `viz-cell-dragghost-${testId}`,
  })

  // `useGripDrag` returns a fresh wrapper object each render but its `onPointerDown` is
  // `useCallback([])`-stable, so keying the memo on the HANDLER (not the wrapper) makes this prop
  // genuinely stable rather than merely re-wrapped.
  const gripHandlers: GripHandlers = useMemo(
    () => ({ onPointerDown: gripDrag.onPointerDown }),
    [gripDrag.onPointerDown],
  )
  const style: CSSProperties = {
    position: 'absolute',
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    overflow: 'hidden',
    // Dense: fall through to the deck underneath. Chart: the chart owns its events.
    // Either way the chrome pill re-arms `pointerEvents:auto` on itself, so it is
    // the ONLY interactive element in a dense cell (pan still falls through around it).
    pointerEvents: passThrough ? 'none' : 'auto',
  }
  // ── ITEM-2: PROP STABILITY AT THIS CALL SITE ────────────────────────────────────────────────
  // `memo(PaneToolbar)` is worth exactly nothing unless EVERY non-primitive prop holds its identity
  // across a render — 12 of the 20 props below were a fresh function, object or element on every
  // pass, so a shallow comparator would have found a difference every time and re-rendered anyway.
  // The wrapping below is therefore not tidiness; it is the entire mechanism, and each `useCallback`
  // deps list is deliberately the smallest set that keeps the closure correct (`getState()` at call
  // time is what lets most of them close over nothing but the store handle and the cell id).
  //
  // Store mutations read at call time (getState) — PaneToolbar is presentational.
  const setKind = useCallback(
    (kind: CellKind) => stores.gridWorkspace.getState().setCellKind(cell.id, kind),
    [stores, cell.id],
  )
  const split = useCallback(
    (dir: SplitDir) => stores.gridWorkspace.getState().splitCell(cell.id, dir),
    [stores, cell.id],
  )
  const splitCol = useCallback(() => split('col'), [split])
  // CONTROLLED close (Phase 3): a `controlled` cell does NOT remove itself — it emits `cell-close` so the
  // APP owns removal (a state-derived cell reopens on the next render if closed imperatively). Without a
  // provider the bus is null, so a controlled close is a no-op (the built-in remove is still suppressed —
  // the contract holds); a NON-controlled cell removes directly, byte-identical to before.
  // NO `removeBlockedReason` guard here, deliberately. A cell the host declared unremovable never
  // reaches this callback: `PaneToolbar` is the ONLY consumer of `onRemove` (verified — the
  // `CellChrome` pill that was the other consumer is DELETED, and there is no keyboard delete
  // path), and it renders that cell's close
  // with no handler at all. A guard on this side would be a branch nothing can execute, which is the
  // same defect as a test nothing can fail — measured: deleting it killed zero tests, because there
  // is no route to it. The decision lives in ONE place, at the affordance, where the user meets it.
  const remove = useCallback(() => {
    if (cell.controlled) {
      bus?.emit({ type: 'cell-close', cellId: cell.id })
      return
    }
    stores.gridWorkspace.getState().removeCell(cell.id)
  }, [cell.controlled, cell.id, bus, stores])
  // C3a pop-out toggle, hung off PaneToolbar's `rightExtra` slot. The popout dispatches
  // through the chart-type registry (Round 1), so a popped-out cell renders its
  // ACTUAL `cell.kind` — same registry-backed View as the in-grid cell, not a fixed
  // scatter fixture.
  const popoutButton = useMemo(
    () =>
      inPopup ? (
        <KitButton
          size="icon"
          variant="ghost"
          tooltip="Return to the main grid"
          data-testid={`viz-cell-return-${testId}`}
          onClick={returnToPrimary}
        >
          <CornerUpLeft className="size-3.5" />
        </KitButton>
      ) : (
        <KitButton
          size="icon"
          variant="ghost"
          tooltip="Pop out into its own window"
          data-testid={`viz-cell-popout-${testId}`}
          onClick={openCellInPopup}
        >
          <ExternalLink className="size-3.5" />
        </KitButton>
      ),
    [inPopup, cell.id, returnToPrimary, openCellInPopup],
  )
  // C3b per-cell color-by picker — DENSE cells only (a chart cell has no scatter
  // buffer to recolor). Lists the catalog's continuous + value columns so two cells
  // can pick the SAME column and (via ⚖) share one color scale. Reflects the cell's
  // current `colorBy` (empty ⇒ falls back to the shared color buffer). The store
  // action is read at change time via getState() (this component is presentational).
  // MEMOIZED, and this is load-bearing for ITEM-2 rather than incidental: `colorByButton` closes
  // over this array, so a fresh array every render makes the `useCallback` on `extra` inert and the
  // whole stabilization chain collapses one link from the end.
  const colorByOptions = useMemo(
    () =>
      dense
        ? [
            ...catalog.continuousColumns.map(c => ({ value: `continuous:${c.id}`, label: c.label })),
            ...catalog.valueColumns.map(v => ({ value: `value:${v}`, label: v })),
          ]
        : [],
    [dense, catalog.continuousColumns, catalog.valueColumns],
  )
  const colorByValue = cell.colorBy ? `${cell.colorBy.mode}:${cell.colorBy.key}` : undefined
  const colorByLabel = colorByOptions.find(o => o.value === colorByValue)?.label
  // A RENDER FUNCTION, because only PaneToolbar knows (from measured fit) whether the pinned group
  // has room for the value-as-text form. Collapsed, the SAME Select renders an icon-only trigger via
  // `labelRender` — one control, one listbox, one keyboard behaviour; only what the trigger paints
  // changes. The visible value is what collapsing costs, so it moves into the accessible name and the
  // native tooltip rather than being dropped.
  // `extra` is a RENDER FUNCTION `(collapsed: boolean) => ReactNode`, so it must be `useCallback`'d,
  // NOT `useMemo`'d — the value handed down is the function itself, and a fresh function identity
  // defeats `memo(PaneToolbar)` exactly as a fresh element would.
  const colorByRender = useCallback(
    (collapsed: boolean) => (
    <span title={collapsed ? `${T_COLORBY.label}: ${colorByLabel ?? 'none'}` : undefined} className="inline-flex shrink-0">
    <KitSelect
      size="sm"
      className={
        collapsed
          ? 'w-8 shrink-0 justify-center border-0 bg-transparent px-0 shadow-none [&>svg:last-child]:hidden'
          : 'min-w-7 shrink border-0 bg-transparent shadow-none'
      }
      data-testid={`viz-cell-colorby-${testId}`}
      aria-label={collapsed ? `${T_COLORBY.label}: ${colorByLabel ?? 'none'}` : `Color ${testId} by column`}
      placeholder="color…"
      {...(collapsed ? { labelRender: () => <T_COLORBY.Icon className="size-3.5" /> } : {})}
      value={colorByValue}
      onValueChange={v => {
        if (!v) return
        const idx = v.indexOf(':')
        const mode = v.slice(0, idx) as ColorBy['mode']
        const key = v.slice(idx + 1)
        stores.gridWorkspace.getState().setCellColorBy(cell.id, {
          mode,
          key,
          colormap: 'viridis',
          scale: 'linear',
          hidden: new Set<number>(),
        })
      }}
      options={colorByOptions}
    />
    </span>
    ),
    [cell.id, colorByLabel, colorByValue, colorByOptions, stores],
  )
  const colorByButton = dense ? colorByRender : undefined
  // LEFT-side extra: only the color-by picker (link-scale + graph-overlay toggles removed). It rides
  // in PaneToolbar's PINNED left group beside the plot-kind Select and never folds, so it needs no
  // flattened row twin — the `colorByMenu` rows that existed only to survive folding are gone, and
  // with them the entire nested-popup class: a kit Select popup (z-[60]) inside the overflow kit
  // Popover (z-[70]) painted UNDER its own parent and swallowed the click (convergence-2 HIGH).
  // Passed bare, not fragment-wrapped: `<>{maybeNull}</>` is a truthy React ELEMENT even when it
  // renders nothing, which is how the old "does this hold a popup" inference misfired on every
  // chart pane (convergence-3 HIGH). No such inference exists now — the pin is structural, and
  // `undefined` (not `null`) on a chart pane keeps "is there a colour-by at all" a plain
  // presence check that no JSX shape can fake.
  const extra = colorByButton
  // The five OPTIONAL per-pane entry points. Each was an inline `cb ? () => cb(id) : undefined`,
  // i.e. a fresh function on every render whenever the capability was present — five of the twelve
  // identity churns. `useMemo` (not `useCallback`) because the value is conditionally `undefined`,
  // and `undefined` is itself meaningful here: PaneToolbar treats presence as the capability check.
  const onEdit = useCallback(() => onEditCell?.(cell.id), [onEditCell, cell.id])
  const onAnnotate = useMemo(
    () => (onAnnotateCell ? () => onAnnotateCell(cell.id) : undefined),
    [onAnnotateCell, cell.id],
  )
  const onSegment = useMemo(
    () => (onSegmentCell ? () => onSegmentCell(cell.id) : undefined),
    [onSegmentCell, cell.id],
  )
  const onToggleLinkCb = useMemo(
    () => (onToggleLink ? () => onToggleLink(cell.id) : undefined),
    [onToggleLink, cell.id],
  )
  const onExport = useMemo(
    () => (onExportCell ? () => onExportCell(cell.id) : undefined),
    [onExportCell, cell.id],
  )
  const onShowDataCb = useMemo(
    () => (onShowData ? () => onShowData(cell.id) : undefined),
    [onShowData, cell.id],
  )
  // Shell redesign: the per-pane top TOOLBAR (occupied-space) replaces the old floating CellChrome pill.
  // Right group order is fixed by PaneToolbar: Edit · Download · Split · New window(rightExtra) · Close.
  const toolbar = showToolbar ? (
    <PaneToolbar
      cell={cell}
      catalog={catalog}
      onSetKind={setKind}
      onSplit={splitCol}
      onRemove={remove}
      onEdit={onEdit}
      editOpen={editOpen}
      onAnnotate={onAnnotate}
      annotateOpen={annotateOpen}
      onSegment={onSegment}
      segmentOpen={segmentOpen}
      onToggleLink={onToggleLinkCb}
      linkColor={linkColor}
      linkActive={linkActive}
      onExport={onExport}
      onShowData={onShowDataCb}
      dataOpen={dataOpen}
      gripHandlers={gripHandlers}
      extra={extra}
      rightExtra={popoutButton}
    />
  ) : null
  return (
    <div
      ref={rootRef}
      // TWO IDENTITIES, TWO CHANNELS. `data-testid` is what a READER addresses — the id the
      // declaration wrote (`cellTestId`). `data-cell-id` is the GRID's own key, which a composing
      // host namespaces and which the cross-window drag below recovers off these very elements to
      // feed `swapCells` / `movePane`. They used to be the same attribute, which is how a host's
      // internal composition key ended up in every spec that addressed a pane.
      data-testid={`viz-cell-view-${testId}`}
      data-cell-id={cell.id}
      {...(cell.ownerId ? { 'data-cell-owner': cell.ownerId } : {})}
      data-cell-kind={cell.kind}
      // With a toolbar the cell is a flex COLUMN: [toolbar 32px][plot body]. The toolbar OCCUPIES its
      // strip (deck view inset by GridWorkspace), the body holds the plot. Root is pointer-transparent
      // so pan falls through everywhere except the toolbar (which re-arms it) + a non-passthrough body.
      style={showToolbar ? { ...style, display: 'flex', flexDirection: 'column', pointerEvents: 'none' } : style}
    >
      {toolbar}
      <div
        style={{
          overflow: 'hidden',
          ...(showToolbar ? { position: 'relative', flex: 1, minHeight: 0 } : { position: 'absolute', inset: 0 }),
          pointerEvents: passThrough ? 'none' : 'auto',
          // Legend "beside" gutter: reserve space on one side so the chart body (ChartCanvas) shrinks to
          // match the shared-deck view; the legend overlay renders in the freed strip. No-op for dense
          // cells (nothing renders here — the deck draws through) but harmless.
          ...gutterPadding(plotGutter),
        }}
      >
        {/* Dense (scatter/image) + shared-deck charts render on the container's shared deck (nothing here,
            deck shows through); a non-migrated chart cell hosts its own ChartBody in this body area. */}
        {dense ? null : (
          <ChartBody cell={cell} source={source} catalog={catalog} coordination={coordination} />
        )}
        {/* Tear-off pop-up-blocked prompt: Retry opens from a real click (a valid gesture). */}
        {tearoffBlocked && (
          <TearOffBlockedPrompt
            paneId={testId}
            onRetry={attemptTearOff}
            onDismiss={() => setTearoffBlocked(false)}
          />
        )}
      </div>
      {/* Drop indicator — VISUAL ONLY, covers the WHOLE cell (matches the rect the resolver hit-tests).
          When this cell is the current drop target, shows a "+"-cross of 5 zones with the active arm lit
          + a translucent preview of where the dragged plot will land (edge = that half; center = swap). */}
      {isDropTarget && <DropZoneCross paneId={testId} zone={activeZone} />}
    </div>
  )
}

/** The "+"-cross drop indicator drawn over the current drop-target cell: a translucent LANDING PREVIEW
 *  (the half the plot will occupy, or the whole cell for a center swap) plus a centered 5-tile "+" whose
 *  active tile is filled. Purely presentational + pointer-transparent — the drag hit-test is done by the
 *  window-level pointer lifecycle, not this overlay.
 *
 *  `paneId` is the pane's DOM identity (`cellTestId`), not the grid key. It is used for nothing but
 *  testids, and this component takes no part in the hit-test that needs the invertible id — so
 *  passing the key here would put the host's fold separator in a testid for no consumer at all. */
function DropZoneCross({ paneId, zone }: { paneId: string; zone: DropZone | null }) {
  // The landing-preview rectangle for each edge (fractions of the cell); center = the whole cell (swap).
  const preview: CSSProperties =
    zone === 'left'
      ? { left: 0, top: 0, width: '50%', height: '100%' }
      : zone === 'right'
        ? { left: '50%', top: 0, width: '50%', height: '100%' }
        : zone === 'top'
          ? { left: 0, top: 0, width: '100%', height: '50%' }
          : zone === 'bottom'
            ? { left: 0, top: '50%', width: '100%', height: '50%' }
            : { inset: 0 } // center → swap: preview the whole cell
  const tile = (z: DropZone, gridArea: string) => (
    <div
      data-testid={`viz-drop-tile-${paneId}-${z}`}
      data-active={zone === z}
      style={{
        gridArea,
        borderRadius: 3,
        border: '1px solid rgba(59,130,246,0.9)',
        background: zone === z ? 'rgba(59,130,246,0.95)' : 'rgba(59,130,246,0.18)',
      }}
    />
  )
  return (
    <div
      data-testid={`viz-cell-droptarget-${paneId}`}
      data-drop-active={true}
      data-drop-zone={zone ?? ''}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none', outline: '2px solid rgba(59,130,246,0.5)', outlineOffset: -2 }}
    >
      {/* landing-preview tint */}
      <div style={{ position: 'absolute', ...preview, background: 'rgba(59,130,246,0.12)', transition: 'all 60ms ease' }} />
      {/* the centered 5-tile "+" cluster */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 22px)',
          gridTemplateRows: 'repeat(3, 22px)',
          gap: 3,
        }}
      >
        {tile('top', '1 / 2 / 2 / 3')}
        {tile('left', '2 / 1 / 3 / 2')}
        {tile('center', '2 / 2 / 3 / 3')}
        {tile('right', '2 / 3 / 3 / 4')}
        {tile('bottom', '3 / 2 / 4 / 3')}
      </div>
    </div>
  )
}

/** Shown over a cell when a drag-to-tear-off could not open the window (pop-up blocked, or the
 *  dragend didn't grant window.open a user gesture). Retry opens from a real click (a valid gesture). */
function TearOffBlockedPrompt({
  paneId,
  onRetry,
  onDismiss,
}: {
  /** the pane's DOM identity (`cellTestId`) — testids + the announced name only. */
  paneId: string
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid={`viz-tearoff-blocked-${paneId}`}
      role="alertdialog"
      aria-label={`Pop-up blocked for ${paneId}`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        display: 'grid',
        placeItems: 'center',
        padding: 12,
        background: 'rgba(24,24,24,0.92)',
        color: '#fff',
        font: '12px system-ui, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'grid', gap: 8, placeItems: 'center', textAlign: 'center', maxWidth: 260 }}>
        <span style={{ fontWeight: 600 }}>Pop-up blocked</span>
        <span style={{ opacity: 0.8 }}>
          Allow pop-ups for this site in your browser, then Retry to open this pane in its own window.
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            data-testid={`viz-tearoff-retry-${paneId}`}
            onClick={onRetry}
            style={POPOUT_BTN_STYLE}
          >
            Retry
          </button>
          <button
            type="button"
            data-testid={`viz-tearoff-dismiss-${paneId}`}
            onClick={onDismiss}
            style={POPOUT_BTN_STYLE}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Dispatch a CHART cell to its registered View (EXTENSIBILITY_STUDY Part 6 STEP 2). This
 * replaces the exhaustive `switch (cell.kind)`: resolve the cell's `kind` in the chart-type
 * REGISTRY and render its `view` with the uniform `ChartViewProps`, where the resolved
 * `model` is produced GENERICALLY by the descriptor's own `model()` — the core never knows
 * this chart's binding shape (that lives in the descriptor's `bindingSchema`). A registry
 * MISS (an unregistered kind) renders the visible "unsupported kind" fallback and never
 * crashes — identical to the old switch's `default`, and to the fallback the old switch
 * produced for the dense (scatter/image) + nested (grid) kinds, which the registry backs
 * with the same `Unsupported` adapter.
 *
 * EXPORTED for the render tests only. It is the whole chart-dispatch decision — registry
 * miss, refused binding, or the View — and a test that asserts what a user SEES has to mount
 * it. Mounting the enclosing `CellView` instead would drag in deck, the pane rect and the
 * workspace stores to reach the same three-way branch (`B7`: verification means RUNNING it,
 * and a mocked stand-in does not cover what actually renders).
 */
export function ChartBody({
  cell,
  source,
  catalog,
  coordination,
}: {
  cell: GridCell
  source: DataSource
  catalog: DatasetCatalog
  coordination: CoordinationHandle
}): ReactNode {
  const desc = getChartType(cell.kind)
  if (!desc) return <Unsupported kind={cell.kind} />
  // A cell threaded with resolved encode `bindings` (from the declarative controller) resolves
  // its model with those bindings as a per-channel OVERRIDE over the catalog defaults, so the
  // DECLARED encode reaches render. Resolved via the descriptor's own `bindingSchema` (the same
  // schema its `model()` closes over), so for a built-in it is byte-identical to
  // `desc.model(cell, { catalog })` plus the override. No bindings (imperative / default path)
  // ⇒ the descriptor's own `model()`, unchanged.
  const model: ChartModel = cell.bindings
    ? makeChartModel(cell, desc.bindingSchema ?? [], catalog, cell.bindings)
    : desc.model(cell, { catalog })
  // ── A REQUIRED CHANNEL THAT REFUSED IS SHOWN, NOT GUESSED AROUND (INV-3) ────────────────
  //
  // The resolver no longer answers an undecidable channel with catalog position 0 or with a
  // conventional column NAME, so a chart can now arrive here with a required binding nobody
  // could decide. Painting it anyway is what this whole change removes; painting NOTHING is
  // the same silence one layer over. So the pane says which channel it could not decide and
  // which columns qualify, and the cell's existing column picker is the action.
  //
  // GATED ON THE RESOLUTION, NOT ON `bindings[id] === undefined` — the shorter test, and a
  // vacuous one: a channel that is DELIBERATELY unbound (an author's explicit `''`) is also
  // absent from `bindings`, so `!bindings[id]` cannot tell a refusal from a choice, and would
  // put this message over every legitimately ungrouped chart (INV-5).
  //
  // OPTIONAL channels are excluded: `BindingChannel.optional` exists precisely because a chart
  // is meaningful without them — a distribution needs a value column, a grouping merely splits
  // it — and "ungrouped" is the honest render for an undecided grouping, not an error.
  const unboundReasons = (desc.bindingSchema ?? [])
    .flatMap(ch => {
      if (ch.optional) return []
      // OPTIONAL CHAIN, deliberately: `resolutions` is a NEW required field on the public
      // `ChartModel`, and a HOST-registered descriptor whose `model()` predates it returns a
      // model without one. Dereferencing it unguarded turned an extension that used to draw
      // into a render-time TypeError — a public seam broken by a field the host never heard
      // of. Absent resolutions ⇒ no refusal known ⇒ render, exactly as that descriptor did.
      const refusal = asRefusal(model.resolutions?.[ch.id])
      // ONE decision, and the type carries it: `refusalMessage` does not accept a resolution
      // that did not refuse, so this cannot silently start speaking for a deliberate `''`.
      return refusal ? [refusalMessage(ch.label, refusal)] : []
    })
  if (unboundReasons.length > 0) return <ChartUnbound reasons={unboundReasons} />
  const View = desc.view
  // ENFORCED coordination capabilities (Area B, ITEM-4): resolve each as
  // `cell.<flag> ?? descriptor.capabilities.<flag>` and thread it onto the uniform props. A cell
  // stamped by `parseOption` carries the effective value; an imperative cell (no stamp) falls back
  // to the descriptor's declared capability — either way the View reads ONE resolved value. All
  // `undefined` (a chart with no declared capability) ⇒ the View's today-behavior (byte-identical).
  const caps = desc.capabilities
  const consumesSelection = cell.consumesSelection ?? caps?.consumesSelection
  const producesSelection = cell.producesSelection ?? caps?.producesSelection
  const dataZoomAxes = cell.dataZoomAxes ?? caps?.dataZoomAxes
  // `linkableColorScale` is enforced in parse.ts (not View-read), so it is NOT threaded here.
  // GIVE THIS CHART CELL ITS STABLE dataZoom/filter id (ITEM-20 / DEC-16): publish the cell's own id
  // (= its coord id) through `PlotCellIdContext` so the dispatched View's `ValueDataZoom` /
  // `DataZoomMatrix` keys the PlotInteraction store by it — connecting the cell to the store so a
  // restored `dataZoom.window` / `filters` actually applies (was a NO-OP: cells ran pure local
  // `useState`). The id flows THROUGH the registry adapter (which renders the View inside this
  // provider) with no adapter change. `cellPlotId` guards an empty id → `undefined` → the View keeps
  // its byte-identical local-state default.
  return (
    <PlotCellIdContext.Provider value={cellPlotId(model.cell.id)}>
      <View
        model={model}
        source={source}
        catalog={catalog}
        coordination={coordination}
        consumesSelection={consumesSelection}
        producesSelection={producesSelection}
        dataZoomAxes={dataZoomAxes}
      />
    </PlotCellIdContext.Provider>
  )
}


/** Shared style for the tear-off-blocked prompt's Retry / Dismiss buttons — the translucent
 *  over-the-plot styling the deleted chrome pill used, kept because this prompt still paints
 *  over a pane rather than in the toolbar strip. */
const POPOUT_BTN_STYLE: CSSProperties = {
  font: '12px system-ui, sans-serif',
  lineHeight: 1,
  minWidth: 20,
  height: 20,
  padding: '0 6px',
  background: 'rgba(0,0,0,0.35)',
  color: '#fff',
  border: '1px solid rgba(128,128,128,0.5)',
  borderRadius: 4,
  cursor: 'pointer',
}

// Two more constants stood here — `GRAPH_BTN_ACTIVE_STYLE` (the graph-overlay toggle) and
// `COLORBY_SELECT_STYLE` (a native `<select>`'s chrome-height styling) — plus a doc comment for a
// drag ghost this file no longer owns (`@txresbench/dock`'s `useGripDrag` re-homes it). All three
// outlived their consumers: the graph toggle was removed from the pane chrome, the colour-by picker
// became a kit `<Select>` styled by className, and the ghost moved packages. None was referenced,
// and a style constant nothing renders is §15 dead code, so they are deleted with the pill they
// were sized to match rather than left as a plausible-looking place to add a fourth.

/** ITEM-1 / INV-2. `GridWorkspace` re-renders on every camera frame, and its `rects.map` rebuilds
 *  one `<CellView>` per pane — measured at 8 `CellView` element creations per wheel step on a
 *  4-pane grid, each dragging ~580 elements of pane chrome behind it.
 *
 *  The memo pays only because `plotGutter` was FLATTENED first: `legendGutterFor(cell)` returns a
 *  fresh `{ w, side }` literal per call, and that single prop was enough to make the shallow
 *  comparator report a difference on every frame. All 25 other props at the call site were already
 *  a `useCallback` / `useMemo` / store / primitive identity (re-verified at re-plan time), which is
 *  why one flatten plus this line is the whole of ITEM-1.
 *
 *  NAME PINNED because the counter leg keys on component names: without it, `memo(CellViewImpl)`
 *  would report as `CellViewImpl` and INV-1's "CellView element creations = 0" would become a
 *  budget satisfiable by a RENAME instead of by a fix.
 *
 *  Default shallow comparison, no custom `arePropsEqual` — see the note on `PaneToolbar`. Forgetting
 *  to update a hand-written comparator when a prop is added produces a STALE PANE (a dropped
 *  `editOpen` / `annotateOpen` / `segmentOpen` / `dataOpen` transition, INV-8), and no perf counter
 *  in this feature can see that. The default degrades by re-rendering too often, never too little. */
CellViewImpl.displayName = 'CellView'
export const CellView = memo(CellViewImpl)
CellView.displayName = 'CellView'
