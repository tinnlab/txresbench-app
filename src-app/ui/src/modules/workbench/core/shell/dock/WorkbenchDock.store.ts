// WorkbenchDock.store (ITEM-8) — the per-project dock store over `@txresbench/dock`'s
// `ContainerModel`. It is the workbench's `@txresbench/dock` CONSUMER store — the twin of viz's
// `GridWorkspace.store` (`toContainerModel`/`fromContainerModel`, `movePane`, aim-to-place,
// serialize/hydrate) — but its content is `WorkbenchPane`s (not `GridCell`s) and its
// PERSISTENCE is split: the MAIN (`'main'`) layout persists PER-PROJECT to localStorage
// (shared across a user's tabs, like `WorkbenchLayout.store`) while the POPUP layouts
// persist PER-TAB to sessionStorage (a pop-out window belongs to the tab that opened it).
//
// Plain-zustand factory (mirrors viz's `createGridWorkspaceStore`) so it's isolable per
// unit test AND per project; a module-singleton `workbenchDockStore` is the app instance.
// All mutations rebuild the tree via the pure `@txresbench/dock` ops (no immer).

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  type LayoutNode,
  type SplitNode,
  type SplitDir,
  type ContainerId,
  type ContainerModel,
  type DropTarget,
  splitLeaf,
  removeLeaf,
  resizeDivider as resizeDividerTree,
  computeRects,
  leafIds,
  movePane as pureMovePane,
  returnToPrimary as pureReturnToMain,
  slotAnchorOf,
  insertLeaf as pureInsertLeaf,
  seedPopupCounterFrom,
  closePopupWindow,
  getPopupWindowsSnapshot,
  PRIMARY_CONTAINER,
} from '@txresbench/dock'
import type { PaneKind, WorkbenchPane } from './paneModel'
import { type DockMainSlice, defaultMainSlice } from './defaultLayout'
import {
  loadMain,
  saveMain,
  loadPopups,
  savePopups,
  type PopupSlice,
  type DockStorages,
  defaultDockStorages,
  defaultIsReload,
} from './dockPersistence'

/** The default pane kind + how a fresh pane is minted. */
/** Stated once, HERE, beside the guard that enforces it: the dock keeps at least one pane open
 *  across all containers, or the workspace strands with nothing left to open anything from. The
 *  shell shows this as the disabled close's reason (`removeBlockedReason`). */
const LAST_PANE_KEEP_REASON = 'This is the last open pane — the workspace keeps one open.'

const DEFAULT_KIND: PaneKind = 'launcher'

/** The NEW pane's share when opening PROMINENTLY (a launched run / an opened content pane) — a
 *  majority, so the pane lands as a workable surface rather than a cramped half of the split
 *  (splitting the canvas hero, ~0.6 of the workspace, this yields a ~400px+ pane at the 1280px
 *  test viewport). The figure was originally sized against the SchemaForm STEPPER's ~380px
 *  full-mode width; that wizard has since been deleted as unreachable, so the number is now
 *  carried by the sizing outcome above and not by the stepper's compact threshold. */
const PROMINENT_WEIGHT = 0.7

/** TRANSIENT pane kinds — session outputs (an analysis RUN / its ARTIFACT) that are re-openable from
 *  the launcher/history and are NOT persisted across a page load (so a fresh workbench opens clean;
 *  the DURABLE structure + divider sizes + popups persist).
 *
 *  The two HOSTED-SURFACE kinds are transient for a stronger reason than convenience: their pane is
 *  a PROJECTION of a canvas surface being open (`paneSurfaceHost.tsx`), and nothing re-opens that
 *  surface on a reload. A persisted one would come back as a permanently empty tab that the shell
 *  offers no way to close. */
const TRANSIENT_KINDS: ReadonlySet<PaneKind> = new Set<PaneKind>([
  'run',
  'artifact',
  'edit-plot',
  'data-table',
  'export',
])

/** The `layout` value when the `main` container is EMPTY (every pane popped into windows). */
const EMPTY_MAIN_ID = '__workbench-empty-main__'
const EMPTY_MAIN_LAYOUT: LayoutNode = { kind: 'leaf', id: EMPTY_MAIN_ID }

/** A NEW-pane request that entered aim-to-place (a popup is open) — the pane to create once
 *  the user clicks a spot. */
export interface PendingPlacement {
  kind: PaneKind
  ref?: string
}

/** The serializable dock session slice (mirrors viz's `GridWorkspaceSlice`). A single-window
 *  session emits NO docking keys (`containerLayouts`/`paneContainer` absent) — back-compat. */
export interface DockSlice {
  layout: LayoutNode
  cells: Record<string, WorkbenchPane>
  seq: number
  containerLayouts?: Record<string, LayoutNode>
  paneContainer?: Record<string, ContainerId>
  returnAnchors?: Record<string, DropTarget>
}

export interface WorkbenchDockState {
  /** The MAIN (`'main'`) container's split-tree for the ACTIVE project. */
  layout: LayoutNode
  /** Per-pane content, keyed by pane id — GLOBAL across containers (a pane keeps its content
   *  wherever it's docked). */
  cells: Record<string, WorkbenchPane>
  /** Monotonic id counter → deterministic `pane-<n>` ids. */
  seq: number
  /** The NON-main container trees (`popup:<n>` → tree). Empty until a pane is popped out. */
  containerLayouts: Record<string, LayoutNode>
  /** Which container each pane is in — SPARSE (absent ⇒ `'main'`). */
  paneContainer: Record<string, ContainerId>
  /** Popup containers that emptied and want their window CLOSED (drained by the window owner). */
  pendingClose: ContainerId[]
  /** Return-position memory for a pane that LEFT main (best-effort re-dock on popup close). */
  returnAnchors: Record<string, DropTarget>
  /** Popup containers RESTORED from a reload whose windows aren't open yet (offer the choice). */
  pendingRestore: ContainerId[]
  /** A new-pane request awaiting aim-to-place (≥1 popup open); `null` otherwise. Transient. */
  pendingPlacement: PendingPlacement | null
  /** The active project (drives per-project persistence keys). */
  activeProjectId: string | null
  /** Persistence cache of INACTIVE projects' main slices (the active project lives in the
   *  top-level `layout`/`cells`/`seq`). */
  byProject: Record<string, DockMainSlice>
}

export interface WorkbenchDockActions {
  /** Bind a project: persist the current active project, then load `projectId`'s main from
   *  localStorage (or the default IA) + its popups from sessionStorage (reload-gated). */
  ensureProject: (projectId: string) => void
  /** Add a pane by splitting the LAST leaf of `containerId` (default `'main'`) in `dir`.
   *  Recovers an emptied main by rooting a fresh pane. Returns the new pane id. */
  addPane: (kind?: PaneKind, ref?: string, dir?: SplitDir, containerId?: ContainerId) => string
  /** Split the pane `paneId` in `dir`, inserting a fresh pane beside it. Returns the new id
   *  ('' when `paneId` isn't a leaf of that container). */
  splitPane: (
    paneId: string,
    dir: SplitDir,
    kind?: PaneKind,
    ref?: string,
    containerId?: ContainerId,
  ) => string
  /** Remove a pane (collapsing single-child splits). Keeps ≥1 pane across ALL containers; a
   *  popup emptied by the removal is queued for close. Returns whether a pane was actually removed
   *  (FALSE on the last-pane keep-≥1 no-op or a non-leaf id) — callers gate `clearPaneState` on it. */
  removePane: (paneId: string, containerId?: ContainerId) => boolean
  /** Every open pane's id, across all containers. */
  paneIds: () => string[]
  /** The id of the first open pane matching `(kind, ref)`, across all containers, or `''`.
   *  Lets an off-instance affordance target a specific content pane without scanning the pane
   *  map itself (keeping that read here, where it belongs). */
  paneIdForRef: (kind: PaneKind, ref: string) => string
  /** Every open PANE, across all containers — the object form of {@link paneIds}, for a shell
   *  read that needs each pane's `kind`/`ref` (e.g. `entityLifecycle`, which asks every pane
   *  which entity it is bound to). Same reason `paneIds` exists: the shell reads the open-pane
   *  set through an accessor instead of re-spelling the dock's pane map at each site. */
  panes: () => WorkbenchPane[]
  /**
   * Why `removePane` would REFUSE right now, in words a user can read — or `null` when it would
   * succeed. The shell renders the close DISABLED with this as its reason rather than offering a
   * control that silently does nothing (`RegionShell`), and it reads the rule from HERE so the
   * affordance and the guard below cannot drift apart.
   */
  removeBlockedReason: () => string | null
  /** Move the divider `dividerIndex` of the split at `path` by `deltaFraction` (clamped).
   *  Delegates to `@txresbench/dock`'s `resizeDivider`. */
  resizeDivider: (
    path: number[],
    dividerIndex: number,
    deltaFraction: number,
    containerId?: ContainerId,
  ) => void
  /** Commit a split's full `sizes` vector (the renderer's on-release path) by FOLDING
   *  `@txresbench/dock`'s `resizeDivider` per divider — so a divider drag persists to the tree. */
  commitSizes: (path: number[], sizes: number[], containerId?: ContainerId) => void
  /** Swap the CONTENT (`kind`/`ref`) of two panes (drag-to-swap) — trades their display while
   *  KEEPING each pane's id + position/divider sizes. No-op if either id is missing or equal. */
  swapPanes: (idA: string, idB: string) => void
  /** MOVE a pane into `toContainer` at `dropTarget` (removes from its source, which reflows;
   *  records a return anchor; queues an emptied source popup for close). */
  movePane: (paneId: string, toContainer: ContainerId, dropTarget: DropTarget) => void
  /** RETURN a pane to main (popup closed without dragging back) — best-effort to its anchor. */
  returnPaneToMain: (paneId: string, remembered?: DropTarget) => void
  /** Drain a container from `pendingClose` once its window has been closed. */
  acknowledgeContainerClose: (containerId: ContainerId) => void
  /** Session-restore: FOLD every pending popup's panes back into main + clear restore state. */
  mergeRestoredToMain: () => void
  /** Session-restore: drain the REOPENED popup containers from `pendingRestore`. */
  resolveRestored: (opened: ContainerId[]) => void
  /** Request a new pane (aim-to-place): with NO popup open → add to main directly (returns the
   *  id); with ≥1 popup open → defer to placement (returns '', pane created by `placeNewPane`). */
  requestAddPane: (kind?: PaneKind, ref?: string, dir?: SplitDir) => string
  /** Aim-to-place: CREATE a new pane in `container` at `dropTarget` (the clicked spot). */
  placeNewPane: (container: ContainerId, dropTarget: DropTarget, kind?: PaneKind, ref?: string) => string
  /** Aim-to-place: DISCARD the pending new pane (Escape). */
  cancelPlacement: () => void
  /** Open a RUN pane bound to `analysisId` (the `analysis.launch` action's store target).
   *  Returns the new pane id. */
  openRunPane: (analysisId: string, ref?: string) => string
  /** True while ≥1 popup container is open (drives aim-to-place vs. direct add). */
  hasPopups: () => boolean
  /** Reset the active project to the default IA. */
  reset: () => void
  /** Snapshot the serializable session slice (deep-copied cells). */
  serialize: () => DockSlice
  /** Replace the active workspace from a slice (restored popups land in `pendingRestore`). */
  hydrate: (slice: DockSlice, opts?: { reload?: boolean }) => void
}

type Store = WorkbenchDockState & WorkbenchDockActions

/** Deep-copy a pane (defends a captured snapshot from a later in-place mutation). */
function copyCell(cell: WorkbenchPane): WorkbenchPane {
  return { ...cell }
}
function copyCells(cells: Record<string, WorkbenchPane>): Record<string, WorkbenchPane> {
  const out: Record<string, WorkbenchPane> = {}
  for (const [id, c] of Object.entries(cells)) out[id] = copyCell(c)
  return out
}

/** The cells that belong to a layout tree's leaves (the `cells` map is GLOBAL across containers, so
 *  the MAIN slice must scope to the main layout's panes — popup panes ride the popup slice). */
function scopedCells(layout: LayoutNode, cells: Record<string, WorkbenchPane>): Record<string, WorkbenchPane> {
  const out: Record<string, WorkbenchPane> = {}
  for (const id of leafIds(layout)) if (cells[id]) out[id] = copyCell(cells[id])
  return out
}

/** The `ContainerModel` view of the store state (main → `layoutByContainer['main']`, rest →
 *  `containerLayouts`). An emptied main contributes no entry. */
function toContainerModel(s: WorkbenchDockState): ContainerModel {
  const layoutByContainer: Record<string, LayoutNode> = { ...s.containerLayouts }
  if (!(s.layout.kind === 'leaf' && s.layout.id === EMPTY_MAIN_ID)) {
    layoutByContainer[PRIMARY_CONTAINER] = s.layout
  }
  return { layoutByContainer, paneContainer: s.paneContainer }
}

/** Fold a `ContainerModel` back into the store's `layout`/`containerLayouts`/`paneContainer`. */
function fromContainerModel(
  model: ContainerModel,
): Pick<WorkbenchDockState, 'layout' | 'containerLayouts' | 'paneContainer'> {
  const { [PRIMARY_CONTAINER]: primary, ...rest } = model.layoutByContainer as Record<string, LayoutNode>
  return {
    layout: primary ?? EMPTY_MAIN_LAYOUT,
    containerLayouts: rest,
    paneContainer: { ...model.paneContainer },
  }
}

/** The id of the LARGEST-area leaf in `layout` (unit-box rects). Null for an empty/sentinel
 *  layout. Drives where a launched RUN pane opens so it lands in a PROMINENT region instead of
 *  being squeezed 50/50 out of the smallest sibling (a launched analysis must be VISIBLE). */
function largestLeafId(layout: LayoutNode): string | null {
  if (layout.kind === 'leaf') return layout.id === EMPTY_MAIN_ID ? null : layout.id
  const rects = computeRects(layout, 1, 1)
  let best: string | null = null
  let bestArea = -1
  for (const r of rects) {
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = r.id
    }
  }
  return best
}

/** Dedup: the id of an ALREADY-OPEN pane with the same `kind`+`ref`, or null. A singleton pane
 *  (launcher/history/jobs/lineage/…, no `ref`) matches by kind; an entity pane (run/artifact, with a
 *  `ref`) matches by kind+ref — so the same analysis/run can't open twice, but two DIFFERENT runs
 *  still can. If the match is popped out, focus its window so "open" reveals it. */
function existingPaneId(
  s: Pick<WorkbenchDockState, 'cells' | 'paneContainer'>,
  kind: PaneKind,
  ref?: string,
): string | null {
  const id = Object.keys(s.cells).find(k => s.cells[k].kind === kind && s.cells[k].ref === ref)
  if (!id) return null
  const container = s.paneContainer[id]
  if (container && container !== PRIMARY_CONTAINER) {
    try {
      getPopupWindowsSnapshot().get(container)?.focus()
    } catch {
      /* focusing a cross-origin/closed popup can throw — the dedup itself still holds */
    }
  }
  return id
}

/** The child-index path to the leaf `id` (so a fresh split at that spot can be resized), or null. */
function pathToLeaf(node: LayoutNode, id: string, path: number[] = []): number[] | null {
  if (node.kind === 'leaf') return node.id === id ? path : null
  for (let i = 0; i < node.children.length; i++) {
    const r = pathToLeaf(node.children[i], id, [...path, i])
    if (r) return r
  }
  return null
}

/** Split `leafId` in `tree`, giving the NEW pane `newWeight` of the freed space (vs. the 50/50
 *  `splitLeaf`). A prominent open (a launched run / an opened History-Jobs-Lineage-artifact pane)
 *  uses this so the new pane lands workably wide instead of as a cramped half (see
 *  `PROMINENT_WEIGHT`). `newWeight` is clamped to a sane band. */
function splitLeafWeighted(
  tree: LayoutNode,
  leafId: string,
  dir: SplitDir,
  newLeafId: string,
  newWeight: number,
): LayoutNode {
  const split = splitLeaf(tree, leafId, dir, newLeafId)
  const w = Math.max(0.1, Math.min(0.9, newWeight))
  if (Math.abs(w - 0.5) < 1e-6) return split
  const path = pathToLeaf(tree, leafId)
  if (!path) return split
  // `splitLeaf` produced [orig, new] at 0.5/0.5; move (0.5 - w) from orig (index 0) → new so the
  // new pane ends at `w`.
  return resizeDividerTree(split, path, 0, 0.5 - w)
}

/** Navigate a split-tree to the SplitNode at `path` (child-index array), or null. */
function splitAtPath(node: LayoutNode, path: number[]): SplitNode | null {
  let cur: LayoutNode = node
  for (const idx of path) {
    if (cur.kind !== 'split' || idx < 0 || idx >= cur.children.length) return null
    cur = cur.children[idx]
  }
  return cur.kind === 'split' ? cur : null
}

function initialState(): WorkbenchDockState {
  const main = defaultMainSlice()
  return {
    layout: main.layout,
    cells: main.cells,
    seq: main.seq,
    containerLayouts: {},
    paneContainer: {},
    pendingClose: [],
    returnAnchors: {},
    pendingRestore: [],
    pendingPlacement: null,
    activeProjectId: null,
    byProject: {},
  }
}

export interface DockStoreOptions {
  storages?: DockStorages
  isReload?: () => boolean
}

export function createWorkbenchDockStore(opts: DockStoreOptions = {}) {
  const storages = opts.storages ?? defaultDockStorages()
  const isReload = opts.isReload ?? defaultIsReload
  // Page-life latch (per store instance): only the FIRST project bind of a page life may consume
  // the reload's popup-restore. `isReload()` is FIXED for the whole page lifetime, so without this
  // the 2nd+ project bind on a reloaded page (an in-app nav) would still see reload===true and
  // re-offer the restore dialog for that project's stale sessionStorage popups.
  let reloadRestoreConsumed = false

  const store = create<Store>()(
    subscribeWithSelector((set, get) => {
      /** Split primitive shared by `addPane`/`splitPane`. `newWeight` (default 0.5) sizes the NEW
       *  pane's share — a prominent open passes a majority so it isn't a cramped half. */
      const performSplit = (
        paneId: string,
        dir: SplitDir,
        kind: PaneKind,
        ref: string | undefined,
        containerId: ContainerId,
        newWeight = 0.5,
      ): string => {
        const s = get()
        if (!s.cells[paneId]) return ''
        const newId = `pane-${s.seq + 1}`
        const newCell: WorkbenchPane = ref ? { id: newId, kind, ref } : { id: newId, kind }
        if (containerId === PRIMARY_CONTAINER) {
          set(prev => ({
            layout: splitLeafWeighted(prev.layout, paneId, dir, newId, newWeight),
            cells: { ...prev.cells, [newId]: newCell },
            seq: prev.seq + 1,
          }))
          return newId
        }
        const tree = s.containerLayouts[containerId]
        if (!tree || !leafIds(tree).includes(paneId)) return ''
        set(prev => ({
          containerLayouts: {
            ...prev.containerLayouts,
            [containerId]: splitLeafWeighted(prev.containerLayouts[containerId], paneId, dir, newId, newWeight),
          },
          cells: { ...prev.cells, [newId]: newCell },
          paneContainer: { ...prev.paneContainer, [newId]: containerId },
          seq: prev.seq + 1,
        }))
        return newId
      }

      return {
        ...initialState(),

        ensureProject: (projectId: string) => {
          const s = get()
          if (s.activeProjectId === projectId) return
          // 0. Close the OUTGOING project's popup OS windows. The popup registry is per-tab and the
          //    reset below drops this project's `paneContainer`, so without this drain the windows
          //    stay open + registered forever (they accumulate on every project switch).
          //    `closePopupWindow` closes + unregisters, is idempotent, and no-ops an unregistered id
          //    (a restored-but-not-reopened popup), so the normal Return/OS-close paths are unaffected.
          for (const containerId of new Set(Object.values(s.paneContainer))) {
            if (containerId !== PRIMARY_CONTAINER) closePopupWindow(containerId)
          }
          // 1. Stash the current active project's live main into the byProject cache.
          const byProject = { ...s.byProject }
          if (s.activeProjectId) {
            byProject[s.activeProjectId] = { layout: s.layout, cells: scopedCells(s.layout, s.cells), seq: s.seq }
          }
          // 2. Load the target project's main: byProject cache → localStorage → default IA.
          const persisted = loadMain(storages)
          const main = byProject[projectId] ?? persisted[projectId] ?? defaultMainSlice()
          // 3. Load the target project's popups from sessionStorage — RELOAD-GATED and page-life
          //    LATCHED: only the FIRST bind of a reloaded page offers restore (an in-app nav — incl.
          //    the 2nd+ bind of a reloaded page — can't reopen windows → start main-only).
          const reload = isReload() && !reloadRestoreConsumed
          reloadRestoreConsumed = true
          const popups = reload ? loadPopups(storages)[projectId] : undefined
          const containerLayouts = popups?.containerLayouts ? { ...popups.containerLayouts } : {}
          const paneContainer = popups?.paneContainer ? { ...popups.paneContainer } : {}
          const returnAnchors = popups?.returnAnchors ? { ...popups.returnAnchors } : {}
          const cells = popups?.cells ? { ...main.cells, ...popups.cells } : { ...main.cells }
          if (popups?.paneContainer) seedPopupCounterFrom(Object.values(popups.paneContainer))
          const pendingRestore = [...new Set(Object.values(paneContainer))].filter(
            (c): c is ContainerId => c !== PRIMARY_CONTAINER,
          )
          set({
            activeProjectId: projectId,
            byProject,
            layout: main.layout,
            cells,
            seq: main.seq,
            containerLayouts,
            paneContainer,
            pendingClose: [],
            returnAnchors,
            pendingRestore,
            pendingPlacement: null,
          })
        },

        splitPane: (paneId, dir, kind = DEFAULT_KIND, ref, containerId = PRIMARY_CONTAINER) =>
          performSplit(paneId, dir, kind, ref, containerId),

        addPane: (kind = DEFAULT_KIND, ref, dir = 'col', containerId = PRIMARY_CONTAINER) => {
          const tree =
            containerId === PRIMARY_CONTAINER ? get().layout : get().containerLayouts[containerId]
          const ids = tree ? leafIds(tree) : []
          const emptyMain =
            containerId === PRIMARY_CONTAINER &&
            (ids.length === 0 || (ids.length === 1 && ids[0] === EMPTY_MAIN_ID))
          if (emptyMain) return get().placeNewPane(PRIMARY_CONTAINER, { kind: 'root' }, kind, ref)
          const target = ids[ids.length - 1]
          if (!target) return ''
          return performSplit(target, dir, kind, ref, containerId)
        },

        paneIds: () => Object.keys(get().cells),

        paneIdForRef: (kind, ref) =>
          Object.values(get().cells).find(c => c.kind === kind && c.ref === ref)?.id ?? '',

        panes: () => Object.values(get().cells),

        removeBlockedReason: () => (get().paneIds().length <= 1 ? LAST_PANE_KEEP_REASON : null),

        removePane: (paneId, containerId = PRIMARY_CONTAINER) => {
          let removed = false
          set(prev => {
            // Keep ≥1 pane across ALL containers (else the workspace strands unrecoverable).
            if (Object.keys(prev.cells).length <= 1) return {}
            if (containerId === PRIMARY_CONTAINER) {
              if (!leafIds(prev.layout).includes(paneId)) return {}
              const next = removeLeaf(prev.layout, paneId)
              const cells = { ...prev.cells }
              delete cells[paneId]
              removed = true
              return { layout: next ?? EMPTY_MAIN_LAYOUT, cells }
            }
            const tree = prev.containerLayouts[containerId]
            if (!tree || !leafIds(tree).includes(paneId)) return {}
            const next = removeLeaf(tree, paneId)
            const cells = { ...prev.cells }
            delete cells[paneId]
            const paneContainer = { ...prev.paneContainer }
            delete paneContainer[paneId]
            removed = true
            if (next === null) {
              const containerLayouts = { ...prev.containerLayouts }
              delete containerLayouts[containerId]
              const pendingClose = prev.pendingClose.includes(containerId)
                ? prev.pendingClose
                : [...prev.pendingClose, containerId]
              return { containerLayouts, cells, paneContainer, pendingClose }
            }
            return { containerLayouts: { ...prev.containerLayouts, [containerId]: next }, cells, paneContainer }
          })
          return removed
        },

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

        commitSizes: (path, sizes, containerId = PRIMARY_CONTAINER) =>
          set(prev => {
            const tree =
              containerId === PRIMARY_CONTAINER ? prev.layout : prev.containerLayouts[containerId]
            if (!tree) return {}
            const split = splitAtPath(tree, path)
            if (!split) return {}
            let next = tree
            let now = split.sizes.slice()
            // Fold `resizeDivider` left→right so the tree ends at the target vector (the drag
            // already produced a valid layout, so no clamp fights). Delegates to @txresbench/dock.
            for (let i = 0; i < sizes.length - 1 && i < now.length - 1; i++) {
              const delta = sizes[i] - now[i]
              if (Math.abs(delta) < 1e-6) continue
              next = resizeDividerTree(next, path, i, delta, 0.02)
              const s = splitAtPath(next, path)
              now = s ? s.sizes.slice() : now
            }
            if (next === tree) return {}
            return containerId === PRIMARY_CONTAINER
              ? { layout: next }
              : { containerLayouts: { ...prev.containerLayouts, [containerId]: next } }
          }),

        swapPanes: (idA, idB) =>
          set(prev => {
            if (idA === idB) return {}
            const a = prev.cells[idA]
            const b = prev.cells[idB]
            if (!a || !b) return {}
            // Trade only the display fields (kind/ref); keep each pane's id + tree position.
            const aNext: WorkbenchPane = b.ref ? { id: a.id, kind: b.kind, ref: b.ref } : { id: a.id, kind: b.kind }
            const bNext: WorkbenchPane = a.ref ? { id: b.id, kind: a.kind, ref: a.ref } : { id: b.id, kind: a.kind }
            return { cells: { ...prev.cells, [idA]: aNext, [idB]: bNext } }
          }),

        movePane: (paneId, toContainer, dropTarget) =>
          set(prev => {
            const from = prev.paneContainer[paneId] ?? PRIMARY_CONTAINER
            const returnAnchors = { ...prev.returnAnchors }
            if (from === PRIMARY_CONTAINER && toContainer !== PRIMARY_CONTAINER) {
              const anchor = slotAnchorOf(prev.layout, paneId)
              if (anchor) returnAnchors[paneId] = anchor
              else delete returnAnchors[paneId]
            } else if (toContainer === PRIMARY_CONTAINER) {
              delete returnAnchors[paneId]
            }
            const { model, emptied } = pureMovePane(toContainerModel(prev), paneId, toContainer, dropTarget)
            const drained = prev.pendingClose.filter(c => c !== toContainer)
            return {
              ...fromContainerModel(model),
              returnAnchors,
              pendingClose: emptied ? [...drained, emptied] : drained,
            }
          }),

        returnPaneToMain: (paneId, remembered) =>
          set(prev => {
            const anchor = remembered ?? prev.returnAnchors[paneId]
            const { model, emptied } = pureReturnToMain(toContainerModel(prev), paneId, anchor)
            const returnAnchors = { ...prev.returnAnchors }
            delete returnAnchors[paneId]
            const pendingClose =
              emptied && !prev.pendingClose.includes(emptied)
                ? [...prev.pendingClose, emptied]
                : prev.pendingClose
            return { ...fromContainerModel(model), returnAnchors, pendingClose }
          }),

        acknowledgeContainerClose: containerId =>
          set(prev => ({ pendingClose: prev.pendingClose.filter(c => c !== containerId) })),

        mergeRestoredToMain: () =>
          set(prev => {
            const pending = new Set(prev.pendingRestore)
            let model = toContainerModel(prev)
            const returnAnchors = { ...prev.returnAnchors }
            for (const [paneId, container] of Object.entries(prev.paneContainer)) {
              if (pending.has(container)) {
                model = pureReturnToMain(model, paneId, prev.returnAnchors[paneId]).model
                delete returnAnchors[paneId]
              }
            }
            return { ...fromContainerModel(model), returnAnchors, pendingRestore: [], pendingClose: prev.pendingClose }
          }),

        resolveRestored: opened =>
          set(prev => ({ pendingRestore: prev.pendingRestore.filter(c => !opened.includes(c)) })),

        requestAddPane: (kind = DEFAULT_KIND, ref, dir = 'col') => {
          const s = get()
          if (s.pendingPlacement) return '' // already aiming — ignore a second request
          // Dedup: the same pane (kind+ref) can't open twice — focus the open one instead.
          const dup = existingPaneId(s, kind, ref)
          if (dup) return dup
          const anyPopup = Object.values(s.paneContainer).some(c => c !== PRIMARY_CONTAINER)
          if (!anyPopup) {
            // NO popup open → open into a PROMINENT region: split the LARGEST main leaf (the canvas
            // hero in the default IA) so a user-opened pane (History / Jobs / Lineage / an artifact /
            // rerun / compare) is immediately VISIBLE, never squeezed 50/50 out of the smallest
            // deeply-nested last leaf. Falls back to `addPane` (last-leaf split / empty-main root).
            const target = largestLeafId(s.layout)
            return target
              ? performSplit(target, dir, kind, ref, PRIMARY_CONTAINER, PROMINENT_WEIGHT) || s.addPane(kind, ref, dir)
              : s.addPane(kind, ref, dir)
          }
          set({ pendingPlacement: ref ? { kind, ref } : { kind } })
          return ''
        },

        placeNewPane: (container, dropTarget, kind = DEFAULT_KIND, ref) => {
          const newId = `pane-${get().seq + 1}`
          const newCell: WorkbenchPane = ref ? { id: newId, kind, ref } : { id: newId, kind }
          set(prev => {
            const model = toContainerModel(prev)
            const layoutByContainer: Record<string, LayoutNode> = { ...model.layoutByContainer }
            layoutByContainer[container] = pureInsertLeaf(layoutByContainer[container], newId, dropTarget)
            const paneContainer: Record<string, ContainerId> = { ...model.paneContainer }
            if (container !== PRIMARY_CONTAINER) paneContainer[newId] = container
            return {
              ...fromContainerModel({ layoutByContainer, paneContainer }),
              cells: { ...prev.cells, [newId]: newCell },
              seq: prev.seq + 1,
              pendingPlacement: null,
            }
          })
          return newId
        },

        cancelPlacement: () => set({ pendingPlacement: null }),

        openRunPane: (analysisId, ref) => {
          const s = get()
          const paneRef = ref ?? analysisId
          // Dedup: launching the SAME analysis again focuses its open run pane, never a duplicate.
          const dup = existingPaneId(s, 'run', paneRef)
          if (dup) return dup
          const mainIds = leafIds(s.layout)
          // Open the run surface into a PROMINENT region — never a squeezed sliver. Prefer to
          // reuse the run region (split the most-recent run pane) so the durable default panes
          // stay stable across repeated launches; else split the LARGEST main leaf (the canvas
          // hero in the default IA) so the launched analysis is immediately visible; else (empty
          // main) root a fresh pane. Each launch still adds exactly one pane.
          const existingRun = [...mainIds].reverse().find(id => s.cells[id]?.kind === 'run')
          const target = existingRun ?? largestLeafId(s.layout)
          if (!target) return s.addPane('run', paneRef)
          return performSplit(target, 'col', 'run', paneRef, PRIMARY_CONTAINER, PROMINENT_WEIGHT) || s.addPane('run', paneRef)
        },

        hasPopups: () => Object.values(get().paneContainer).some(c => c !== PRIMARY_CONTAINER),

        reset: () => {
          const main = defaultMainSlice()
          set({
            layout: main.layout,
            cells: main.cells,
            seq: main.seq,
            containerLayouts: {},
            paneContainer: {},
            pendingClose: [],
            returnAnchors: {},
            pendingRestore: [],
            pendingPlacement: null,
          })
        },

        serialize: () => {
          const s = get()
          const slice: DockSlice = { layout: s.layout, cells: copyCells(s.cells), seq: s.seq }
          if (Object.keys(s.paneContainer).length > 0) {
            slice.containerLayouts = { ...s.containerLayouts }
            slice.paneContainer = { ...s.paneContainer }
            if (Object.keys(s.returnAnchors).length > 0) slice.returnAnchors = { ...s.returnAnchors }
          }
          return slice
        },

        hydrate: (slice, hopts) => {
          if (slice.paneContainer) seedPopupCounterFrom(Object.values(slice.paneContainer))
          const reload = hopts?.reload ?? true
          set(() => {
            const cells = copyCells(slice.cells)
            const containerLayouts = slice.containerLayouts ? { ...slice.containerLayouts } : {}
            const paneContainer = slice.paneContainer ? { ...slice.paneContainer } : {}
            const returnAnchors = slice.returnAnchors ? { ...slice.returnAnchors } : {}
            // A restore can't reopen popup windows without a gesture → list them for the choice
            // dialog, but only when the page actually RELOADED (else start main-only).
            const pendingRestore = reload
              ? [...new Set(Object.values(paneContainer))].filter(
                  (c): c is ContainerId => c !== PRIMARY_CONTAINER,
                )
              : []
            return {
              layout: slice.layout,
              cells,
              seq: slice.seq,
              containerLayouts: reload ? containerLayouts : {},
              paneContainer: reload ? paneContainer : {},
              pendingClose: [],
              returnAnchors: reload ? returnAnchors : {},
              pendingRestore,
              pendingPlacement: null,
            }
          })
        },
      }
    }),
  )

  // ── Persistence: main → localStorage (per-project), popups → sessionStorage (per-tab) ──────
  // Write on every change once a project is bound; idempotent. localStorage is shared across a
  // user's tabs (they see the SAME main layout), while sessionStorage is per-tab (each tab keeps
  // its own popup layouts) — the split the plan requires.
  /** Strip TRANSIENT panes (run/artifact) from a main slice for PERSISTENCE only (the live state
   *  keeps them). If pruning would empty main, persist the default IA instead. */
  const pruneTransient = (main: DockMainSlice): DockMainSlice => {
    const transient = Object.values(main.cells).filter(p => TRANSIENT_KINDS.has(p.kind))
    if (transient.length === 0) return main
    let layout: LayoutNode = main.layout
    const cells = { ...main.cells }
    for (const p of transient) {
      const next = leafIds(layout).includes(p.id) ? removeLeaf(layout, p.id) : layout
      if (next !== null) layout = next
      delete cells[p.id]
    }
    if (Object.keys(cells).length === 0) return defaultMainSlice()
    return { layout, cells, seq: main.seq }
  }

  const persist = (s: WorkbenchDockState) => {
    if (!s.activeProjectId) return
    const pid = s.activeProjectId
    saveMain(storages, pid, pruneTransient({ layout: s.layout, cells: scopedCells(s.layout, s.cells), seq: s.seq }))
    if (Object.keys(s.paneContainer).length > 0) {
      const popupCells: Record<string, WorkbenchPane> = {}
      for (const paneId of Object.keys(s.paneContainer)) {
        if (s.cells[paneId]) popupCells[paneId] = s.cells[paneId]
      }
      const slice: PopupSlice = {
        containerLayouts: s.containerLayouts,
        paneContainer: s.paneContainer,
        returnAnchors: s.returnAnchors,
        cells: popupCells,
      }
      savePopups(storages, pid, slice)
    } else {
      savePopups(storages, pid, null)
    }
  }
  store.subscribe(persist)

  return store
}

/** A bound WorkbenchDock store instance (the factory's return type). */
export type WorkbenchDockStore = ReturnType<typeof createWorkbenchDockStore>

/** The app's module-singleton dock store (the default instance the shell + actions drive). */
export const workbenchDockStore: WorkbenchDockStore = createWorkbenchDockStore()

/** Whether `main` is the empty-sentinel (every pane popped out). */
export function isMainEmpty(layout: LayoutNode): boolean {
  return layout.kind === 'leaf' && layout.id === EMPTY_MAIN_ID
}
export { EMPTY_MAIN_ID }
