// useGridAnnotate.ts — SPLIT J (ITEM-26): the grid's ANNOTATE plane.
//
// Everything that owns an `AnnotateStore`, drives the in-grid annotation EDITOR, or exposes the
// external PROCESSOR port, moved verbatim out of `GridWorkspace`: the per-cell store map + its
// subscribe/teardown reconcile (`annotateStoresRef`, `annotateUnsubsRef`, `annotateEpoch`,
// `ensureAnnotateStore`, `annotateCellsKey`), the per-pane dock bindings (`annotateCellIds`,
// `annotateMode`, `close`/`toggleAnnotateCell` — the shell's `openAnnotateCell` had ZERO readers
// after Split D and is deleted rather than carried here unused, DRIFT-46), the gesture binding
// (`gestureAnnotateCellRef` + its reactive `boundAnnotateCellId` mirror, `fallbackAnnotateStore`,
// `annotateStoreFor`,
// `boundAnnotateStore`), the screen→world `annotateUnproject`, the `useAnnotateEditor` mount and its
// `annotateEditDraftRef`, the DEC-8 eligibility reconcile, and the whole FB-17 P2 processor-port
// seam (`processorPortsRef`, its mint/teardown effect and its NF-7 unmount dispose).
//
// DEC-26's census row is "annotate stores / editor / processor ports" (266). It is ONE plane and not
// three: the processor port's `getActiveGesture` reads `annotateEditDraftRef` and
// `gestureAnnotateCellRef`, both of which the EDITOR half owns, and the port mint calls
// `ensureAnnotateStore`, which the STORES half owns. Cutting between them would put two refs and a
// factory on one side of a module boundary and their only readers on the other.
//
// SHAPE — a value bundle, for DEC-27/DEC-28's reason, applied a third time. `annotateStoresRef` is
// an ITEM-14 SEAM member that `GridDeckLayer` reads by object identity to compose the annotation
// layers on every `annotateEpoch` bump; it is declared here and RETURNED, so the shell's `seam` memo
// is byte-identical and the deck keeps reading the SAME map. `annotateEpoch` is already `useState`
// — a store would not make it state, it would only add a subscription between the store `subscribe`
// callback and the deck memo that already keys on it, i.e. one more commit per edit, which is what
// TEST-P5 measures.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `annotateStoresRef`     seam member (DEC-20). Declared here, RETURNED, and threaded back through
//                           the shell's destructure into the `seam` memo. Its only mutators are
//                           `ensureAnnotateStore` and the reconcile effect, both of which move.
//                           Read (never written) by `GridDeckLayer` through the seam context.
//   `annotateEpoch`         one writer set: the store `subscribe` callback and the reconcile, both
//                           moved. `GridDeckLayer` READS it as a prop and never writes it.
//   `gestureAnnotateCellRef` TWO writers and only one is here — `GridOverlayLayer.onAnnotatePointerDown`
//                           writes it (SPLIT B moved that writer into the overlay). It is therefore
//                           declared here and RETURNED to the shell, which passes it down exactly as
//                           before; the identity is unchanged, so the overlay's synchronous INV-13
//                           bind still lands on the ref this plane reads.
//   `boundAnnotateCellId`   same split: `setBoundAnnotateCellId` is passed to `GridOverlayLayer` as a
//                           prop. A prop is typed, so `tsc` sees it — named here because it is the
//                           one writer no `grep` of this module finds.
//   `processorPortsRef`     lexical; every mutator (mint, dispose-on-evict, unmount dispose) moves.
//   `isPrimaryWorkspace`    Not this plane's, and no longer the shell's either. This table used to say
//                           it stayed because "the mask plane's window-hook effect reads it too" — that
//                           effect is `useGridDevSeams.ts` as of SPLIT R (ITEM-34), and the const moved
//                           there with it. This plane never read it in the first place.
//
// DEV WINDOW SEAMS travel with the state they publish (HAZARD 1's second half): `__vizAnnotateStores`
// and `__vizProcessorPorts` are installed from inside this plane, because the maps they alias are
// declared here. Neither is a WRITER — both publish a ref the plane owns — so no writer crosses the
// boundary invisibly. This is the seam class Split G's `__vizSharedMasks` finding was about, checked
// rather than assumed.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useStore } from 'zustand'
import type { AnnotationEditDraft } from '../annotate/buildAnnotationLayers'
import { createAnnotateStore, type AnnotateStore } from '../annotate/Annotate.store'
import { useAnnotateEditor, type AnnotateEditorApi } from '../annotate/useAnnotateEditor'
import { createProcessorPort, type DisposableProcessorPort } from '../../adapter/createProcessorPort'
import { selectAnnotateMode, type createPaneDocksStore } from '../../adapter/PaneDocks.store'
import { cellVisibleWorldBounds, unprojectInCell, type ScreenPoint } from './gridSelection'
import type { GridCell, ImageEntry, PyramidEntry } from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { GridViewState } from './linkZoom'

type PaneDocksStore = ReturnType<typeof createPaneDocksStore>

export interface GridAnnotateInputs {
  readonly cells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly paneDocks: PaneDocksStore
  /** WebGL availability — `annotateActive` gates the overlay on it, and only on it. */
  readonly glOk: boolean
  readonly denseRectsRef: RefObject<readonly PaneRect[]>
  readonly viewStateRef: RefObject<Record<string, GridViewState>>
  /** Client→container-local screen coords. Shell-owned (the geometry DRIFT-25 pins there). */
  readonly toLocal: (e: { clientX: number; clientY: number }) => ScreenPoint
  readonly imagePyramidsRef: RefObject<Record<string, PyramidEntry | 'loading' | null>>
  readonly imageUnderlaysRef: RefObject<Record<string, ImageEntry | 'loading' | null>>
}

export interface GridAnnotate {
  readonly annotateStoresRef: RefObject<Map<string, AnnotateStore>>
  readonly annotateEpoch: number
  readonly ensureAnnotateStore: (cellId: string) => AnnotateStore
  readonly annotateCellIds: readonly string[]
  readonly annotateMode: boolean
  readonly annotateActive: boolean
  readonly closeAnnotateCell: (id: string) => void
  readonly toggleAnnotateCell: (id: string) => void
  readonly gestureAnnotateCellRef: RefObject<string | null>
  readonly boundAnnotateCellId: string | null
  readonly setBoundAnnotateCellId: React.Dispatch<React.SetStateAction<string | null>>
  readonly annotateStoreFor: (id: string | null) => AnnotateStore | undefined
  readonly annotateEditor: AnnotateEditorApi
}

/** The annotate stores / editor / processor-port plane. */
export function useGridAnnotate({
  cells,
  denseIds,
  paneDocks,
  glOk,
  denseRectsRef,
  viewStateRef,
  toLocal,
  imagePyramidsRef,
  imageUnderlaysRef,
}: GridAnnotateInputs): GridAnnotate {
  // ── Annotation overlay (ITEM-3) ───────────────────────────────────────────
  // One `AnnotateStore` per `annotate` cell (§5 per-instance isolation), lazily minted + retained in a
  // ref-held map so two cells never share edit state. `buildAnnotationLayers(...)` composes each store's
  // committed geometry (cellId-prefixed) into the ONE shared deck; a store `subscribe` bumps
  // `annotateEpoch` so the overlay memo rebuilds on any edit. Non-annotated cells mint nothing.
  const annotateStoresRef = useRef<Map<string, AnnotateStore>>(new Map())
  const annotateUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const [annotateEpoch, setAnnotateEpoch] = useState(0)
  // Idempotent get-or-create — safe to call in render (creation is a pure object mint, no state write),
  // so the `AnnotateProvider` and the overlay memo resolve the SAME instance.
  const ensureAnnotateStore = useCallback((cellId: string): AnnotateStore => {
    let s = annotateStoresRef.current.get(cellId)
    if (!s) {
      s = createAnnotateStore()
      annotateStoresRef.current.set(cellId, s)
    }
    return s
  }, [])
  const annotateCellsKey = useMemo(
    () => cells.filter(c => c.annotate && denseIds.has(c.id)).map(c => c.id).sort().join(','),
    [cells, denseIds],
  )
  useEffect(() => {
    const ids = new Set(cells.filter(c => c.annotate && denseIds.has(c.id)).map(c => c.id))
    // Subscribe every live annotate store (create-if-absent) so an edit repaints the shared-deck overlay.
    for (const id of ids) {
      const store = ensureAnnotateStore(id)
      if (!annotateUnsubsRef.current.has(id)) {
        annotateUnsubsRef.current.set(id, store.subscribe(() => setAnnotateEpoch(e => e + 1)))
      }
    }
    // Tear down stores for cells that are gone / no longer annotate (unsubscribe + drop the instance).
    for (const id of [...annotateStoresRef.current.keys()]) {
      if (!ids.has(id)) {
        annotateUnsubsRef.current.get(id)?.()
        annotateUnsubsRef.current.delete(id)
        annotateStoresRef.current.delete(id)
      }
    }
    setAnnotateEpoch(e => e + 1) // rebuild once the set of annotate cells changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotateCellsKey])
  // Expose the per-cell stores for gallery stories / e2e to seed + assert the overlay (dev hook only).
  useEffect(() => {
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __vizAnnotateStores?: Map<string, AnnotateStore> }).__vizAnnotateStores =
        annotateStoresRef.current
    }
  }, [annotateEpoch])

  // ── In-grid annotation EDITOR (FB-17) ──────────────────────────────────────
  // Closes the FB-17 product gap: the annotation authoring surface (draw / point / brush / reshape /
  // select) is now REACHABLE in the production GridWorkspace, not only in showcase stories. Design §4
  // JTBD ("open a slide, outline a tumor region, label it"). Additive + guarded: everything here is
  // behind the `annotate` tool + a cell's `annotate` flag, so a non-annotate workspace is byte-identical.
  //
  // PER-PANE (ITEM-7/9/10, INV-12/INV-13). Engaging the annotate tool opens a SEPARATE controls panel
  // for EVERY annotate-capable pane — the user's governing argument is that panes are different
  // DATASETS, so one global tool acting on a hidden "active" pane is a category error. This mirrors
  // `editCellIds`, the pre-existing per-pane precedent the shipped code claimed to follow and
  // inverted. A gesture binds to the pane UNDER THE CURSOR on the SAME press (no swallowed click).
  // ENTRY POINT (finding #14): a pane's OWN toolbar button, exactly like Edit. There is no global
  // annotate MODE any more — `annotateMode` is DERIVED from "does any pane have its dock open", so a
  // single pane can be annotated on its own and pane B is untouched while pane A is being annotated.
  const annotateCellIds = useMemo(
    () => cells.filter(c => c.annotate && denseIds.has(c.id)).map(c => c.id),
    [cells, denseIds],
  )
  // Which panes have their annotate controls OPEN. A Set, exactly like `editCellIds`/`dataTableCellIds`.
  //
  // SPLIT D (ITEM-15): the SET lives in `paneDocks`, and this plane subscribes to the derived MODE
  // only. That narrowing is the point: `annotateMode` is what gates the deck layer, the overlay
  // layer and the pointer path, so opening a SECOND annotate dock (the mode was already true) no
  // longer re-renders the shell at all. BLIND-AUDIT H3 (INV-13)'s gesture gate — which must read
  // USER INTENT (this pane's dock is OPEN), not capability — reads the live set out of the store at
  // gesture time from inside `GridOverlayLayer`, which is strictly fresher than the ref it replaces.
  const annotateMode = useStore(paneDocks, selectAnnotateMode)
  const closeAnnotateCell = useCallback((id: string) => paneDocks.getState().closeAnnotate(id), [paneDocks])
  /** The pane toolbar's Annotate button: open THIS pane's dock, or close it if already open. The
   *  dock's own × routes to `closeAnnotateCell`, so button and × can never disagree. */
  const toggleAnnotateCell = useCallback((id: string) => paneDocks.getState().toggleAnnotate(id), [paneDocks])
  // The pane the CURRENT gesture is bound to, set synchronously in `onAnnotatePointerDown` before the
  // editor's handler runs — this is what makes the first press draw (INV-13). React state would be one
  // event behind, so the binding lives in a ref and `boundAnnotateCellId` mirrors it for reactivity.
  const gestureAnnotateCellRef = useRef<string | null>(null)
  const [boundAnnotateCellId, setBoundAnnotateCellId] = useState<string | null>(null)
  // A stable fallback store so `useAnnotateEditor` always has a valid handle when no annotate cell is
  // bound (its gestures are inert — no overlay is mounted then).
  const fallbackAnnotateStore = useMemo(() => createAnnotateStore(), [])
  const annotateStoreFor = useCallback(
    (id: string | null): AnnotateStore | undefined => (id ? annotateStoresRef.current.get(id) : undefined),
    [],
  )
  // Reactive handle: the BOUND pane's store, used only for the editor's `activeTool`→cursor
  // subscription. Every imperative path resolves through `resolveStore` below instead.
  const boundAnnotateStore = annotateStoreFor(boundAnnotateCellId) ?? fallbackAnnotateStore

  // Screen→world (full-res px, INV-4) for the pane the gesture is bound to, via its inset rect +
  // controlled view state (read through refs so this stays stable across pan/zoom).
  const annotateUnproject = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const id = gestureAnnotateCellRef.current
    if (!id) return null
    const rect = denseRectsRef.current.find(r => r.id === id)
    const vs = viewStateRef.current[id]
    if (!rect || !vs) return null
    const [lx, ly] = toLocal({ clientX, clientY })
    return unprojectInCell(rect, vs, lx, ly)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- denseRectsRef/viewStateRef are stable refs
  }, [toLocal])

  const annotateEditor = useAnnotateEditor({
    store: boundAnnotateStore,
    // INV-13: resolved synchronously during the press that also binds the pane.
    resolveStore: useCallback(
      () => annotateStoreFor(gestureAnnotateCellRef.current),
      [annotateStoreFor],
    ),
    unproject: annotateUnproject,
  })

  // Keep the latest edit draft in a ref so the processor port's `getActiveGesture` reads it without
  // re-minting the port (INV-3: reading a gesture never runs a model).
  const annotateEditDraftRef = useRef<AnnotationEditDraft | null>(null)
  annotateEditDraftRef.current = annotateEditor.editDraft

  // ELIGIBILITY RECONCILE (DEC-8). No open-all-on-engage any more — opening is per pane, from that
  // pane's toolbar button. What survives is the eviction half: a pane that LEAVES the annotate set
  // (removed from the grid, or its `annotate` flag cleared) is dropped from the open set, so no stale
  // id survives — the same reconcile that already tears down `annotateStoresRef`. When the last dock
  // closes, the in-progress draft + gesture binding are dropped too.
  useEffect(() => {
    const eligible = new Set(annotateCellIds)
    paneDocks.getState().evictAnnotate(annotateCellIds)
    // Drop a stale gesture binding when its pane goes away, or when nothing is open at all.
    const bound = gestureAnnotateCellRef.current
    if (!annotateMode || (bound && !eligible.has(bound))) {
      annotateEditor.resetDraft()
      gestureAnnotateCellRef.current = null
      setBoundAnnotateCellId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetDraft is stable; reconcile on mode/set change
  }, [annotateMode, annotateCellIds.join(',')])

  // ── Processor API seam (FB-17 P2) ──────────────────────────────────────────
  // Mint ONE `createProcessorPort` per annotate cell so an external segmentation processor can inject a
  // produced result (polygons / points / mask) that becomes INDISTINGUISHABLE from hand-drawn (undo /
  // reshape / export / link all apply) and read the live camera + gesture. Exposed on a dev/window hook
  // exactly like `__vizAnnotateStores`. The editor runs NO model (INV-3) — it only receives + edits.
  const processorPortsRef = useRef<Map<string, DisposableProcessorPort>>(new Map())
  useEffect(() => {
    const ids = new Set(annotateCellIds)
    for (const id of ids) {
      if (processorPortsRef.current.has(id)) continue
      const store = ensureAnnotateStore(id)
      const port = createProcessorPort({
        store,
        getImageRef: () => {
          const pyr = imagePyramidsRef.current[id]
          const und = imageUnderlaysRef.current[id]
          let width = 0, height = 0, levelCount = 1, channelCount = 1
          if (pyr && pyr !== 'loading') {
            const s0 = pyr.loader[0]
            width = s0?.shape[s0.shape.length - 1] ?? 0
            height = s0?.shape[s0.shape.length - 2] ?? 0
            levelCount = pyr.loader.length
            channelCount = pyr.loader[0]?.shape[0] ?? 1
          } else if (und && und !== 'loading') {
            width = und.width
            height = und.height
          }
          return { sourceId: id, width, height, levelCount, channelCount }
        },
        getViewState: () => {
          const rect = denseRectsRef.current.find(r => r.id === id)
          const vs = viewStateRef.current[id]
          const bounds = rect && vs ? cellVisibleWorldBounds(rect, vs) : null
          const center: [number, number] = vs ? [vs.target[0], vs.target[1]] : [0, 0]
          const zoom = vs ? (typeof vs.zoom === 'number' ? vs.zoom : vs.zoom[0]) : 0
          return { center, zoom, bounds: (bounds ?? [0, 0, 0, 0]) as [number, number, number, number] }
        },
        getActiveGesture: () => {
          // Only meaningful for the FOCUSED cell's live editor; other cells have no in-flight gesture.
          // Only meaningful for the pane the CURRENT gesture is bound to.
          if (gestureAnnotateCellRef.current !== id) return null
          const draft = annotateEditDraftRef.current
          const path = draft?.draftPath
          if (!path || path.length < 3) return null
          const ring = new Float64Array(path.length * 2)
          for (let i = 0; i < path.length; i++) {
            ring[2 * i] = path[i][0]
            ring[2 * i + 1] = path[i][1]
          }
          return { kind: 'lasso', ring }
        },
      })
      processorPortsRef.current.set(id, port)
    }
    // Drop ports for cells that are gone / no longer annotate — dispose first (NF-7: drop the store
    // subscription so a removed cell's port can't leak).
    for (const id of [...processorPortsRef.current.keys()]) {
      if (!ids.has(id)) {
        processorPortsRef.current.get(id)?.dispose()
        processorPortsRef.current.delete(id)
      }
    }
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __vizProcessorPorts?: Map<string, DisposableProcessorPort> }).__vizProcessorPorts =
        processorPortsRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the annotate-cell set
  }, [annotateCellIds.join(',')])

  // NF-7: on unmount, dispose EVERY port (drop its store subscription) and null the window global so no
  // stale port map survives the workspace.
  useEffect(() => {
    const ports = processorPortsRef.current
    return () => {
      for (const port of ports.values()) port.dispose()
      ports.clear()
      if (typeof window !== 'undefined') {
        ;(window as unknown as { __vizProcessorPorts?: Map<string, DisposableProcessorPort> }).__vizProcessorPorts =
          undefined
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup
  }, [])

  const annotateActive = annotateMode && glOk && annotateCellIds.length > 0

  return {
    annotateStoresRef,
    annotateEpoch,
    ensureAnnotateStore,
    annotateCellIds,
    annotateMode,
    annotateActive,
    closeAnnotateCell,
    toggleAnnotateCell,
    gestureAnnotateCellRef,
    boundAnnotateCellId,
    setBoundAnnotateCellId,
    annotateStoreFor,
    annotateEditor,
  }
}
