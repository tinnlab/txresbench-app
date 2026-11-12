// useGridWindows.ts — SPLIT M (ITEM-29): the grid's DOCK / POPOUT-WINDOW plane.
//
// DEC-26's census row "dock + popout windows (restore, resize observer, `renderPopupContainer`,
// export request)" (210), moved verbatim out of `GridWorkspace`: the PORTAL_DOCKING popup-container
// set and its close handshake (`popupContainers`, `handleWindowClosed`, `handleAckClose`, and the
// `subscribePopupWindows` external-store subscription), the session-restore choice (`pendingRestore`,
// `handleMergeRestored`, `handleReopenRestored`), the aim-to-place session (`pendingPlacement` and
// the `startGripPlacement` effect with its abort-on-unmount cleanup), the POPUP-REALM canvas sizing
// effect, the dock-handle wrappers (`dockApiRef`, `openExportCell`, `openExportGrid`), and the
// per-cell export request.
//
// It is ONE plane because every member is about a pane living somewhere OTHER than the primary
// grid: a popup window, a restored-but-unopened window, a cursor-aimed destination container, or a
// dock surface the layer owns and the shell only opens. `containerId !== PRIMARY_CONTAINER` is the
// predicate three of the six regions branch on.
//
// `renderPopupContainer` is named in the census row and deliberately did NOT come. It renders
// `<GridWorkspace>` — it IS the recursion point — so a hook that owned it would have to import the
// shell that imports it. That is a module cycle and, worse, it would make this plane a path between
// the shell and itself. The recursive mount stays in the shell; asserted, so its absence here reads
// as a decision rather than an oversight.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a fifth time). Nothing here would become state in a store;
// `popupContainers` is a `useMemo` over a store read, the five callbacks are `[]`- or `[stores]`-
// stable, and `openExportCell` in particular MUST stay `[]`-stable because it is a `<CellView>` prop
// and `memo(CellView)` is what keeps the chrome off the camera path (INV-1/INV-2) — a store-backed
// rewrite would rebind it and TEST-P1 would see the chrome renders immediately.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `paneContainer` / `pendingClose` / `pendingRestore` / `pendingPlacement`
//                           NOT state this plane owns — `useStore` READS of `stores.gridWorkspace`.
//                           Every writer (`returnPaneToGrid`, `acknowledgeContainerClose`,
//                           `mergeRestoredToPrimary`, `resolveRestored`, `placeNewCell`,
//                           `cancelPlacement`, `requestAddCell`) is a store action outside this
//                           module and stays there. Moving a read cannot strand a writer, so `tsc`
//                           IS complete for these.
//   `dockApiRef`            declared here and RETURNED. Its one WRITER is `GridDockLayer`, which
//                           receives it as a `ref` prop from the shell — a prop is typed, so `tsc`
//                           sees it, but no `grep` of this module does, which is why it is named.
//   `activeCellRef`         NOT moved. `requestExportCell` WRITES it, but so does the selection
//                           plane's draw attribution, and the seam publishes it. Split I already
//                           refused to move it for this reason; this split is its second reader and
//                           borrows it the same way.
//   `containerRef` / `deckRef` / `restoreKey`
//                           NOT moved. The popup-realm resize effect READS all three; the shell
//                           declares `containerRef` (nine other readers) and `deckRef`, and
//                           `restoreKey` comes from `useCanvasRecovery`. Borrowed, not taken.
//   `perCellLegend` / `perCellRange` / `perCellHiddenCodes`
//                           NOT moved — `cellDisplay` / `plotInteraction` reads that belong to the
//                           display pipeline. `requestExportCell` is their second reader.
//
// NO DEV WINDOW SEAM is installed from this module. Checked, not assumed.
//
// EFFECT ORDER (DRIFT-41's class, second occurrence). Three effects move: the popup-window
// external-store subscription, the aim-to-place session, and the popup-realm canvas sizing. They
// registered at three different positions in the shell's effect list and now register together at
// this hook's call position, which is LATER. All three are gated on a container that is not the
// primary grid, or on a `pending*` store field that is null on the primary grid, so on the main grid
// they are no-ops in any order. The acceptance evidence is the four popout drivers, which are the
// only things that can observe it.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'
import { useStore } from 'zustand'
import { PRIMARY_CONTAINER, startGripPlacement, isPlacementActive, abortGripPlacement, subscribePopupWindows, getPopupWindowsSnapshot, unregisterPopupWindow, registerPopupWindow, type ContainerId, type DragRect, type DropTarget } from '@txresbench/dock'
import { buildPopupFeatures, centeredGeometry } from '../popout/windowPortalCore'
import type { VizStores } from '../../adapter/vizStores'
import type { GridCell, GridDockApi } from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { CellLegend } from '../../adapter/CellDisplay.store'
import type { ColorBy } from '../data/engine'


export interface GridWindowsInputs {
  readonly stores: VizStores
  readonly containerId: ContainerId
  /** Shell-owned: the workspace root element. Nine other readers, so borrowed rather than taken. */
  readonly containerRef: RefObject<HTMLDivElement | null>
  /** Shell-owned: the `<DeckGL>` imperative handle the popup-realm resize effect drives. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly deckRef: RefObject<any>
  /** From `useCanvasRecovery` — the popup resize effect re-arms when the deck remounts. */
  readonly restoreKey: number
  readonly denseRects: readonly PaneRect[]
  /** Shell-owned (Split I refused to move it): `requestExportCell` is its SECOND writer. */
  readonly activeCellRef: RefObject<string | null>
  readonly denseCellsRef: RefObject<readonly GridCell[]>
  readonly perCellLegend: Record<string, CellLegend>
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly perCellHiddenCodes: Record<string, Set<number>>
  readonly onRequestExportCell:
    | ((cellId: string, colorBy?: ColorBy, visual?: { range?: [number, number]; hidden?: number[] }) => void)
    | undefined
}

export function useGridWindows({
  stores,
  containerId,
  containerRef,
  deckRef,
  restoreKey,
  denseRects,
  activeCellRef,
  denseCellsRef,
  perCellLegend,
  perCellRange,
  perCellHiddenCodes,
  onRequestExportCell,
}: GridWindowsInputs) {
  // ── PORTAL_DOCKING: popup containers rendered by ContainerWindows (grid container only) ──────────
  const paneContainer = useStore(stores.gridWorkspace, s => s.paneContainer)
  const pendingClose = useStore(stores.gridWorkspace, s => s.pendingClose)
  // Re-render when a popup window registers/unregisters (so ContainerWindows mounts/tears its portal).
  useSyncExternalStore(subscribePopupWindows, getPopupWindowsSnapshot, getPopupWindowsSnapshot)
  const popupContainers = useMemo(
    () =>
      [...new Set(Object.values(paneContainer))].filter(
        (id): id is ContainerId => id !== PRIMARY_CONTAINER,
      ),
    [paneContainer],
  )
  const handleWindowClosed = useCallback(
    (id: ContainerId) => {
      // OS/Return close: return every pane in that container to the grid.
      const cc = stores.gridWorkspace.getState().paneContainer
      for (const cellId of Object.keys(cc)) {
        if (cc[cellId] === id) stores.gridWorkspace.getState().returnPaneToGrid(cellId)
      }
    },
    [stores],
  )
  const handleAckClose = useCallback(
    (id: ContainerId) => {
      unregisterPopupWindow(id)
      stores.gridWorkspace.getState().acknowledgeContainerClose(id)
    },
    [stores],
  )

  // ── Session-restore choice (P5) ──────────────────────────────────────────────────────────────────
  // A restored snapshot with popups can't reopen their windows on reload (no user gesture) — the store
  // lists them in `pendingRestore` and the main grid shows a choice dialog: MERGE the panes into the
  // main, or REOPEN their windows (this click IS the gesture). Reopen is best-effort per window; the
  // browser may cap multiple `window.open`s to one per gesture, so only the windows that actually
  // opened are drained (the rest stay pending for a retry / merge — nothing is lost).
  const pendingRestore = useStore(stores.gridWorkspace, s => s.pendingRestore)
  const handleMergeRestored = useCallback(() => {
    stores.gridWorkspace.getState().mergeRestoredToPrimary()
  }, [stores])
  const handleReopenRestored = useCallback(() => {
    if (typeof window === 'undefined') return
    const opened: ContainerId[] = []
    for (const id of stores.gridWorkspace.getState().pendingRestore) {
      const features = buildPopupFeatures(
        centeredGeometry(960, 720, window.screen?.width ?? 1440, window.screen?.height ?? 900),
      )
      const w = window.open('about:blank', id, features)
      if (w) {
        registerPopupWindow(id, w)
        opened.push(id)
      }
    }
    stores.gridWorkspace.getState().resolveRestored(opened)
  }, [stores])

  // ── Aim-to-place a new plot (P5) ─────────────────────────────────────────────────────────────────
  // `requestAddCell` with a popup open sets `pendingPlacement`; the MAIN grid then arms the dock
  // placement session (a per-window preview that follows the cursor across windows). A click places the
  // new plot into whatever container the cursor is over; Escape discards it. The reactive drag-state's
  // `mode === 'placement'` drives the reminder overlay + reuses the P4 drop-target highlights.
  const pendingPlacement = useStore(stores.gridWorkspace, s => s.pendingPlacement)
  useEffect(() => {
    if (containerId !== PRIMARY_CONTAINER || !pendingPlacement) return
    const kind = pendingPlacement.kind
    const started = startGripPlacement({
      snapshot: (win: Window) => {
        const container = win.document.querySelector('[data-testid="viz-grid-workspace"]')
        if (!container) return null
        // `data-cell-id`, not the testid — these ids go straight into `placeNewCell`, so they must
        // be the grid's own key. On a composed grid the testid is the AUTHORED id (see `CellView`).
        const panes: DragRect[] = Array.from(container.querySelectorAll('[data-cell-id]')).map(el => ({
          id: el.getAttribute('data-cell-id') as string,
          rect: el.getBoundingClientRect(),
        }))
        return { panes, containerRect: container.getBoundingClientRect() }
      },
      onPlace: target => {
        const dropTarget: DropTarget = target.overPaneId
          ? { kind: 'split', atLeaf: target.overPaneId, dir: target.dir }
          : { kind: 'root' }
        stores.gridWorkspace.getState().placeNewCell(target.container as ContainerId, dropTarget, kind)
      },
      onDiscard: () => stores.gridWorkspace.getState().cancelPlacement(),
      ghostLabel: `New ${kind}`,
      ghostTestId: 'viz-placement-ghost',
    })
    // Couldn't arm (no window / already active) AND no placement is running → don't strand the request.
    if (!started && !isPlacementActive()) {
      stores.gridWorkspace.getState().cancelPlacement()
      stores.gridWorkspace.getState().addCell('col', kind)
    }
    // If THIS effect armed a placement, abort it on unmount-mid-aim (else the module session leaks its
    // window listeners + ghost). In the normal place/discard flow the session has already ended by the
    // time this runs, so `isPlacementActive()` is false → no-op. `requestAddCell` ignores a 2nd request
    // while one is pending, so a live placement is never torn down by a deps-change re-run.
    return () => {
      if (started && isPlacementActive()) abortGripPlacement()
    }
  }, [pendingPlacement, containerId, stores])

  // ── POPUP-realm canvas sizing (PORTAL_DOCKING) ─────────────────────────────
  // deck.gl sizes its canvas's DRAWING BUFFER through luma.gl's internal auto-resize (a ResizeObserver
  // on the canvas + DPR/window listeners). That observer is created in the OPENER window's JS realm, so
  // it CANNOT observe a canvas that lives in a POPUP document — the popup deck never sizes its backing
  // store and keeps deck's 300×150 default buffer CSS-stretched over the (e.g. 960×720) pane, which
  // reads as a static low-res image. For a popup container we therefore drive the `Deck` instance's
  // resize OURSELVES, measured from the CONTAINER'S OWN realm (the popup window's ResizeObserver + its
  // `resize` event) and pushed straight onto deck's luma CanvasContext + a forced redraw. The MAIN grid
  // (PRIMARY_CONTAINER) leaves deck's native same-realm auto-resize untouched → byte-identical.
  useEffect(() => {
    if (containerId === PRIMARY_CONTAINER) return
    const container = containerRef.current
    const view = container?.ownerDocument.defaultView
    if (!container || !view) return

    const syncPopupCanvas = (): boolean => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deck: any = deckRef.current?.deck
      if (!deck || !deck.isInitialized) return false
      // luma.gl CanvasContext — owns the CSS-size + drawing-buffer bookkeeping deck reads back.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cc: any = deck.device?.getDefaultCanvasContext?.() ?? deck._canvasContext
      const canvas: HTMLCanvasElement | null = deck.getCanvas?.() ?? null
      if (!cc || !canvas) return false
      const w = Math.floor(container.clientWidth)
      const h = Math.floor(container.clientHeight)
      if (w <= 1 || h <= 1) return false
      const dpr = view.devicePixelRatio || 1
      const bufW = Math.floor(w * dpr)
      const bufH = Math.floor(h * dpr)
      // Feed the CSS size deck reads via `getCSSSize()` (what the missing ResizeObserver would have set).
      cc.cssWidth = w
      cc.cssHeight = h
      // Public API: queue the physical drawing-buffer resize (applied at the next redraw).
      cc.setDrawingBufferSize?.(bufW, bufH)
      // Mirror the new CSS size into deck's viewport (updates viewManager + marks needs-redraw)…
      deck._onCanvasContextResize?.(cc)
      // …then force the redraw so the backing store is actually resized this frame.
      deck.redraw?.('popup-resize')
      // Converged once the backing store reflects the target (guards the async device-init race).
      return canvas.width >= bufW && canvas.height >= bufH
    }

    // Retry across frames until async device init completes AND the first sync sticks.
    let raf = 0
    let tries = 0
    const pump = () => {
      if (syncPopupCanvas() || tries++ > 240) {
        raf = 0
        return
      }
      raf = view.requestAnimationFrame(pump)
    }
    pump()

    // Keep sizing on later container / popup-window resizes — both observed from the popup realm.
    const ro =
      typeof view.ResizeObserver !== 'undefined' ? new view.ResizeObserver(() => syncPopupCanvas()) : null
    ro?.observe(container)
    const onWinResize = () => syncPopupCanvas()
    view.addEventListener('resize', onWinResize)

    return () => {
      if (raf) view.cancelAnimationFrame(raf)
      ro?.disconnect()
      view.removeEventListener('resize', onWinResize)
    }
    // Re-arm when the deck remounts (context-loss `restoreKey`) or the dense deck (un)mounts.
  }, [containerId, restoreKey, denseRects.length])

  // SPLIT C (ITEM-17): `exportTarget` itself now lives in `GridDockLayer` — it is the one of ITEM-17's
  // six open-set states whose every READ is in that file. Its two OPENERS still render here (a pane
  // toolbar's Export button via `<CellView>`, and the tool rail's whole-grid Export), so they reach it
  // through this `[]`-stable wrapper over the layer's handle — the same shape Split B uses for the
  // shell's four draft-reset sites. `[]`-stable matters: `openExportCell` is a `<CellView>` prop and
  // `memo(CellView)` is what keeps the chrome off the camera path (INV-1/INV-2).
  const dockApiRef = useRef<GridDockApi | null>(null)
  const openExportCell = useCallback((cellId: string) => {
    dockApiRef.current?.openExportCell(cellId)
  }, [])
  const openExportGrid = useCallback(() => dockApiRef.current?.openExportGrid(), [])

  // Per-cell export (ITEM-47 follow-up): clicking cell X's ⤓ button marks X as the
  // active/export-target cell (reusing `activeCellRef`, the same ref the selection draw
  // uses to attribute a pane) so the host's `paneRect()` resolution can point at X, then
  // asks the host to open its ExportDialog scoped to that pane. When `onRequestExportCell`
  // is absent, CellView omits the button entirely (back-compat), so this is never reached.
  // FIX_ROUND-1 / B1 — the three per-cell records and the host callback are read through RENDER-
  // ASSIGNED REFS, so `requestExportCell` below can be `[]`-stable like its `openExportCell` sibling.
  //
  // It was `useCallback(…, [onRequestExportCell, perCellLegend, perCellRange, perCellHiddenCodes])`.
  // All three records are WHOLE-RECORD store reads: ANY cell's legend / visual-map range / hidden-code
  // change re-mints all three and therefore this callback. It descends as `onExportCell` into
  // `GridPaneCell -> CellView -> PaneToolbar`, where it is a memo-boundary prop — so ONE pane's legend
  // click rebuilt the chrome of EVERY pane, defeating Split D/0b's per-cell isolation grid-wide on
  // exactly the paths those two stores exist to serve. `onRequestExportCell` is the same defect from
  // the host side: the shipping app passes an INLINE ARROW
  // (ui/src/modules/visualization/adapter/VisualizationPage.tsx), so it churns on every host render.
  //
  // "Is a useCallback" is not "has a stable identity" — PLAN_AUDIT.md:226's claim that `plotGutter`
  // was the SOLE referentially-unstable prop at that boundary rested on that conflation.
  //
  // Refs, not a `useEvent` shim: this file already uses render-assigned mirrors for exactly this
  // (`denseCellsRef`), and every read below happens at CLICK time, where a ref is as fresh as a dep.
  const perCellLegendRef = useRef(perCellLegend)
  perCellLegendRef.current = perCellLegend
  const perCellRangeRef = useRef(perCellRange)
  perCellRangeRef.current = perCellRange
  const perCellHiddenCodesRef = useRef(perCellHiddenCodes)
  perCellHiddenCodesRef.current = perCellHiddenCodes
  const onRequestExportCellRef = useRef(onRequestExportCell)
  onRequestExportCellRef.current = onRequestExportCell

  const requestExportCell = useCallback(
    (cellId: string) => {
      activeCellRef.current = cellId
      // Pass the cell's colorBy so the host can resolve its legend for the export (DEC-1).
      const colorBy = (denseCellsRef.current.find(c => c.id === cellId)?.colorBy as ColorBy | undefined) ?? undefined
      // WYSIWYG (ITEM-13): pass the cell's LIVE in-cell visual-map state so the exported figure
      // shows the SAME value-range window / hidden categories as the on-screen cell.
      const lg = perCellLegendRef.current[cellId]
      const rng = perCellRangeRef.current[cellId]
      const dom = lg?.domain ?? (lg?.descriptor.kind === 'continuous' ? lg.descriptor.domain : undefined)
      // Copied to a MUTABLE tuple: the range now comes from the PlotInteraction store (readonly), while
      // the host's `onRequestExportCell` contract is unchanged.
      const strictRange: [number, number] | undefined =
        rng && dom && (rng[0] > dom[0] || rng[1] < dom[1]) ? [rng[0], rng[1]] : undefined
      const hiddenSet = perCellHiddenCodesRef.current[cellId]
      const hidden = hiddenSet && hiddenSet.size > 0 ? [...hiddenSet] : undefined
      onRequestExportCellRef.current?.(cellId, colorBy, strictRange || hidden ? { range: strictRange, hidden } : undefined)
    },
    [],
  )

  return {
    popupContainers,
    handleWindowClosed,
    handleAckClose,
    pendingClose,
    pendingRestore,
    handleMergeRestored,
    handleReopenRestored,
    dockApiRef,
    openExportCell,
    openExportGrid,
    requestExportCell,
  }
}
