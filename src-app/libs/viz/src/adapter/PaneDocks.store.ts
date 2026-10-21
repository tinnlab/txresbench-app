// PaneDocks.store.ts — SPLIT D (ITEM-15 / DEC-21): the PER-PANE DOCK-STATE slice.
//
// ── Why this store exists (DRIFT-20's inherited obligation) ──────────────────────────────────────
// Split C (ITEM-17) moved the dock SURFACES out of `GridWorkspace.tsx` but could move only ONE of
// the six states its item named. The other five — `editCellIds`, `dataTableCellIds`,
// `annotateOpenIds`, `segmentOpenIds`, `maskReview` — each had at least one reader the dock layer
// could not serve, so they stayed in the shell and DRIFT-20 recorded them as a Split-D/E obligation
// rather than a descope.
//
// Re-derived at Split D, by enumerating every READ by symbol AND by data flow, the shape of that
// obligation is now exact: not one of the five is read by a SINGLE layer. Each is read by two or
// three of {pane chrome, dock, overlay, residual shell}:
//
//   editCellIds        → pane chrome (`editOpen` on `<CellView>`) + dock (`buildEditForm` loop)
//   dataTableCellIds   → pane chrome (`dataOpen`) + dock (table loop) + shell (`wantsCameraEpochRef`)
//   annotateOpenIds    → pane chrome (`annotateOpen`) + dock + overlay (draw sheets, gesture gate)
//                        + shell (`annotateMode` gates the deck layer and the pointer path)
//   segmentOpenIds     → pane chrome (`segmentOpen`) + dock + shell (`segmentMode`, session hook)
//   maskReview         → dock (the review panel) + shell (the label-mask LAYER builder, which feeds
//                        deck's `layersAfter`) + ~15 shell mask handlers that WRITE it
//
// So there is no layer any of them can simply "move into". The three available shapes are DEC-21's,
// and its answer applies here unchanged:
//   (b) prop-drill them into three children — rejected: every child re-renders together, which is
//       "the same component with more files", and it is what the shell does TODAY.
//   (c) put them in a React context — rejected by DEC-20: the value changes per dock interaction, so
//       every consumer re-renders, which re-creates the original defect in a new shape.
//   (a) hoist into a per-workspace zustand slice, consumed through selectors — TAKEN.
//
// ── What (a) actually buys, measured against the shell it replaces ───────────────────────────────
// The pane-chrome layer is the FIRST per-cell component in this decomposition, so a per-cell
// subscription finally has somewhere to land. `GridPaneCell` subscribes to FOUR BOOLEANS scoped to
// its own pane (`s => s.editCellIds.has(id)`), so opening pane A's edit form re-renders pane A's
// chrome and nothing else — where before it re-rendered a 5,000-line closure and every `<CellView>`
// in the grid. The shell likewise narrows: it no longer holds the SETS at all, only the derived
// booleans `annotateMode` / `segmentMode` / "is any data table open", so opening a SECOND annotate
// dock does not re-render the shell at all (the mode was already true).
//
// Boolean selectors need no memo cache — a primitive result is compared by value, so unlike
// `CellDisplay.store.ts`'s `selectCell` there is no per-cell closure to keep stable. The one
// non-primitive selector (`selectMaskReview`) is a whole-record read by design: its consumer is the
// label-mask layer builder, which rebuilds on any cell's review change anyway.
//
// ── Per WORKSPACE, not per `<Viz>` (DRIFT-5, carried) ────────────────────────────────────────────
// Minted with `useState(createPaneDocksStore)` inside `GridWorkspace`, exactly like
// `CellDisplay.store.ts`, and reached by the children through the ITEM-14 seam. It is NOT a member
// of the `VizStores` family: a popped-out container mounts a SECOND `GridWorkspace` inside the same
// `<Viz>`, and a family-level slice would let one workspace's eviction reconcile close the other's
// docks (INV-7). Each workspace owns its own open sets, which is also what the user sees.
//
// Plain-zustand (no immer), matching `CellDisplay.store.ts` / `PlotInteraction.store.ts`.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { closePane, evictIneligible, openPane, togglePane } from '../viz-core/grid/openPanes'
import { emptyMaskReview, type MaskCellReview } from '../viz-core/annotate/maskDock'

/** The per-pane dock state. Every open set is a `ReadonlySet<paneId>` so a surface can be open on
 *  SEVERAL panes at once — the INV-8 per-pane-parity contract, unchanged by the hoist. */
export interface PaneDocksSlice {
  /** Panes whose EDIT FORM is open. */
  readonly editCellIds: ReadonlySet<string>
  /** Panes whose plot-data TABLE is open. */
  readonly dataTableCellIds: ReadonlySet<string>
  /** Panes whose ANNOTATE controls dock is open. `size > 0` is the derived `annotateMode`. */
  readonly annotateOpenIds: ReadonlySet<string>
  /** Panes whose MASK REVIEW dock is open. `size > 0` is the derived `segmentMode`. */
  readonly segmentOpenIds: ReadonlySet<string>
  /** Per-cell mask review/correction state (hide/solo/LUT/tool/selection). Read by the dock panel
   *  AND by the shell's label-mask layer builder, written by the shell's mask pointer handlers. */
  readonly maskReview: Readonly<Record<string, MaskCellReview>>
}

export interface PaneDocksActions {
  toggleEdit(id: string): void
  closeEdit(id: string): void
  toggleDataTable(id: string): void
  closeDataTable(id: string): void
  toggleAnnotate(id: string): void
  openAnnotate(id: string): void
  closeAnnotate(id: string): void
  /** DEC-8 eviction: drop every open annotate pane that no longer qualifies. */
  evictAnnotate(eligibleIds: readonly string[]): void
  toggleSegment(id: string): void
  closeSegment(id: string): void
  evictSegment(eligibleIds: readonly string[]): void
  /** Patch ONE cell's review record, seeding an empty one when the cell has none yet. */
  patchMaskReview(cellId: string, fn: (r: MaskCellReview) => MaskCellReview): void
  /** BLIND-AUDIT M11: closing a mask dock drops that pane's HALF-FINISHED correction, so a reopen
   *  cannot silently resume a stale merge source / split seeds against a since-edited mask. */
  clearPendingCorrection(cellId: string): void
  /** Drop the review record of every cell that is no longer a live segment cell (leak guard). */
  pruneMaskReview(liveIds: readonly string[]): void
}

export type PaneDocksState = PaneDocksSlice & PaneDocksActions

const EMPTY_SET: ReadonlySet<string> = new Set()

export function createPaneDocksStore() {
  return create<PaneDocksState>()(
    subscribeWithSelector(set => ({
      editCellIds: EMPTY_SET,
      dataTableCellIds: EMPTY_SET,
      annotateOpenIds: EMPTY_SET,
      segmentOpenIds: EMPTY_SET,
      maskReview: {},

      // Every mutator routes through the pure `openPanes.ts` algebra the shell used before the
      // hoist — including its identity contract (`closePane`/`openPane`/`evictIneligible` return
      // `prev` UNCHANGED on a no-op), so a redundant close still schedules no subscriber update.
      toggleEdit: id => set(s => ({ editCellIds: togglePane(s.editCellIds, id) })),
      closeEdit: id => set(s => ({ editCellIds: closePane(s.editCellIds, id) })),
      toggleDataTable: id => set(s => ({ dataTableCellIds: togglePane(s.dataTableCellIds, id) })),
      closeDataTable: id => set(s => ({ dataTableCellIds: closePane(s.dataTableCellIds, id) })),
      toggleAnnotate: id => set(s => ({ annotateOpenIds: togglePane(s.annotateOpenIds, id) })),
      openAnnotate: id => set(s => ({ annotateOpenIds: openPane(s.annotateOpenIds, id) })),
      closeAnnotate: id => set(s => ({ annotateOpenIds: closePane(s.annotateOpenIds, id) })),
      evictAnnotate: eligibleIds => set(s => ({ annotateOpenIds: evictIneligible(s.annotateOpenIds, eligibleIds) })),
      toggleSegment: id => set(s => ({ segmentOpenIds: togglePane(s.segmentOpenIds, id) })),
      closeSegment: id => set(s => ({ segmentOpenIds: closePane(s.segmentOpenIds, id) })),
      evictSegment: eligibleIds => set(s => ({ segmentOpenIds: evictIneligible(s.segmentOpenIds, eligibleIds) })),

      patchMaskReview: (cellId, fn) =>
        set(s => ({ maskReview: { ...s.maskReview, [cellId]: fn(s.maskReview[cellId] ?? emptyMaskReview()) } })),
      clearPendingCorrection: cellId =>
        set(s => {
          const cur = s.maskReview[cellId]
          if (!cur) return s
          if (cur.mergeSource == null && (cur.splitSeeds?.length ?? 0) === 0) return s
          return { maskReview: { ...s.maskReview, [cellId]: { ...cur, mergeSource: null, splitSeeds: [] } } }
        }),
      pruneMaskReview: liveIds =>
        set(s => {
          const live = new Set(liveIds)
          let changed = false
          const next: Record<string, MaskCellReview> = {}
          for (const [id, v] of Object.entries(s.maskReview)) {
            if (live.has(id)) next[id] = v
            else changed = true
          }
          return changed ? { maskReview: next } : s
        }),
    })),
  )
}

export type PaneDocksStore = ReturnType<typeof createPaneDocksStore>

// ── selectors ────────────────────────────────────────────────────────────────────────────────────
// All four per-pane selectors return a BOOLEAN, so `useStore` compares by value and a subscriber is
// woken only when ITS pane's flag flips. That is what makes `GridPaneCell` a real per-cell boundary
// rather than four whole-record props with a `memo` in front of them.

export const selectEditOpen = (id: string) => (s: PaneDocksSlice) => s.editCellIds.has(id)
export const selectDataOpen = (id: string) => (s: PaneDocksSlice) => s.dataTableCellIds.has(id)
export const selectAnnotateOpen = (id: string) => (s: PaneDocksSlice) => s.annotateOpenIds.has(id)
export const selectSegmentOpen = (id: string) => (s: PaneDocksSlice) => s.segmentOpenIds.has(id)

/** The whole mask-review record. A whole-record read BY DESIGN, unlike the four boolean selectors:
 *  its consumers are the label-mask LAYER builder (which rebuilds on any cell's review change) and
 *  the mask dock's panel loop, neither of which is per-cell. */
export const selectMaskReview = (s: PaneDocksSlice) => s.maskReview

/** Derived MODES — the shell's only remaining read of the annotate/segment sets. A boolean, so
 *  opening a SECOND annotate dock does not re-render the shell (the mode was already true). */
export const selectAnnotateMode = (s: PaneDocksSlice) => s.annotateOpenIds.size > 0
export const selectSegmentMode = (s: PaneDocksSlice) => s.segmentOpenIds.size > 0
/** DRIFT-11's gate: the shell converts a committed camera change into a re-render ONLY while at
 *  least one plot-data table is open. A boolean for the same reason as the modes above. */
export const selectAnyDataTableOpen = (s: PaneDocksSlice) => s.dataTableCellIds.size > 0

/** A stable-by-VALUE signature of the open segment set, for the one shell effect that must re-fire
 *  when the SET changes rather than when the mode flips (the `__vizMaskSessions` dev hook). A joined
 *  string keeps the shell off the Set's identity while preserving the effect's exact trigger. */
export const selectSegmentOpenSig = (s: PaneDocksSlice) => [...s.segmentOpenIds].sort().join(',')
