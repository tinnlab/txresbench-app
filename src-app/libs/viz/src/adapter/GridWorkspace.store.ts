// GridWorkspace.store.ts — the free-form resizable GRID workspace store (DEC-19/20/21).
//
// Holds the split-pane `LayoutNode` tree (the DOM layout `react-resizable-panels`
// renders) + a per-leaf `GridCell` config (id, view-kind, data binding). Add /
// remove / split / resize / set-kind mutate the tree + the cell map in lockstep.
// Authored in the same `defineStore` style as Coordination.store.ts; consumers read
// it through `useGridWorkspaceStore` (a bound zustand hook). All mutations rebuild
// the tree from plain state via the pure `splitTree` helpers (no immer — rebuilding
// a tree from immer drafts risks embedding leftover draft proxies).
//
// Generic, domain-agnostic naming (DEC-28) so the module extracts as a package.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  type LayoutNode,
  type SplitDir,
  splitLeaf,
  removeLeaf,
  resizeDivider as resizeDividerTree,
  leafIds,
} from '@ziee/dock'
import {
  movePane as pureMovePane,
  returnToPrimary as pureReturnToGrid,
  slotAnchorOf,
  insertLeaf as pureInsertLeaf,
  seedPopupCounterFrom,
  PRIMARY_CONTAINER,
  type ContainerId,
  type ContainerModel,
  type DropTarget,
} from '@ziee/dock'
import { swapCellContent, type CellKind, type GridCell } from '../viz-core/grid/gridModel'
import type { CellDisplayPatch } from '../viz-core/grid/propagateToLinked'
import type { ColorBy } from '../viz-core/data/engine'
import type { Typography } from '../viz-core/controls/typography'
import type { LegendCorner } from '../viz-core/controls/legendRender'
import type { ContinuousColormap } from '../viz-core/data/color'
import { getChartType } from '../viz-core/registry/registry'
import type { ResolvedBindings } from '../viz-core/registry/types'

/** The id of the single cell a fresh / reset workspace starts with. */
export const INITIAL_CELL_ID = 'cell-1'
/** Default data binding for a new cell (the fixture's primary layout). */
const DEFAULT_LAYOUT_ID = 'primary'
/** Default view-kind for a new cell. */
const DEFAULT_KIND: CellKind = 'scatter'

/** The sentinel leaf id `layout` holds when the grid container is EMPTY (all panes popped into
 *  windows). A P3 concern: the render treats this as "no grid cells". In P2 the pop-out path is still
 *  placeholder-based, so `movePane` (the only producer of this state) is not wired to the render and
 *  the sentinel never reaches a live grid. */
export const EMPTY_GRID_ID = '__viz-empty-grid__'

export interface GridWorkspaceState {
  /** The MAIN-window (`'grid'`) container's split-pane tree; leaves are cells. (Byte-identical to the
   *  pre-docking single tree — every existing action + reader operates on this.) */
  layout: LayoutNode
  /** Per-cell config keyed by cell id; kept in lockstep with the tree's leaves. Global across all
   *  containers (a pane keeps its config wherever it's docked). */
  cells: Record<string, GridCell>
  /** Monotonic id counter — the source of deterministic `cell-N` ids. */
  seq: number
  /** Docking P2 (multi-container model): the NON-grid container trees (`popup:<n>` → tree). The grid
   *  container lives in `layout`; together they form the plan's `layoutByContainer`. Empty until a
   *  pane is moved into a window. */
  containerLayouts: Record<string, LayoutNode>
  /** Which container each cell is in — SPARSE (absent ⇒ `'grid'`). Drag guards + the popup renderers
   *  (P3) read it. Empty in the single-window case. */
  paneContainer: Record<string, ContainerId>
  /** Popup containers that emptied (their last pane moved out) and want their window CLOSED. The
   *  window owner drains this via `acknowledgeContainerClose`. */
  pendingClose: ContainerId[]
  /** RETURN-POSITION memory (docking P5 §6): a pane that LEFT the main grid remembers its former main
   *  slot, so closing its popup (a non-drag return) best-effort docks it back where it was, not merely
   *  appended. Keyed by cell id; set on move-out of the main, cleared when the pane returns. */
  returnAnchors: Record<string, DropTarget>
  /** Popup containers RESTORED from a session snapshot whose windows are not (yet) open (docking P5
   *  session-restore): a reload can't re-open windows without a user GESTURE, so `hydrate` lists the
   *  restored popup containers here and the UI shows a choice dialog — MERGE them into the main, or
   *  REOPEN their windows (from the dialog click). Empty in the normal (non-restore) case. */
  pendingRestore: ContainerId[]
  /** A NEW-plot request awaiting AIM-TO-PLACE (docking P5): set by `requestAddCell` when ≥1 popup is
   *  open, so the main grid enters placement mode (the user aims + clicks a spot in any window). `null`
   *  when no placement is pending. Transient — never serialized. */
  pendingPlacement: { kind: CellKind } | null
  /** SELECTION LINK groups: a link-group id → its member cell ids. Cells in one group share their
   *  SELECTION + FILTER (a legend hide / value-range filter on one member applies to all). A cell
   *  belongs to at most one group. Ephemeral (v1 — not serialized). Max 10 groups (distinct colors). */
  linkGroups: Record<string, string[]>
  /** Per-link-group color INDEX (0..9) into the 10-color link palette (`LINK_GROUP_COLORS`). */
  linkColorIdx: Record<string, number>
  /** The active link-PICKING session — the "Link / Link and Finish" overlay is shown on eligible
   *  panes. `null` when idle. */
  linkPicking: { groupId: string } | null
}

export interface GridWorkspaceActions {
  /** Add a cell by splitting the LAST leaf in `dir` (default a side-by-side column
   *  split) of `containerId` (default the main `'grid'`). Returns the new cell's id.
   *  Docking P3a: a popup GridWorkspace passes its own `containerId` so its chrome
   *  mutates ITS tree, not the grid; the default keeps every existing call byte-identical. */
  addCell: (dir?: SplitDir, kind?: CellKind, containerId?: ContainerId, datasetId?: string) => string
  /** Split the leaf `cellId` in `dir` within `containerId` (default `'grid'`), inserting
   *  a fresh cell beside it. Returns the new cell's id (unchanged workspace + '' if
   *  `cellId` is not a leaf of that container). */
  splitCell: (cellId: string, dir: SplitDir, kind?: CellKind, containerId?: ContainerId, datasetId?: string) => string
  /** Remove the cell `cellId` from `containerId` (default `'grid'`); collapses single-child
   *  splits. In the grid: no-op when it is the only remaining cell (the grid keeps ≥1 cell).
   *  In a popup: removing the last pane empties + queues the container for close (`pendingClose`),
   *  mirroring `movePane`'s emptied-signal. */
  removeCell: (cellId: string, containerId?: ContainerId) => void
  /** Move the divider at `dividerIndex` of the split reached by `path` (child-index
   *  array from the root) in `containerId` (default `'grid'`) by `deltaFraction`,
   *  clamped so no pane collapses. */
  resizeDivider: (
    path: number[],
    dividerIndex: number,
    deltaFraction: number,
    containerId?: ContainerId,
  ) => void
  /** Change a cell's view-kind. */
  setCellKind: (cellId: string, kind: CellKind) => void
  /** Toggle a cell's node-link GRAPH overlay flag (Phase C3c / ITEM-53). Additive —
   *  mirrors `setCellKind`; flips `graphOverlay` (undefined ⇒ true). No-op on an
   *  unknown cell id. */
  toggleCellGraphOverlay: (cellId: string) => void
  /** Set a cell's per-cell COLOR-BY intent (Phase C3b / ITEM-64). Additive —
   *  mirrors `setCellKind`; a dense cell then colors by its own column. No-op on
   *  an unknown cell id. */
  setCellColorBy: (cellId: string, colorBy: ColorBy) => void
  /** Plot-editing (ITEM-5): merge a cell's per-cell MARK style (`radius`/`opacity`). Each field is
   *  set independently; passing a field `undefined` clears it (an emptied style prunes to absent).
   *  No-op on an unknown cell id. */
  setCellStyle: (cellId: string, style: { radius?: number; opacity?: number }) => void
  /** Plot-editing (ITEM-4): set a cell's PLOT title and/or x/y AXIS titles. Passing `title: ''`
   *  (or an axis title '') clears that title back to the View default. No-op on an unknown cell id. */
  setCellTitles: (cellId: string, titles: { title?: string; x?: string; y?: string; legendTitle?: string }) => void
  /** Merge a partial typography patch into the cell's `typography` (deep-merges the per-element
   *  overrides); pass a field as `undefined` value is ignored (only present keys merge). */
  setCellTypography: (cellId: string, patch: Partial<Typography>) => void
  /** Show/hide the chart-frame grid lines for a cell (absent field ⇒ default ON). */
  setCellShowGrid: (cellId: string, show: boolean) => void
  /** Show/hide the on-plot legend / visual-map for a cell (absent field ⇒ default ON). */
  setCellShowLegend: (cellId: string, show: boolean) => void
  /** Set which CORNER the legend sits in (absent field ⇒ default 'tr'). */
  setCellLegendCorner: (cellId: string, corner: LegendCorner) => void
  /** Set the legend layout mode: true = beside (plot shrinks), false = overlay (absent ⇒ overlay). */
  setCellLegendBeside: (cellId: string, beside: boolean) => void
  /** Set the continuous VALUE colormap for a matrix chart (heatmap/dotplot). */
  setCellValueColormap: (cellId: string, colormap: ContinuousColormap) => void
  /** ITEM-14 (Track C): apply a batch of display patches (channels/colormap) from `propagateToLinked`
   *  in ONE update. A patch's `channels`/`colormap` is set when present; a missing key is unchanged. */
  applyDisplayPatches: (patches: readonly CellDisplayPatch[]) => void
  /** Set the HIDDEN group codes for a grouped cell (legend + form share this). Empty ⇒ clears the field. */
  setCellHiddenGroups: (cellId: string, codes: readonly number[]) => void
  /** Set the LEGEND-hidden codes (removed from the legend list; points still render). Empty ⇒ clears. */
  setCellLegendHiddenCodes: (cellId: string, codes: readonly number[]) => void
  /** Toggle rendering the continuous legend using the custom range as the full gradient (absent ⇒ off). */
  setCellLegendUseRange: (cellId: string, on: boolean) => void
  // ── SELECTION LINK groups ──────────────────────────────────────────────────────────────────
  /** Begin a link-PICKING session anchored on `cellId` (creates a fresh group containing it, or, if it
   *  is already in a group, re-enters picking on THAT group). No-op past 10 groups. */
  startLinkPicking: (cellId: string) => void
  /** Add `cellId` to the CURRENTLY-PICKING group (moving it out of any other group first). */
  addCellToLinkGroup: (cellId: string) => void
  /** Exit link-picking. A group left with < 2 members is dissolved (a link of one is meaningless). */
  finishLinkPicking: () => void
  /** Remove `cellId` from its link group (dissolving the group if < 2 members remain). */
  removeCellFromLinkGroup: (cellId: string) => void
  /** Dissolve an entire link group. */
  unlinkGroup: (groupId: string) => void
  /** Toggle a cell's LINK-COLOR-SCALE flag (Phase C3b / ITEM-64). Additive —
   *  mirrors `toggleCellGraphOverlay`; flips `linkColorScale` (undefined ⇒ true).
   *  No-op on an unknown cell id. */
  toggleCellLinkColorScale: (cellId: string) => void
  /** Swap the CONTENT of two cells (drag-to-swap, ITEM-70). Trades the display
   *  fields (`kind`, `colorBy`, `linkColorScale`, `graphOverlay`) between `cells[idA]`
   *  and `cells[idB]` while KEEPING each cell's `id` and its position/`layoutId` — so
   *  the two cells visually trade places without restructuring the split-tree or
   *  divider sizes. Additive; mirrors `setCellKind`. No-op if either id is missing or
   *  `idA === idB`. */
  swapCells: (idA: string, idB: string) => void
  /** Docking P2: MOVE a pane into `toContainer` at `dropTarget` — removes it from its current
   *  container (which reflows) and inserts it into the target; reassigns `paneContainer`; if the
   *  source popup emptied, appends it to `pendingClose`. Pure logic in `paneContainers.movePane`.
   *  (Foundation: not yet driven by the render — P3 wires popups + reflow.) */
  movePane: (cellId: string, toContainer: ContainerId, dropTarget: DropTarget) => void
  /** Docking P2: RETURN a pane to the grid (popup closed without dragging back) — best-effort to the
   *  `remembered` slot, else append. */
  returnPaneToGrid: (cellId: string, remembered?: DropTarget) => void
  /** Drain a container from `pendingClose` once its window has been closed. */
  acknowledgeContainerClose: (containerId: ContainerId) => void
  /** Session-restore (P5): FOLD every `pendingRestore` popup container's panes back into the main grid
   *  (best-effort to each pane's remembered slot) and clear the restore state — the "Merge to main"
   *  choice. No windows involved (the restored popups were never opened). */
  mergeRestoredToPrimary: () => void
  /** Session-restore (P5): the caller RE-OPENED + registered these popup windows (a user gesture); drain
   *  ONLY them from `pendingRestore`. Any that stayed blocked (browser "one popup per gesture" cap)
   *  remain pending, so the dialog stays up for a retry / merge — nothing is silently lost. */
  resolveRestored: (opened: ContainerId[]) => void
  /** Request a NEW plot (docking P5 aim-to-place). With NO popup open → adds it directly to the main
   *  (byte-identical to `addCell`, returns the new id). With ≥1 popup open → sets `pendingPlacement`
   *  (the main grid enters aim-to-place; returns `''`, the pane is created later by `placeNewCell`). */
  requestAddCell: (dir?: SplitDir, kind?: CellKind) => string
  /** Aim-to-place (P5): CREATE a new cell in `container` at `dropTarget` (the spot the user clicked) and
   *  clear `pendingPlacement`. Returns the new cell id. */
  placeNewCell: (container: ContainerId, dropTarget: DropTarget, kind?: CellKind) => string
  /** Aim-to-place (P5): DISCARD the pending new plot (the user pressed Escape). */
  cancelPlacement: () => void
  /** Reset to a single default cell. */
  reset: () => void
  /** Read the serializable grid slice (layout tree + full cells map + seq) — the single
   *  serialize source for `sessionState.ts`. Pure snapshot (deep-copies the cells map so a
   *  later mutation can't retro-edit the captured slice). */
  serialize: () => GridWorkspaceSlice
  /** REPLACE the grid state from a hydrated slice (layout + cells + seq). No side-effect
   *  fetches — the cells' data is pulled from the OWNED source at render time exactly as after a
   *  `setOption` (DATA_OWNERSHIP_INVERSION). A partial slice keeps the current field for anything
   *  omitted. */
  hydrate: (slice: GridWorkspaceSlice) => void
}

/** A JSON-safe snapshot of the multi-container DOCKING state (DEC-15) — the pop-out windows, their
 *  resolved layout trees, which container each popped pane lives in, and the return-to-origin
 *  anchors. This is the CONSOLIDATED shape `VizOption.docking` consumes: a single `LayoutNode`
 *  can't carry container identity (F3), so the pane→window binding + per-window tree ride here.
 *
 *  `containers` is the NON-main container LIST (the main grid's tree is the slice's own `layout`);
 *  emitting a list (not a Record) keeps a stable, ordered wire form for the option schema. Every
 *  field is plain-JSON (`LayoutNode` / `DropTarget` are plain objects; `ContainerId` is a string),
 *  so the whole thing round-trips through `JSON.stringify`/`parse` unchanged. Present in a slice
 *  ONLY when ≥1 pane is actually docked out (single-window sessions omit it). */
export interface DockingSnapshot {
  /** The non-main container trees, as an ORDERED LIST: each `{ id, layout }` is one pop-out window
   *  and its resolved `LayoutNode` split tree (nested splits + `sizes` proportions). */
  containers: { id: ContainerId; layout: LayoutNode }[]
  /** Which container each POPPED pane is in — SPARSE (a pane absent from this map ⇒ the main grid). */
  paneContainer: Record<string, ContainerId>
  /** Return-to-origin anchors for popped panes: the former main slot to best-effort re-dock to when
   *  the pane's window is closed without a drag-back. Keyed by cell id; empty ⇒ none. */
  anchors: Record<string, DropTarget>
}

/** The serializable GridWorkspace slice — layout tree + per-cell config + the id counter. This is
 *  the store's OWN shape (a `cells` RECORD, not the thin `CellSpec[]` of `export/spec.ts`), so it
 *  carries the full per-cell config (kind, bindings, colorBy, linkColorScale, graphOverlay, …). */
export interface GridWorkspaceSlice {
  /** The RESOLVED main-grid split tree (a `LayoutNode`: nested splits + per-divider `sizes`
   *  proportions), NOT a lossy even-size region form — so a serialize→hydrate reproduces every
   *  split / swap / resize byte-for-byte. */
  layout: LayoutNode
  cells: Record<string, GridCell>
  seq: number
  /** Docking P5 (multi-container session): the NON-main container trees (`popup:<n>` → tree). ABSENT
   *  ⇒ a single-window snapshot (back-compat with the P2 slice). LEGACY flat form — kept alongside
   *  the consolidated `docking` below so existing consumers keep working; `hydrate` prefers `docking`
   *  when present and falls back to these. */
  containerLayouts?: Record<string, LayoutNode>
  /** Which container each cell is in — SPARSE (absent ⇒ main). ABSENT ⇒ single-window. LEGACY flat
   *  form (see `containerLayouts`). */
  paneContainer?: Record<string, ContainerId>
  /** Return-position memory for popped panes. ABSENT ⇒ none. LEGACY flat form (see `containerLayouts`). */
  returnAnchors?: Record<string, DropTarget>
  /** Consolidated DOCKING snapshot (DEC-15) — the `VizOption.docking`-facing shape (containers list +
   *  per-pane binding + anchors). ABSENT ⇒ a single-window snapshot. Additive over the legacy flat
   *  fields above; `hydrate` reads THIS first when present. */
  docking?: DockingSnapshot
}

function makeCell(id: string, kind: CellKind, datasetId?: string): GridCell {
  // MULTI-DATASOURCE (ITEM-21): a progressively-added cell may bind a dataset; absent ⇒ the default.
  return { id, kind, layoutId: DEFAULT_LAYOUT_ID, ...(datasetId ? { datasetId } : {}) }
}

// A cell's `colorBy.hidden` is a `Set<number>` — NOT JSON-safe: `JSON.stringify(new Set())` is `{}`,
// so a Set that rode a shallow `{...cell}` into a snapshot would (after `saveVizSession`'s
// `JSON.stringify` + reload's parse) hydrate as `{}` and crash the render at `[...c.colorBy.hidden]`
// / `hidden.has(code)`. `toJsonSafeCell` converts `hidden` → an array on SERIALIZE (and detaches
// `colorBy` from live state); `fromSnapshotCell` re-inflates it to a `Set` on HYDRATE (accepting an
// array from the JSON path OR a Set from the in-memory capture→restore path). Both deep-copy the
// mutable nested objects so a later store mutation can't retro-edit a captured snapshot.
function toJsonSafeCell(cell: GridCell): GridCell {
  // Deep-copy EVERY nested field (colorBy.palette/categoryColors/categoryLabels, bindings, …) so a
  // later in-place store mutation can't retro-edit a captured snapshot. `structuredClone` also
  // clones the `hidden` Set — which we THEN downgrade to an array for JSON safety (`JSON.stringify`
  // turns a Set into `{}`).
  const c = structuredClone(cell) as GridCell
  if (c.colorBy) {
    const h = c.colorBy.hidden as unknown as Iterable<number> | undefined
    ;(c.colorBy as { hidden: unknown }).hidden = h ? [...h] : []
  }
  return c
}
function fromSnapshotCell(cell: GridCell): GridCell {
  const c = structuredClone(cell) as GridCell
  if (c.colorBy) {
    // Inflate `hidden` back to a Set — accepts an array (JSON path) OR a Set (in-memory path).
    const h = c.colorBy.hidden as unknown as Iterable<number> | undefined
    ;(c.colorBy as { hidden: unknown }).hidden = new Set(h ?? [])
  }
  return c
}

/** A channel's VOCABULARY key — the pair that decides whether one chart's binding is meaningful on
 *  another's channel. Two channels share a vocabulary iff they share BOTH id and source. A `value`
 *  column pick is meaningful on any other chart's `value:'value'` channel and on none of its
 *  `value:'continuous'` ones, which is the whole rule. */
const vocab = (id: string, source: string): string => `${id}:${source}`

/**
 * Fold a cell's CURRENT bindings into its memo, keyed by vocabulary (see `GridCell.bindingMemo`).
 * Only channels the cell's OWN chart declares are recorded, so a pick made for one vocabulary can
 * never be re-attributed to a channel that never held it.
 */
function rememberBindings(cell: GridCell): Readonly<Record<string, string | readonly string[]>> {
  const memo: Record<string, string | readonly string[]> = { ...cell.bindingMemo }
  const schema = getChartType(cell.kind)?.bindingSchema
  if (cell.bindings && schema) {
    for (const ch of schema) {
      if (Object.prototype.hasOwnProperty.call(cell.bindings, ch.id)) {
        memo[vocab(ch.id, ch.source)] = cell.bindings[ch.id]
      }
    }
  }
  return memo
}

/**
 * The bindings the TARGET kind starts from: for each channel the target declares, the last pick
 * this cell held for that same VOCABULARY.
 *
 * This subsumes the data-shape-aware carry it replaced. That rule kept a channel iff the target
 * and source declared the same `id` AND `source`, reading it off the live `bindings` — and since
 * `rememberBindings` folds those same live bindings into the memo under exactly that key first,
 * a memo lookup reproduces every carry it made, with identical values. Keeping both was keeping
 * two spellings of one rule plus a precedence question between them that no input could ever make
 * observable (measured: mutating the precedence killed no test, because the two can never
 * disagree).
 *
 * What the memo adds is the part the carry got wrong. A channel of a DIFFERENT vocabulary is still
 * not carried — a value column must not ride onto a continuous channel — but it is now PARKED
 * rather than forgotten. Clearing-as-forgetting is why switching a pane violin → histogram → back
 * re-resolved a catalog default and painted a different column with no sign anything was lost
 * (reported live as a `pct_mito` plot returning as a 0–50K axis).
 *
 * `undefined` (⇒ the target resolves its own catalog defaults, byte-identical to the imperative
 * path) when the target declares no channels or nothing has ever been picked for any of them.
 *
 * ── KNOWN RESIDUAL: the INTERMEDIATE hop can still change column ─────────────────────────────
 * Vocabulary is a purely SYNTACTIC test — it compares the two channels' declared `source`, and it
 * has to, because this store cannot see the catalog. A numeric column is typically catalogued as
 * BOTH a `value` and a `continuous` column, so it would satisfy histogram's `value:'continuous'`
 * channel perfectly well; the syntactic rule refuses it anyway, and histogram opens on
 * `continuousColumns[0]` instead — which may be a different column from the one the user was
 * looking at. MEASURED: violin{value:'depth'} → histogram yields no carried binding.
 *
 * That is the SAME complaint as the bug this function fixes, one hop over, and it is deliberately
 * not fixed here: deciding it correctly needs the dataset catalog at the switch site to ask "does
 * the bound column satisfy the target channel's kind?", which this store has no access to and
 * should probably not acquire — the honest home for it is the render path, which already resolves
 * a catalog. What IS fixed is the part that was reported: the ROUND TRIP is lossless, so a user
 * who switches away and back gets their own column, never a silently substituted one.
 */
function bindingsForKind(
  targetKind: CellKind,
  memo: Readonly<Record<string, string | readonly string[]>>,
): ResolvedBindings | undefined {
  const targetSchema = getChartType(targetKind)?.bindingSchema
  if (!targetSchema || targetSchema.length === 0) return undefined
  const out: Record<string, string | readonly string[]> = {}
  for (const ch of targetSchema) {
    const remembered = memo[vocab(ch.id, ch.source)]
    if (remembered !== undefined) out[ch.id] = remembered
  }
  return Object.keys(out).length > 0 ? (out as ResolvedBindings) : undefined
}

function initialState(): GridWorkspaceState {
  return {
    layout: { kind: 'leaf', id: INITIAL_CELL_ID },
    cells: { [INITIAL_CELL_ID]: makeCell(INITIAL_CELL_ID, DEFAULT_KIND) },
    containerLayouts: {},
    paneContainer: {},
    pendingClose: [],
    returnAnchors: {},
    pendingRestore: [],
    pendingPlacement: null,
    linkGroups: {},
    linkColorIdx: {},
    linkPicking: null,
    seq: 1,
  }
}

/** The 10 distinct LINK-GROUP colors (a link group's badge/border). Chosen for good contrast against
 *  both light + dark pane chrome; index = a group's `linkColorIdx`. */
export const LINK_GROUP_COLORS: readonly string[] = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#c026d3', '#0d9488',
]

/** The `layout` value when the grid container is empty (all panes popped) — and the stable empty-layout
 *  reference a `useStore` SELECTOR returns for an absent/emptied container.
 *
 *  EXPORTED at SPLIT T (ITEM-36). `GridWorkspace.tsx` declared a byte-identical module const of its own
 *  (`EMPTY_CONTAINER_LAYOUT`) for the second purpose; it is deleted in favour of this one. Both were
 *  module-level, so the identity contract the selector depends on is unchanged — a fresh object per call
 *  would make the selector return a new reference on every store read. Two consts for one value was a
 *  genuine duplicate, not two concepts (DEC-18 rule 4's delete-don't-carry clause). */
export const EMPTY_GRID_LAYOUT: LayoutNode = { kind: 'leaf', id: EMPTY_GRID_ID }

/** Build the plan's `layoutByContainer` model from the store's split grid + non-grid trees. */
function toContainerModel(s: GridWorkspaceState): ContainerModel {
  const layoutByContainer: Record<string, LayoutNode> = { ...s.containerLayouts }
  if (!(s.layout.kind === 'leaf' && s.layout.id === EMPTY_GRID_ID)) {
    layoutByContainer[PRIMARY_CONTAINER] = s.layout
  }
  return { layoutByContainer, paneContainer: s.paneContainer }
}

/** Fold a `ContainerModel` back into the store fields (grid → `layout`, rest → `containerLayouts`). */
function fromContainerModel(
  model: ContainerModel,
): Pick<GridWorkspaceState, 'layout' | 'containerLayouts' | 'paneContainer'> {
  const { [PRIMARY_CONTAINER]: primary, ...rest } = model.layoutByContainer as Record<string, LayoutNode>
  return { layout: primary ?? EMPTY_GRID_LAYOUT, containerLayouts: rest, paneContainer: model.paneContainer }
}

// Plain-zustand store (no @ziee SDK): `create()(subscribeWithSelector(builder))` with
// NO immer — reproduces exactly what `defineStore()` (immer omitted → plain shallow-merge)
// composed. The builder spreads `initialState()` + the actions into one flat state object;
// every mutation returns a partial (`set(prev => ({...}))`) and rebuilds the tree from plain
// state via the pure `splitTree` helpers. subscribeWithSelector keeps the bound
// `useGridWorkspaceStore` hook's surface identical (selector reads, `.getState()`,
// `.subscribe(...)`, actions) for every consumer.
//
// PER-INSTANCE ISOLATION (VIZ_ISOLATION W1): the store DEFINITION is extracted into the
// `createGridWorkspaceStore()` factory (a fresh, independent bound store per call);
// `useGridWorkspaceStore` is the DEFAULT module singleton (factory invoked once) with a
// byte-identical public API. No existing consumer changes.
export function createGridWorkspaceStore() {
  return create<GridWorkspaceState & GridWorkspaceActions>()(
    subscribeWithSelector((set, get) => {
    // Shared split primitive both `splitCell` and `addCell` route through (so
    // addCell need not reach for a sibling action). `containerId` selects which
    // container's tree to split — `'grid'` is byte-identical to the pre-docking path.
    const performSplit = (
      cellId: string,
      dir: SplitDir,
      kind: CellKind,
      containerId: ContainerId,
      datasetId?: string,
    ): string => {
      const s = get()
      if (!s.cells[cellId]) return ''
      const newId = `cell-${s.seq + 1}`
      if (containerId === PRIMARY_CONTAINER) {
        // BYTE-IDENTICAL to the pre-docking single-tree split.
        set(prev => ({
          layout: splitLeaf(prev.layout, cellId, dir, newId),
          cells: { ...prev.cells, [newId]: makeCell(newId, kind, datasetId) },
          seq: prev.seq + 1,
        }))
        return newId
      }
      // Popup container: split within ITS tree; the new pane is assigned to that container.
      const tree = s.containerLayouts[containerId]
      if (!tree || !leafIds(tree).includes(cellId)) return ''
      set(prev => ({
        containerLayouts: {
          ...prev.containerLayouts,
          [containerId]: splitLeaf(prev.containerLayouts[containerId], cellId, dir, newId),
        },
        cells: { ...prev.cells, [newId]: makeCell(newId, kind, datasetId) },
        paneContainer: { ...prev.paneContainer, [newId]: containerId },
        seq: prev.seq + 1,
      }))
      return newId
    }

    return {
      ...initialState(),
      splitCell: (cellId, dir, kind = DEFAULT_KIND, containerId = PRIMARY_CONTAINER, datasetId?: string) =>
        performSplit(cellId, dir, kind, containerId, datasetId),

      addCell: (dir = 'col', kind = DEFAULT_KIND, containerId = PRIMARY_CONTAINER, datasetId?: string) => {
        const tree = containerId === PRIMARY_CONTAINER ? get().layout : get().containerLayouts[containerId]
        const ids = tree ? leafIds(tree) : []
        // Recover the PRIMARY empty state (every pane popped out → the empty-grid sentinel): seed a
        // fresh ROOT cell so the grid is always re-populatable (fixes the zero-cell dead-end). A
        // NON-existent popup container stays a no-op — seeding a cell there would orphan it (no window).
        const emptyPrimary =
          containerId === PRIMARY_CONTAINER && (ids.length === 0 || (ids.length === 1 && ids[0] === EMPTY_GRID_ID))
        if (emptyPrimary) return get().placeNewCell(PRIMARY_CONTAINER, { kind: 'root' }, kind)
        const target = ids[ids.length - 1]
        if (!target) return ''
        return performSplit(target, dir, kind, containerId, datasetId)
      },

      removeCell: (cellId, containerId = PRIMARY_CONTAINER) =>
        set(prev => {
          // GLOBAL invariant: the workspace always keeps ≥1 cell across ALL containers. Refuse to
          // delete the last one, wherever it lives — else popping a cell out then Removing it inside the
          // popup strands the workspace empty AND unrecoverable (add/split/request all no-op on an
          // empty grid). This subsumes the pre-docking single-window "keep ≥1 cell" guard.
          if (Object.keys(prev.cells).length <= 1) return {}
          if (containerId === PRIMARY_CONTAINER) {
            if (!leafIds(prev.layout).includes(cellId)) return {} // not a primary cell
            const next = removeLeaf(prev.layout, cellId)
            const cells = { ...prev.cells }
            delete cells[cellId]
            // The primary MAY legitimately empty now — its last cell removed while others live in popups
            // (global cells > 1, checked above) → the empty-grid sentinel, not a blocked no-op.
            return { layout: next ?? EMPTY_GRID_LAYOUT, cells }
          }
          // Popup container: remove from ITS tree. Removing the last pane empties the popup →
          // queue it for close (mirrors `movePane`'s emptied-signal); the pane is deleted, not moved.
          const tree = prev.containerLayouts[containerId]
          if (!tree || !leafIds(tree).includes(cellId)) return {}
          const next = removeLeaf(tree, cellId)
          const cells = { ...prev.cells }
          delete cells[cellId]
          const paneContainer = { ...prev.paneContainer }
          delete paneContainer[cellId]
          if (next === null) {
            const containerLayouts = { ...prev.containerLayouts }
            delete containerLayouts[containerId]
            const pendingClose = prev.pendingClose.includes(containerId)
              ? prev.pendingClose
              : [...prev.pendingClose, containerId]
            return { containerLayouts, cells, paneContainer, pendingClose }
          }
          return {
            containerLayouts: { ...prev.containerLayouts, [containerId]: next },
            cells,
            paneContainer,
          }
        }),

      resizeDivider: (path, dividerIndex, deltaFraction, containerId = PRIMARY_CONTAINER) =>
        set(prev => {
          if (containerId === PRIMARY_CONTAINER) {
            return { layout: resizeDividerTree(prev.layout, path, dividerIndex, deltaFraction) }
          }
          const tree = prev.containerLayouts[containerId]
          if (!tree) return {}
          return {
            containerLayouts: {
              ...prev.containerLayouts,
              [containerId]: resizeDividerTree(tree, path, dividerIndex, deltaFraction),
            },
          }
        }),

      setCellKind: (cellId, kind) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          // A same-kind call is a no-op that MUST preserve `bindings`.
          if (existing.kind === kind) return {}
          // Data-shape-aware preserve: a switch to a COMPATIBLE type carries over the channels
          // the target ALSO declares (violin→box→bar keeps the value/group picks); a channel of a
          // DIFFERENT vocabulary is not carried (the round-2 stale-binding fix) so a wrong-kind
          // column can't survive onto the new chart. It is PARKED in the memo instead of dropped,
          // so switching back restores the user's own pick rather than re-resolving a catalog
          // default onto a different column.
          const bindingMemo = rememberBindings(existing)
          const bindings = bindingsForKind(kind, bindingMemo)
          return {
            cells: { ...prev.cells, [cellId]: { ...existing, kind, bindings, bindingMemo } },
          }
        }),

      toggleCellGraphOverlay: cellId =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          return {
            cells: {
              ...prev.cells,
              [cellId]: { ...existing, graphOverlay: !existing.graphOverlay },
            },
          }
        }),

      setCellColorBy: (cellId, colorBy) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          return { cells: { ...prev.cells, [cellId]: { ...existing, colorBy } } }
        }),

      setCellStyle: (cellId, style) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          // MERGE (radius/opacity set independently); a field passed as `undefined` clears it. Prune an
          // emptied style back to absent so it collapses to the byte-identical no-style path.
          const merged = { ...existing.style, ...style }
          const cleaned: { radius?: number; opacity?: number } = {}
          if (typeof merged.radius === 'number') cleaned.radius = merged.radius
          if (typeof merged.opacity === 'number') cleaned.opacity = merged.opacity
          const next = { ...existing } as typeof existing
          if (cleaned.radius === undefined && cleaned.opacity === undefined) delete next.style
          else next.style = cleaned
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellTitles: (cellId, titles) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          // Plot title: '' clears (falls back to the View default); a non-empty string sets it.
          if (titles.title !== undefined) {
            if (titles.title === '') delete next.title
            else next.title = titles.title
          }
          // Axis titles: merge x/y; '' clears that axis. Prune an emptied axisTitles back to absent.
          if (titles.x !== undefined || titles.y !== undefined) {
            const ax = { ...existing.axisTitles }
            if (titles.x !== undefined) {
              if (titles.x === '') delete ax.x
              else ax.x = titles.x
            }
            if (titles.y !== undefined) {
              if (titles.y === '') delete ax.y
              else ax.y = titles.y
            }
            if (ax.x === undefined && ax.y === undefined) delete next.axisTitles
            else next.axisTitles = ax
          }
          // Legend title: '' clears (falls back to the colorBy/group column name); non-empty sets it.
          if (titles.legendTitle !== undefined) {
            if (titles.legendTitle === '') delete next.legendTitle
            else next.legendTitle = titles.legendTitle
          }
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellShowGrid: (cellId, show) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          // Default is ON, so store the field only when hiding (true ⇒ drop it back to the default).
          const next = { ...existing } as typeof existing
          if (show) delete next.showGrid
          else next.showGrid = false
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellShowLegend: (cellId, show) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (show) delete next.showLegend
          else next.showLegend = false
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellLegendCorner: (cellId, corner) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (corner === 'tr') delete next.legendCorner // 'tr' is the default → store nothing
          else next.legendCorner = corner
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellLegendBeside: (cellId, beside) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (beside) next.legendBeside = true
          else delete next.legendBeside // false is the default → store nothing
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellValueColormap: (cellId, colormap) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          next.valueColormap = colormap
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      applyDisplayPatches: patches =>
        set(prev => {
          if (patches.length === 0) return {}
          const cells = { ...prev.cells }
          let touched = false
          for (const p of patches) {
            const existing = cells[p.cellId]
            if (!existing) continue
            const next = { ...existing } as typeof existing
            if (p.channels !== undefined) next.channels = p.channels.map(c => ({ ...c, color: [...c.color] as [number, number, number], contrastLimits: [...c.contrastLimits] as [number, number] }))
            // a palette-scope patch carries `colormap` (possibly undefined ⇒ clear to per-channel colors).
            if ('colormap' in p) {
              if (p.colormap === undefined) delete next.colormap
              else next.colormap = p.colormap
            }
            cells[p.cellId] = next
            touched = true
          }
          return touched ? { cells } : {}
        }),

      setCellHiddenGroups: (cellId, codes) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (codes.length === 0) delete next.hiddenGroups
          else next.hiddenGroups = [...codes].sort((a, b) => a - b)
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellLegendHiddenCodes: (cellId, codes) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (codes.length === 0) delete next.legendHiddenCodes
          else next.legendHiddenCodes = [...codes].sort((a, b) => a - b)
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      setCellLegendUseRange: (cellId, on) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          const next = { ...existing } as typeof existing
          if (on) next.legendUseRange = true
          else delete next.legendUseRange
          return { cells: { ...prev.cells, [cellId]: next } }
        }),

      // ── SELECTION LINK groups ─────────────────────────────────────────────────────────────
      startLinkPicking: cellId =>
        set(prev => {
          const already = Object.entries(prev.linkGroups).find(([, ids]) => ids.includes(cellId))
          if (already) return { linkPicking: { groupId: already[0] } }
          if (Object.keys(prev.linkGroups).length >= 10) return {} // max 10 groups (distinct colors)
          const used = new Set(Object.values(prev.linkColorIdx))
          let colorIdx = 0
          while (used.has(colorIdx) && colorIdx < 9) colorIdx++
          const groupId = `lg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`
          return {
            linkGroups: { ...prev.linkGroups, [groupId]: [cellId] },
            linkColorIdx: { ...prev.linkColorIdx, [groupId]: colorIdx },
            linkPicking: { groupId },
          }
        }),
      addCellToLinkGroup: cellId =>
        set(prev => {
          const pick = prev.linkPicking
          if (!pick) return {}
          const groups: Record<string, string[]> = {}
          for (const [gid, ids] of Object.entries(prev.linkGroups)) {
            groups[gid] = gid === pick.groupId ? ids : ids.filter(id => id !== cellId) // one group per cell
          }
          const cur = groups[pick.groupId] ?? []
          if (!cur.includes(cellId)) groups[pick.groupId] = [...cur, cellId]
          // Drop any now-empty OTHER group.
          const colors = { ...prev.linkColorIdx }
          for (const gid of Object.keys(groups)) {
            if (gid !== pick.groupId && groups[gid].length === 0) {
              delete groups[gid]
              delete colors[gid]
            }
          }
          return { linkGroups: groups, linkColorIdx: colors }
        }),
      finishLinkPicking: () =>
        set(prev => {
          const pick = prev.linkPicking
          if (!pick) return { linkPicking: null }
          const ids = prev.linkGroups[pick.groupId] ?? []
          if (ids.length < 2) {
            const groups = { ...prev.linkGroups }
            const colors = { ...prev.linkColorIdx }
            delete groups[pick.groupId]
            delete colors[pick.groupId]
            return { linkGroups: groups, linkColorIdx: colors, linkPicking: null }
          }
          return { linkPicking: null }
        }),
      removeCellFromLinkGroup: cellId =>
        set(prev => {
          const entry = Object.entries(prev.linkGroups).find(([, ids]) => ids.includes(cellId))
          if (!entry) return {}
          const [gid, ids] = entry
          const remaining = ids.filter(id => id !== cellId)
          const groups = { ...prev.linkGroups }
          const colors = { ...prev.linkColorIdx }
          if (remaining.length < 2) {
            delete groups[gid]
            delete colors[gid]
          } else {
            groups[gid] = remaining
          }
          return { linkGroups: groups, linkColorIdx: colors }
        }),
      unlinkGroup: groupId =>
        set(prev => {
          const groups = { ...prev.linkGroups }
          const colors = { ...prev.linkColorIdx }
          delete groups[groupId]
          delete colors[groupId]
          return {
            linkGroups: groups,
            linkColorIdx: colors,
            linkPicking: prev.linkPicking?.groupId === groupId ? null : prev.linkPicking,
          }
        }),

      setCellTypography: (cellId, patch) =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          // Deep-merge: figure-wide fields shallow-merge; per-element overrides merge one level down so a
          // tick-size edit doesn't wipe a tick-family override.
          const cur = existing.typography ?? {}
          const merged: Typography = {
            ...cur,
            ...patch,
            ...(patch.title !== undefined ? { title: { ...cur.title, ...patch.title } } : {}),
            ...(patch.axis !== undefined ? { axis: { ...cur.axis, ...patch.axis } } : {}),
            ...(patch.tick !== undefined ? { tick: { ...cur.tick, ...patch.tick } } : {}),
            ...(patch.legend !== undefined ? { legend: { ...cur.legend, ...patch.legend } } : {}),
          }
          return { cells: { ...prev.cells, [cellId]: { ...existing, typography: merged } } }
        }),

      toggleCellLinkColorScale: cellId =>
        set(prev => {
          const existing = prev.cells[cellId]
          if (!existing) return {}
          return {
            cells: {
              ...prev.cells,
              [cellId]: { ...existing, linkColorScale: !existing.linkColorScale },
            },
          }
        }),

      swapCells: (idA, idB) =>
        set(prev => {
          if (idA === idB) return {}
          const a = prev.cells[idA]
          const b = prev.cells[idB]
          if (!a || !b) return {}
          const [aNext, bNext] = swapCellContent(a, b)
          return { cells: { ...prev.cells, [idA]: aNext, [idB]: bNext } }
        }),

      movePane: (cellId, toContainer, dropTarget) =>
        set(prev => {
          const from = prev.paneContainer[cellId] ?? PRIMARY_CONTAINER
          // RETURN-POSITION memory (P5 §6): a pane LEAVING the main remembers its former main slot so a
          // later non-drag return (popup closed) docks it roughly where it was; a pane arriving BACK in
          // the main clears its anchor (it now has a live slot again).
          const returnAnchors = { ...prev.returnAnchors }
          if (from === PRIMARY_CONTAINER && toContainer !== PRIMARY_CONTAINER) {
            const anchor = slotAnchorOf(prev.layout, cellId)
            if (anchor) returnAnchors[cellId] = anchor
            else delete returnAnchors[cellId]
          } else if (toContainer === PRIMARY_CONTAINER) {
            delete returnAnchors[cellId]
          }
          const { model, emptied } = pureMovePane(toContainerModel(prev), cellId, toContainer, dropTarget)
          // A pane moving INTO a container REVIVES it — drop it from pendingClose (else the window
          // owner closes a window that now holds a pane, orphaning it). `emptied` (=source) is always
          // != toContainer, so draining the target then re-adding the source never conflicts.
          const drained = prev.pendingClose.filter(c => c !== toContainer)
          return {
            ...fromContainerModel(model),
            returnAnchors,
            pendingClose: emptied ? [...drained, emptied] : drained,
          }
        }),

      returnPaneToGrid: (cellId, remembered) =>
        set(prev => {
          // Best-effort restore to the pane's remembered main slot (explicit arg wins; else the anchor
          // recorded at move-out); a stale anchor falls back to append inside `pureReturnToGrid`.
          const anchor = remembered ?? prev.returnAnchors[cellId]
          const { model, emptied } = pureReturnToGrid(toContainerModel(prev), cellId, anchor)
          const returnAnchors = { ...prev.returnAnchors }
          delete returnAnchors[cellId]
          // Dedup the close queue (mirror movePane/removeCell) — a container can't be queued twice.
          const pendingClose =
            emptied && !prev.pendingClose.includes(emptied)
              ? [...prev.pendingClose, emptied]
              : prev.pendingClose
          return { ...fromContainerModel(model), returnAnchors, pendingClose }
        }),

      acknowledgeContainerClose: containerId =>
        set(prev => ({ pendingClose: prev.pendingClose.filter(c => c !== containerId) })),

      mergeRestoredToPrimary: () =>
        set(prev => {
          const pending = new Set(prev.pendingRestore)
          let model = toContainerModel(prev)
          const returnAnchors = { ...prev.returnAnchors }
          // Fold every pane in a PENDING-restore popup back into the main, best-effort to its remembered
          // slot. Iterate a stable snapshot of the assignment (the model mutates as we go). Clear ONLY
          // the merged panes' anchors and PRESERVE `pendingClose` — an already-reopened (non-pending)
          // popup keeps its panes + return memory + any queued close.
          for (const [cellId, container] of Object.entries(prev.paneContainer)) {
            if (pending.has(container)) {
              model = pureReturnToGrid(model, cellId, prev.returnAnchors[cellId]).model
              delete returnAnchors[cellId]
            }
          }
          return { ...fromContainerModel(model), returnAnchors, pendingRestore: [], pendingClose: prev.pendingClose }
        }),

      resolveRestored: opened =>
        set(prev => ({ pendingRestore: prev.pendingRestore.filter(c => !opened.includes(c)) })),

      requestAddCell: (dir = 'col', kind = DEFAULT_KIND) => {
        const s = get()
        if (s.pendingPlacement) return '' // already aiming — ignore a second request (no double-arm)
        const hasPopups = Object.values(s.paneContainer).some(c => c !== PRIMARY_CONTAINER)
        // Fast path (no popup open) → add directly to the main, byte-identical to `addCell`. With a
        // popup open, defer to aim-to-place: set the pending request; the main grid drives placement.
        if (!hasPopups) return s.addCell(dir, kind)
        set({ pendingPlacement: { kind } })
        return ''
      },

      placeNewCell: (container, dropTarget, kind = DEFAULT_KIND) => {
        const newId = `cell-${get().seq + 1}`
        set(prev => {
          const model = toContainerModel(prev)
          const layoutByContainer: Record<string, LayoutNode> = { ...model.layoutByContainer }
          layoutByContainer[container] = pureInsertLeaf(layoutByContainer[container], newId, dropTarget)
          const paneContainer: Record<string, ContainerId> = { ...model.paneContainer }
          if (container !== PRIMARY_CONTAINER) paneContainer[newId] = container
          return {
            ...fromContainerModel({ layoutByContainer, paneContainer }),
            cells: { ...prev.cells, [newId]: makeCell(newId, kind) },
            seq: prev.seq + 1,
            pendingPlacement: null,
          }
        })
        return newId
      },

      cancelPlacement: () => set({ pendingPlacement: null }),

      reset: () => set(() => initialState()),

      serialize: () => {
        const s = get()
        const cells: Record<string, GridCell> = {}
        for (const [id, cell] of Object.entries(s.cells)) cells[id] = toJsonSafeCell(cell)
        // Deep-copy the RESOLVED main-grid tree (nested splits + `sizes`) so the captured slice is
        // JSON-safe + detached from live state (a later mutation can't retro-edit the snapshot). The
        // tree passes through unchanged, so serialize→hydrate reproduces every split/swap/resize
        // byte-for-byte; a single-leaf `layout` stays byte-identical to the pre-docking single tree.
        const slice: GridWorkspaceSlice = { layout: structuredClone(s.layout), cells, seq: s.seq }
        // Docking P5/DEC-15: capture the multi-container layout ONLY when a pane is actually docked
        // out (a single-window session stays byte-identical to the P2 slice — no docking keys). Emit
        // BOTH the legacy flat fields (back-compat with existing consumers) AND the consolidated
        // `docking` snapshot (the VizOption-facing shape). `pendingPlacement` is TRANSIENT and is
        // never part of the slice — aim-to-place is a gesture, not option state (DEC-5b).
        if (Object.keys(s.paneContainer).length > 0) {
          slice.containerLayouts = structuredClone(s.containerLayouts)
          slice.paneContainer = structuredClone(s.paneContainer)
          if (Object.keys(s.returnAnchors).length > 0) slice.returnAnchors = structuredClone(s.returnAnchors)
          slice.docking = {
            containers: Object.entries(s.containerLayouts).map(([id, layout]) => ({
              id: id as ContainerId,
              layout: structuredClone(layout),
            })),
            paneContainer: structuredClone(s.paneContainer),
            anchors: structuredClone(s.returnAnchors),
          }
        }
        return slice
      },

      hydrate: slice => {
        // Reconcile the docking state from the CONSOLIDATED `docking` snapshot (DEC-15) when present,
        // else the LEGACY flat fields (back-compat with pre-DEC-15 slices) — both resolve to the same
        // three store fields.
        const docking = slice.docking
        const containerLayouts: Record<string, LayoutNode> = docking
          ? Object.fromEntries(docking.containers.map(c => [c.id, structuredClone(c.layout)]))
          : slice.containerLayouts
            ? structuredClone(slice.containerLayouts)
            : {}
        const paneContainer: Record<string, ContainerId> = docking
          ? structuredClone(docking.paneContainer)
          : slice.paneContainer
            ? structuredClone(slice.paneContainer)
            : {}
        const returnAnchors: Record<string, DropTarget> = docking
          ? structuredClone(docking.anchors)
          : slice.returnAnchors
            ? structuredClone(slice.returnAnchors)
            : {}
        // Advance the popup-id allocator past any RESTORED popup container id so a later new popup can't
        // collide with a restored one (the module counter resets to 0 each page life). Side-effect
        // BEFORE the reducer.
        if (Object.keys(paneContainer).length > 0) seedPopupCounterFrom(Object.values(paneContainer))
        set(() => {
          const cells: Record<string, GridCell> = {}
          for (const [id, cell] of Object.entries(slice.cells)) cells[id] = fromSnapshotCell(cell)
          // Docking P5: restore the multi-container layout when the snapshot carried one. A restore
          // CANNOT re-open popup windows (no user gesture on reload), so the restored popup containers
          // are listed in `pendingRestore` and the UI offers a choice (merge to main / reopen windows).
          // A single-window snapshot (no docking keys) restores exactly as before.
          const pendingRestore = [...new Set(Object.values(paneContainer))].filter(
            (c): c is ContainerId => c !== PRIMARY_CONTAINER,
          )
          return {
            layout: slice.layout,
            cells,
            seq: slice.seq,
            containerLayouts,
            paneContainer,
            pendingClose: [],
            returnAnchors,
            pendingRestore,
            pendingPlacement: null,
          }
        })
      },
      }
    }),
  )
}

/** A bound GridWorkspace store instance (the factory's return type). */
export type GridWorkspaceStore = ReturnType<typeof createGridWorkspaceStore>

/** The DEFAULT module-singleton GridWorkspace store — byte-identical to the pre-factory
 *  export. Existing consumers importing `useGridWorkspaceStore` are unaffected. */
export const useGridWorkspaceStore: GridWorkspaceStore = createGridWorkspaceStore()
