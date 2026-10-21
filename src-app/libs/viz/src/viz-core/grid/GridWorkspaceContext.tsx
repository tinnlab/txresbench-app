// GridWorkspaceContext.tsx — SPLIT 0a, the SEAM (ITEM-14 / DEC-20).
//
// The decomposition of `GridWorkspace.tsx` (Splits A–E: deck+camera / overlays / docks / pane
// chrome / shell) cuts a 6,000-line closure into five components. Three of the four children read
// the SAME wide set of non-reactive values the pointer, keyboard and layer-building paths already
// depend on. Prop-drilling them would re-couple the children (every child re-renders when any of
// them changes identity), and passing them through a per-frame-changing context would re-create the
// ORIGINAL defect in a new shape — a camera value living in the same subscription as the chrome.
//
// So the seam carries ONLY STABLE IDENTITIES:
//   * store handles      — one identity per `<Viz>` instance,
//   * `useRef` objects   — identity fixed for the component's lifetime (`[]`-stable by construction),
//   * `useCallback`'d imperative handles built on a stable dep set.
//
// ── DEC-20, the hard rule ────────────────────────────────────────────────────────────────────────
// **A PER-FRAME-CHANGING VALUE MAY NEVER ENTER THIS CONTEXT.** Not the camera, not `hovered`, not a
// draft rect, not a per-cell legend record. Anything reactive crosses the boundary as an EXPLICIT
// PROP so the child that needs it re-renders and the ones that do not, do not. The camera
// specifically crosses UPWARD through a parent-held ref handle the child fills (`viewStateRef` /
// `onViewStateChangeRef` below, ITEM-6) — never downward through context.
//
// The admission rule applied to every member here, stated so a later addition can be checked
// against it rather than argued about:
//   (S) STABILITY  — the member's identity is invariant across renders of one `<Viz>` instance:
//                    a `useRef` object, a store handle, or a `useCallback(…, [stable deps])`.
//   (X) CROSS-CUT  — the member is read at ≥1 site the DEC-18 split map assigns to a layer OTHER
//                    than the residual shell. A member read only by the shell stays a private ref
//                    in `GridWorkspace.tsx`; admitting it here would be public surface with no
//                    consumer.
// Under-admitting is the safe direction: adding a member later is additive and local, whereas a
// member admitted without a consumer is API that must be maintained and re-audited.
//
// The idiom is not invented here — `GridWorkspace.tsx` already ref-mirrors every value its pointer
// handlers must read without re-binding (see the rationale comment above `denseRectsRef`). The seam
// GENERALIZES that idiom across a component boundary; it introduces no new mechanism.

import React, { createContext, useContext } from 'react'
import type { VizStores } from '../../adapter/vizStores'
import type { CoordinationHandle } from '../registry/types'
import type { AnnotateStore } from '../annotate/Annotate.store'
import type { CellDisplayStore } from '../../adapter/CellDisplay.store'
import type { PaneDocksStore } from '../../adapter/PaneDocks.store'
import type { GridCell } from './gridModel'
import type { GridViewState } from './linkZoom'
import type { PaneRect } from '../layers/multiView'
import type { Area } from '../selection/SelectionController'
import type { Vec2 } from '../selection/areaGestures'

// SPLIT O (ITEM-31): `CellDataResolved` moved to the neutral `gridModel.ts`. `useGridA11y` types the
// `cellDataRef` it borrows, and a data-plane HOOK MAY NOT IMPORT A LAYER — and this seam file IS a
// layer (INV-10 (a) counts it). Same rule, same remedy, as `GridOverlayApi` (Split I) and
// `GridDockApi` (Split M). Re-exported so existing importers of this module are unaffected.
import type { CellDataResolved } from './gridModel'
export type { CellDataResolved }

/** The camera write the deck layer publishes upward (ITEM-6). Kept structural for the same reason. */
export type GridViewStateChange = (e: { viewId: string; viewState: GridViewState }) => void

/** The SEED write (ITEM-6). Distinct from `GridViewStateChange` on purpose: a seed applies a camera
 *  to a cell **only if that cell has none yet** and never fans out to the cell's linked space scope,
 *  which is exactly what "frame this image, unless the user already moved it" needs. Folding it into
 *  the ordinary change handler would make a late-arriving bitmap yank a camera the user had already
 *  panned, and — under link-zoom — drag every same-space pane with it. */
export type GridViewStateSeed = (cellId: string, viewState: GridViewState) => void

/**
 * The seam value. EVERY member must satisfy (S) and (X) above.
 *
 * All `React.RefObject`s are `useRef` objects created in `GridWorkspace`'s body and re-assigned in
 * render (`ref.current = live`), which is the file's established non-reactive-read idiom: the
 * OBJECT identity never changes, so a consumer of this context never re-renders because a mirrored
 * value moved — it reads `.current` at gesture time instead.
 */
export interface GridWorkspaceSeam {
  // ── store handles ──────────────────────────────────────────────────────────────────────────────
  /** The active `<Viz>` instance's store set (VIZ_ISOLATION W1). Identity changes only when a
   *  different `<Viz>` provider mounts, never per render. */
  readonly stores: VizStores
  /** The coordination facade built over `stores` (`useMemo(…, [stores])`). */
  readonly coordination: CoordinationHandle
  /** SPLIT 0b (ITEM-21): this WORKSPACE's per-cell display slice — colors, legends, hidden codes,
   *  table data. Minted once per `GridWorkspace` (`useState(createCellDisplayStore)`), so its
   *  identity is fixed for the instance's life. It is NOT in the `VizStores` family on purpose: a
   *  popped-out container mounts a second workspace inside the SAME `<Viz>`, and both end their
   *  recolor/legend effects with a whole-record replace over their own cells — see the header of
   *  `CellDisplay.store.ts`. Children subscribe with `useStore(cellDisplay, selectCell(cellId))`. */
  readonly cellDisplay: CellDisplayStore
  /** SPLIT D (ITEM-15): this WORKSPACE's per-pane DOCK state — the four open sets (edit form / plot
   *  data table / annotate controls / mask review) plus the per-cell mask-review record. Minted once
   *  per `GridWorkspace` (`useState(createPaneDocksStore)`), so its identity is fixed for the
   *  instance's life. Per WORKSPACE and not in the `VizStores` family for DRIFT-5's reason: a
   *  popped-out container mounts a second workspace inside the SAME `<Viz>`, and a family-level slice
   *  would let one workspace's eviction reconcile close the other's docks (INV-7).
   *
   *  It is here rather than prop-drilled because DRIFT-20 measured that not one of these five states
   *  is read by a single layer — each is read by two or three of {pane chrome, dock, overlay, shell},
   *  and the shell may not hand a layer another layer's private module (INV-10 (d)). Consumers
   *  subscribe with a selector: the pane layer with a per-cell BOOLEAN (`selectEditOpen(id)`), the
   *  shell with a derived MODE (`selectAnnotateMode`), the dock layer with the sets it renders. */
  readonly paneDocks: PaneDocksStore

  // ── ref cluster ────────────────────────────────────────────────────────────────────────────────
  /** `stores`, mirrored — read by the deck's link fan-out, the annotate pointer path and the dock
   *  export builder without taking `stores` as a dep. */
  readonly storesRef: React.RefObject<VizStores>
  /** `coordination`, mirrored — read by the selection-commit and annotate pointer paths. */
  readonly coordinationRef: React.RefObject<CoordinationHandle>
  /** The live cell map, mirrored — read by the selection/draw pointer handlers. */
  readonly cellMapRef: React.RefObject<Record<string, GridCell>>
  /** The per-cell buffer resolver, mirrored. The resolver itself is NOT stable (it closes over the
   *  workspace's buffers), which is exactly why the seam carries the ref and not the callback. */
  readonly cellDataRef: React.RefObject<(cell: GridCell) => CellDataResolved>
  /** The per-cell selection identity-space resolver, mirrored. */
  readonly cellSelectionSpaceRef: React.RefObject<(cell: GridCell, hasPointIds: boolean) => string>
  /** One `AnnotateStore` per annotate cell — read by the deck's annotation-layer builder and by the
   *  annotate pointer path. Per-instance isolation lives in the map, not in a shared store. */
  readonly annotateStoresRef: React.RefObject<Map<string, AnnotateStore>>
  /** The cell a pointer gesture is currently acting on (`null` between gestures). */
  readonly activeCellRef: React.RefObject<string | null>
  /** Single vs MULTI region select, mirrored for the pointer handlers. */
  readonly selMultiRef: React.RefObject<boolean>
  /** The committed selection AREAS per cell, mirrored — read by the draw/move pointer handlers. */
  readonly committedByCellRef: React.RefObject<Record<string, Area[]>>
  /** The dense pane rects (toolbar-inset), mirrored — the geometry every pointer gesture and the
   *  deck's viewport cull resolve against. */
  readonly denseRectsRef: React.RefObject<PaneRect[]>
  /** SPLIT B (ITEM-16): the index (within `committedByCell[activeCell]`) the IN-PROGRESS polygon
   *  occupies, so live vertex updates REPLACE that one slot instead of appending a region per
   *  vertex. `null` ⇒ no polygon in progress. Admitted BY SPLIT B with both sides of its use visible
   *  in the same diff (DRIFT-4's admission rule): the SHELL's `commitRect`/`commitPolygon` claim and
   *  replace the slot, while the overlay layer's draw handlers / Finish / Esc-cancel clear it. A
   *  gesture ref, never read in render. */
  readonly polySlotRef: React.RefObject<number | null>
  /** SPLIT B (ITEM-16): the in-progress Move-tool drag — the grabbed cell + the area's INDEX +
   *  geometry at grab time (a FRESH copy is translated every move so the drag never accumulates
   *  rounding drift). Written by the overlay layer's draw handlers; also cleared by the SHELL's
   *  `clearGridSelection`, which is why it is shared rather than private to the overlay. */
  readonly dragRef: React.RefObject<{ cell: string; index: number; startWorld: Vec2; origArea: Area } | null>

  // ── the ITEM-6 camera handle (READ down, WRITE up) ─────────────────────────────────────────────
  /** The controlled camera, mirrored. This is the camera READ seam: pointer/keyboard handlers in
   *  the shell read `.current[cellId]` synchronously at gesture time, so the split does not
   *  re-subscribe the parent and cannot introduce a one-frame-stale read (INV-9).
   *  FILLED BY `GridDeckLayer` during its render (SPLIT A); the ref OBJECT is created in the shell,
   *  so its identity is fixed for the workspace's life. */
  readonly viewStateRef: React.RefObject<Record<string, GridViewState>>
  /** The camera WRITE seam: the deck layer owns `onViewStateChange` and fills this ref; the shell's
   *  5 pan/zoom sites (3 pointer + 2 a11y-keyboard) invoke it through the ref. Camera crosses
   *  UPWARD, never through context as a value (DEC-20). Initialized to a NO-OP so an invocation
   *  before the deck layer's first render is inert rather than a crash. */
  readonly onViewStateChangeRef: React.RefObject<GridViewStateChange>
  /** The UNLINKED per-cell camera (`localStates`), mirrored. Admitted to the seam BY SPLIT A, whose
   *  diff carries both consumers: the shell's image-framing effect ("frame this image only if the
   *  user has not moved its camera yet") and `toggleLinked` (seeding a coordinate space's shared
   *  scope from a cell's local camera). Both read it at effect/event time, never in render, so it
   *  stays a ref rather than a prop — DRIFT-4's "add the member in the split that needs it, with the
   *  consumer visible in the same diff" rule. */
  readonly localStatesRef: React.RefObject<Record<string, GridViewState>>
  /** The SEED write handle, filled by the deck layer. Its one consumer is the shell's image-framing
   *  effect: when an image cell's bitmap (or pyramid level 0) resolves, frame the camera on it —
   *  unless the user has already moved that pane. This is a SIXTH camera write site, over and above
   *  ITEM-6's five `onViewStateChange` invocations, and it is a direct `setLocalStates` in the
   *  pre-split tree rather than a call to the handler, which is why an anchor sweep for
   *  `onViewStateChange` does not surface it. Missing it would leave every image pane framed at the
   *  origin. */
  readonly seedViewStateRef: React.RefObject<GridViewStateSeed>
}

const GridWorkspaceSeamContext = createContext<GridWorkspaceSeam | null>(null)
GridWorkspaceSeamContext.displayName = 'GridWorkspaceSeam'

/** Provider. Its `value` MUST be memoized on a stable dep set by the caller — a value rebuilt per
 *  render would re-render every consumer on every frame, which is the failure DEC-20 forbids by
 *  name and TEST-20 measures. */
export const GridWorkspaceSeamProvider = GridWorkspaceSeamContext.Provider

/** Read the seam. Throws outside a provider rather than returning a plausible-looking default: a
 *  silently-undefined seam would degrade a split child into reading stale/empty geometry, which is
 *  indistinguishable from "the gesture did nothing". */
export function useGridWorkspaceSeam(): GridWorkspaceSeam {
  const seam = useContext(GridWorkspaceSeamContext)
  if (!seam) throw new Error('useGridWorkspaceSeam must be used inside a <GridWorkspaceSeamProvider>')
  return seam
}

// NO OPTIONAL ACCESSOR IS EXPORTED (FIX_ROUND-2 / C10). There was one —
// `useGridWorkspaceSeamOptional`, "an escape hatch for a subtree that may legitimately render
// outside a workspace (a bare chart in the showcase)" — with ZERO call sites anywhere in `src-app`.
// The showcase's bare charts do not consume the seam at all, so the hatch described a case that does
// not exist; it was surface added by the decomposition and never wired. A subtree that genuinely
// needs a null-safe seam should add it back WITH its consumer in the same change, which is the point
// (see `gridDecomposition.test.ts`, "every hook a grid module EXPORTS has a consumer").
