// useGridTools.ts — SPLIT Q (ITEM-33): the grid's TOOL-STATE plane.
//
// DEC-26's "tool state" row (88) moved verbatim out of `GridWorkspace`. This is the EXCLUSIVE active
// tool the global rail owns (Select / Pan / Zoom), the selection SHAPE sub-tool (rect / polygon /
// move), and the three derivations every consumer of them reads.
//
// What it owns: `activeTool` + the `setActiveTool` wrapper that carries the leaving-Select side
// effect, the `activeToolRef` mirror that wrapper reads, `selTool`, and the `selectMode` /
// `chartSelectMode` / `toggleSelectMode` derivations.
//
// WHAT IT DOES NOT OWN, and why — `overlayApiRef` and `activeCellRef` are passed IN, not taken.
// `setActiveTool`'s leaving-Select branch is their only use HERE, but neither is this plane's to
// own: `overlayApiRef` is filled by `GridOverlayLayer` and read by `useGridSelection` (four sites),
// and `activeCellRef` has writers in `useGridWindows` (the export request), `useGridAnnotate` and
// `useGridLinking`. A plane that declared either would fork a ref that four modules already share —
// the DRIFT-25 class of failure, one step removed. `activeToolRef` by contrast has exactly three
// sites, all of them here, so it is INTERNAL and is deliberately not returned; that is the one piece
// of surface this split actually removes rather than relocates.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a ninth time). `activeTool` and `selTool` ARE already
// state, so DEC-27's test ("is the output already state, or would the store MAKE it state?") is
// satisfied either way — but `selectMode` / `chartSelectMode` are per-render derivations of them and
// every one of the five consumers is a JSX prop on the render path, so a store adds a subscription
// without removing a render. The existing `useState` identity is kept exactly.
//
// Writer-set completeness (HAZARD 1), per moved symbol — the method, and its limit:
//   `activeTool` / `setActiveToolRaw`
//                        one writer, `setActiveTool`, which moves with it. `setActiveToolRaw` is not
//                        returned, so no caller can bypass the wrapper's side effect. Lexical `tsc`.
//   `activeToolRef`      written on every render beside its declaration, read once in the wrapper.
//                        Both move. INTERNAL — not returned. Lexical; `tsc` complete.
//   `selTool`            `setSelTool` is returned (the rail writes it) — grepped: the shell, plus
//                        `GridOverlayLayer` (4 reads) and one showcase story, all PROP consumers.
//   `selectMode` / `chartSelectMode` / `toggleSelectMode`
//                        pure derivations, no writers.
//
// NO DEV WINDOW SEAM is installed from this module, and none of the moved symbols is aliased onto
// `window` anywhere in the package. Checked by grep over `__viz*`, not assumed — Split G's
// `__vizSharedMasks` escape is why that sentence is here.
import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ChartSelectMode } from '../charts/chartSelectionMode'
import type { SelTool, VizTool } from '../controls/VizToolRail'
import type { GridOverlayApi } from './gridModel'

export interface GridToolsInputs {
  /** Filled by `GridOverlayLayer`; the leaving-Select branch calls `clearDrafts()` through it. */
  readonly overlayApiRef: MutableRefObject<GridOverlayApi | null>
  /** Shared with `useGridWindows` / `useGridAnnotate` / `useGridLinking` — borrowed, never owned. */
  readonly activeCellRef: MutableRefObject<string | null>
}

export function useGridTools({ overlayApiRef, activeCellRef }: GridToolsInputs) {
  // ── Selection tool (ITEM-25 PRODUCER) ─────────────────────────────────────
  // Default OFF so pan works. When ON, a DOM overlay captures a rectangle drag OR a
  // polygon (click vertices → Finish). The draw is ATTRIBUTED to the dense cell it
  // starts in (`cellAtPoint`), then hit-tested ONCE on completion by unprojecting the
  // screen shape through THAT cell's viewport (rect + its controlled view state) into
  // world coords → `selectInBox`/`selectInPolygon` (via gridSelection.ts). The mask's
  // indices land in the Coordination store (`setSelection`), whose consumers above (base
  // dim + `DataFilterExtension` highlight fanned across every cell + heatmap band) light
  // up. No per-mouse-move O(N) loop — the CPU point test runs only on pointer-up / finish.
  // Shell redesign: the global tool rail owns the EXCLUSIVE active tool (Select / Pan / Zoom) + the
  // show/hide-cell-toolbars toggle. `selectMode` is derived (Select tool active); scroll-zoom + space-pan
  // stay available regardless of the active tool (grid-level gestures, unchanged).
  const [activeTool, setActiveToolRaw] = useState<VizTool>('pan')
  const selectMode = activeTool === 'select'
  // Mirrored so the "leaving Select" side effect below can read the CURRENT tool at event time
  // without a stale closure — see the note in `setActiveTool`.
  const activeToolRef = useRef(activeTool)
  activeToolRef.current = activeTool
  const setActiveTool = useCallback(
    (t: VizTool) => {
      // Leaving Select: drop any in-progress draft (keep the committed selection).
      //
      // SPLIT B moved the drafts into `GridOverlayLayer`, so this is now a CROSS-COMPONENT update and
      // it may no longer live inside the `setActiveToolRaw` UPDATER as it did before: React runs an
      // updater during the render phase whenever it cannot evaluate it eagerly, and a setState on a
      // DIFFERENT component from inside a render is the "Cannot update a component while rendering a
      // different component" error. Every caller of this function is an event handler, so reading the
      // live tool from a render-assigned ref is exactly as fresh as the updater's `prev` was, and it
      // puts the effect back in the event phase where it belongs.
      //
      // DEC-47 — `clearDrafts()` is a STRICT SUPERSET of the pre-split cleanup, and that is KEPT as a
      // deliberate fix rather than reverted to make this a pure move. Besides the two drafts and
      // `activeCellRef` it also nulls `polySlotRef` and `dragRef`. `polySlotRef` is the slot of
      // `committedByCell[cell]` the IN-PROGRESS polygon occupies (auto-commit REPLACES that slot on
      // every further vertex) and it is a GLOBAL index, not cell-keyed. Before, leaving Select dropped
      // the draft and the active cell but left the slot live, so the NEXT lasso — possibly in a
      // DIFFERENT pane — wrote `areas[slot]` and silently REPLACED an already-committed region.
      // `finishPolygon` / `cancelPolygon` both null it when a gesture ends; leaving the tool ends the
      // gesture too, so this is the existing rule applied consistently, not a new one. PINNED by
      // TEST-F4 (`ui/tests/viz-e2e/grid-selection-tool-switch.spec.ts`), which is RED on the old
      // semantics — verified by deleting the `polySlotRef.current = null` line in `clearDrafts`.
      if (activeToolRef.current === 'select' && t !== 'select') {
        overlayApiRef.current?.clearDrafts()
        activeCellRef.current = null
      }
      setActiveToolRaw(t)
    },
    [overlayApiRef, activeCellRef],
  )
  const [selTool, setSelTool] = useState<SelTool>('rect')
  // The rail-driven mode a PRODUCER chart (violin) uses (provided to the content layer below): Select+
  // shape → 'lasso' (or 'move' for the Move sub-tool); Pan/Zoom → 'pan'. So the same left rail drives a
  // violin's lasso as the dense scatter's — no per-plot mode toolbar.
  const chartSelectMode: ChartSelectMode = !selectMode
    ? 'pan'
    : selTool === 'move'
      ? 'move'
      : selTool === 'polygon'
        ? 'lasso'
        : 'rect'
  const toggleSelectMode = useCallback(() => {
    setActiveTool(selectMode ? 'pan' : 'select')
  }, [selectMode, setActiveTool])

  return {
    activeTool,
    setActiveTool,
    selectMode,
    selTool,
    setSelTool,
    chartSelectMode,
    toggleSelectMode,
  }
}
