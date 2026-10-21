// WorkbenchRegions.store — the UI state for the fixed 4-region shell: the active tab per region, the
// collapse state of the side + bottom regions, the resizable sizes, and any per-pane region override
// (moving a pane to another region). The PANES themselves still live in `WorkbenchDock.store.cells`
// (add/remove/reconciliation reuse it); this store only holds where + how they're arranged.
//
// PERSISTENCE (the twin of `WorkbenchDock.store`'s): the durable arrangement persists PER-PROJECT to
// localStorage and the region SIZES persist as a GLOBAL preference, both through
// `regionsPersistence`; the per-WINDOW state (`poppedOut`) and the live drag state are transient and
// never stored (see that module's header for WHY — a popup container id is meaningless without its
// registered OS window, so restoring it would strand panes).
//
// BINDING: `ensureProject(projectId)` (idempotent) replaces the shell's bare `reset()` call, at the
// SAME point in `WorkbenchShell`'s effect — it resets, then loads. Keeping the reset there is
// deliberate: its position relative to `WorkbenchDockHost`'s child `useViewReconciliation` effect
// decides where auto-mounted contributed views end up docking, so moving the bind earlier (e.g. to a
// synchronous first-render bind like the dock store's) would silently relocate them. Region SIZES
// need no bind at all — being a global preference, they are read from storage at store CONSTRUCTION
// and are therefore already correct at the first paint.
//
// Plain-zustand FACTORY (mirrors `createWorkbenchDockStore`) so a unit test can inject a
// Map-backed storage; a module-singleton `workbenchRegionsStore` is the app instance.

import { create } from 'zustand'
import { REGIONS, type Region } from './regionModel'
import type { SimpleStorage } from '@/modules/workbench/core/shell/dock/dockPersistence'
import type { PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'
import {
  type RegionsPrefs,
  type RegionsProjectSlice,
  DEFAULT_REGION_PREFS,
  SIDE_REGION_WIDTH_MAX,
  SIDE_REGION_WIDTH_MIN,
  defaultRegionsSlice,
  defaultRegionsStorage,
  loadRegions,
  saveRegions,
} from './regionsPersistence'

export interface RegionsUiState {
  /** active pane id per region (null → fall back to the first pane in that region). */
  active: Record<Region, string | null>
  /** Per-region MRU stack of activated pane ids (most-recent FIRST) so closing the
   *  active tab falls back to the PREVIOUSLY active tab, not always the first. */
  activeHistory: Record<Region, string[]>
  /** collapsed side/bottom regions (collapsed left/right show only their border tab-strip). */
  collapsed: { left: boolean; right: boolean; bottom: boolean }
  leftWidth: number
  rightWidth: number
  bottomHeight: number
  /** The bottom pane can EXTEND under the left/right side regions (a full-width
   *  bottom panel); each side toggles independently. When a side is extended, that
   *  side region sits ABOVE the bottom pane instead of full-height beside it. */
  bottomExtendLeft: boolean
  bottomExtendRight: boolean
  /** per-pane region override (a moved pane); absent → the pane's kind-default region. */
  regionOverride: Record<string, Region>
  /** explicit tab ORDER per region (ids reordered by drag); absent → cells insertion order. */
  order: Partial<Record<Region, string[]>>
  /** visualize-pane ITEM-7 — the user's SECTION order per pane kind, from a section
   *  drag-reorder. Sparse; absent ⇒ every section sits where its author declared. */
  sectionOrder: Partial<Record<PaneKind, string[]>>
  /** panes popped out to their own window: paneId → popup container id. Excluded from their region.
   *  TRANSIENT — never persisted (the container id is only meaningful while its window is open). */
  poppedOut: Record<string, string>
  /** live drag: the pane being dragged between regions + the region under the cursor. */
  dragPaneId: string | null
  dragOverRegion: Region | null
  /** The bound project (drives the per-project persistence key); null until `ensureProject`. */
  activeProjectId: string | null
  /** Bind a project: persist the outgoing project's arrangement, then load `projectId`'s from
   *  localStorage (or the default arrangement). Idempotent — a re-bind of the SAME project is a
   *  no-op, so a remount can't clobber the live arrangement. */
  ensureProject: (projectId: string) => void
  setActive: (region: Region, paneId: string) => void
  toggleCollapse: (region: 'left' | 'right' | 'bottom') => void
  toggleBottomExtend: (side: 'left' | 'right') => void
  setLeftWidth: (px: number) => void
  setRightWidth: (px: number) => void
  setBottomHeight: (px: number) => void
  moveToRegion: (paneId: string, region: Region) => void
  /** Dock a pane into `region` WITHOUT focusing it — the idempotent re-assertion. Distinct from
   *  `moveToRegion`, which is a user MOVE and therefore focuses what was moved. */
  dockToRegion: (paneId: string, region: Region) => void
  setRegionOrder: (region: Region, ids: string[]) => void
  /** visualize-pane ITEM-7 — record the user's section order for ONE pane kind. */
  setSectionOrder: (pane: PaneKind, ids: string[]) => void
  /** visualize-pane ITEM-7 — drop saved section ids that no longer have a registered
   *  section, for ONE pane kind. The section twin of `reconcilePanes`, and a SEPARATE call
   *  because it prunes against a different set: `reconcilePanes` is driven by the dock's
   *  pane map, sections by the contribution registry. */
  reconcileSections: (pane: PaneKind, registeredIds: string[]) => void
  /** Drop every per-pane arrangement entry (override/order/history/active/popped) for
   *  a pane id no longer in the dock's cells — called on cell changes so a closed pane
   *  (ids are monotonic, never reused) can't leak entries for the session's lifetime. */
  reconcilePanes: (existingIds: string[]) => void
  popOut: (paneId: string, containerId: string) => void
  unpop: (paneId: string) => void
  startDrag: (paneId: string) => void
  setDragOver: (region: Region | null) => void
  endDrag: () => void
  /** Reset the arrangement to defaults. This store is a global singleton and default pane ids
   *  (`p-visualize`, `p-canvas`, …) are IDENTICAL across every project, so leftover
   *  poppedOut/regionOverride/order/active from the previous project would otherwise bleed into — and
   *  mis-target the same-id panes of — the next project; `ensureProject` therefore resets before it
   *  loads. Width prefs are kept (not project-bound). */
  reset: () => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The DURABLE (persisted) slice of the live state — everything except the sizes (a global pref)
 *  and the transient per-window/drag fields. */
function toSlice(s: RegionsUiState): RegionsProjectSlice {
  return {
    active: { ...s.active },
    activeHistory: { ...s.activeHistory },
    collapsed: { ...s.collapsed },
    bottomExtendLeft: s.bottomExtendLeft,
    bottomExtendRight: s.bottomExtendRight,
    regionOverride: { ...s.regionOverride },
    order: { ...s.order },
    sectionOrder: { ...s.sectionOrder },
  }
}

function toPrefs(s: RegionsUiState): RegionsPrefs {
  return { leftWidth: s.leftWidth, rightWidth: s.rightWidth, bottomHeight: s.bottomHeight }
}

export interface RegionsStoreOptions {
  storage?: SimpleStorage
}

export function createWorkbenchRegionsStore(opts: RegionsStoreOptions = {}) {
  const storage = opts.storage ?? defaultRegionsStorage()
  // Read the global size prefs ONCE at construction so the very first render already has the
  // user's widths (a size is not project-bound, so it needs no `ensureProject` to apply).
  const initialPrefs = loadRegions(storage).prefs

  const store = create<RegionsUiState>((set, get) => ({
    ...defaultRegionsSlice(),
    ...initialPrefs,
    poppedOut: {},
    dragPaneId: null,
    dragOverRegion: null,
    activeProjectId: null,
    ensureProject: projectId => {
      const s = get()
      if (s.activeProjectId === projectId) return
      const { byProject } = loadRegions(storage)
      // The OUTGOING project's live arrangement wins over what's on disk (the persist subscription
      // has already written it, but re-stating it here keeps the swap correct even if a write was
      // dropped by a locked-down storage).
      if (s.activeProjectId) byProject[s.activeProjectId] = toSlice(s)
      const slice = byProject[projectId] ?? defaultRegionsSlice()
      set({
        ...slice,
        // Per-window + drag state is ALWAYS reset on a bind: the previous project's popouts must
        // not capture this project's same-id default panes, and a restored id has no live window.
        poppedOut: {},
        dragPaneId: null,
        dragOverRegion: null,
        activeProjectId: projectId,
      })
    },
    setActive: (region, paneId) =>
      set(s => ({
        active: { ...s.active, [region]: paneId },
        activeHistory: {
          ...s.activeHistory,
          [region]: [paneId, ...(s.activeHistory[region] ?? []).filter(id => id !== paneId)],
        },
      })),
    toggleCollapse: region => set(s => ({ collapsed: { ...s.collapsed, [region]: !s.collapsed[region] } })),
    toggleBottomExtend: side =>
      set(s =>
        side === 'left'
          ? { bottomExtendLeft: !s.bottomExtendLeft }
          : { bottomExtendRight: !s.bottomExtendRight },
      ),
    setLeftWidth: px => set({ leftWidth: clamp(px, SIDE_REGION_WIDTH_MIN, SIDE_REGION_WIDTH_MAX) }),
    setRightWidth: px => set({ rightWidth: clamp(px, SIDE_REGION_WIDTH_MIN, SIDE_REGION_WIDTH_MAX) }),
    setBottomHeight: px => set({ bottomHeight: clamp(px, 120, 640) }),
    moveToRegion: (paneId, region) =>
      set(s => ({ regionOverride: { ...s.regionOverride, [paneId]: region }, active: { ...s.active, [region]: paneId } })),
    // Region WITHOUT focus.
    //
    // `moveToRegion` focuses what it moves, which is right for a user move (a drag, or opening a
    // pane by name) and wrong for the idempotent re-assertion `paneReconcile` performs. That loop
    // re-asserts the declared region for EVERY mounted view pane, and it re-runs whenever the pane
    // map changes — so ADDING ANY PANE walked the whole view list and left the LAST one holding
    // the region's active slot. A user who opened a pane by name watched it appear as a tab and
    // lose the surface in the same frame, and a user who had simply selected a tab lost that
    // selection to whatever unrelated pane opened next.
    //
    // Docking and focusing are separate intents; only one of them belongs in a reconciliation.
    dockToRegion: (paneId, region) =>
      set(s =>
        s.regionOverride[paneId] === region
          ? s
          : { regionOverride: { ...s.regionOverride, [paneId]: region } },
      ),
    setRegionOrder: (region, ids) => set(s => ({ order: { ...s.order, [region]: ids } })),
    setSectionOrder: (pane, ids) => set(s => ({ sectionOrder: { ...s.sectionOrder, [pane]: ids } })),
    reconcileSections: (pane, registeredIds) =>
      set(s => {
        const saved = s.sectionOrder[pane]
        if (!saved) return s
        const keep = new Set(registeredIds)
        const pruned = saved.filter(id => keep.has(id))
        if (pruned.length === saved.length) return s
        return { sectionOrder: { ...s.sectionOrder, [pane]: pruned } }
      }),
    reconcilePanes: existingIds =>
      set(s => {
        const keep = new Set(existingIds)
        const stale = (id: string) => !keep.has(id)
        const dirty =
          Object.keys(s.regionOverride).some(stale) ||
          Object.keys(s.poppedOut).some(stale) ||
          REGIONS.some(r => (s.activeHistory[r] ?? []).some(stale)) ||
          REGIONS.some(r => (s.order[r] ?? []).some(stale)) ||
          REGIONS.some(r => s.active[r] != null && stale(s.active[r] as string))
        if (!dirty) return s
        const regionOverride = Object.fromEntries(Object.entries(s.regionOverride).filter(([id]) => keep.has(id)))
        const poppedOut = Object.fromEntries(Object.entries(s.poppedOut).filter(([id]) => keep.has(id)))
        const activeHistory = { ...s.activeHistory }
        const order = { ...s.order }
        const active = { ...s.active }
        for (const r of REGIONS) {
          activeHistory[r] = (s.activeHistory[r] ?? []).filter(id => keep.has(id))
          if (s.order[r]) order[r] = (s.order[r] as string[]).filter(id => keep.has(id))
          if (active[r] != null && !keep.has(active[r] as string)) active[r] = null
        }
        return { regionOverride, poppedOut, activeHistory, order, active }
      }),
    popOut: (paneId, containerId) => set(s => ({ poppedOut: { ...s.poppedOut, [paneId]: containerId } })),
    unpop: paneId =>
      set(s => {
        if (!(paneId in s.poppedOut)) return s
        const poppedOut = { ...s.poppedOut }
        delete poppedOut[paneId]
        return { poppedOut }
      }),
    startDrag: paneId => set({ dragPaneId: paneId, dragOverRegion: null }),
    setDragOver: region => set(s => (s.dragOverRegion === region ? s : { dragOverRegion: region })),
    endDrag: () => set({ dragPaneId: null, dragOverRegion: null }),
    reset: () =>
      set({
        ...defaultRegionsSlice(),
        poppedOut: {},
        dragPaneId: null,
        dragOverRegion: null,
      }),
  }))

  // ── Persistence: the durable arrangement → localStorage (per-project) + the sizes as a GLOBAL
  // pref. Writes on every change once a project is bound; idempotent. Nothing per-WINDOW is
  // written (see `regionsPersistence`'s header). A pointer-drag resize emits a `setLeftWidth` per
  // move, so the write is guarded by a cheap "did the persisted shape actually change" signature —
  // dragging past the clamp, or any purely-transient change (drag-over/pop-out), writes nothing.
  let lastWritten = ''
  store.subscribe(s => {
    if (!s.activeProjectId) return
    const signature = JSON.stringify([s.activeProjectId, toSlice(s), toPrefs(s)])
    if (signature === lastWritten) return
    lastWritten = signature
    saveRegions(storage, s.activeProjectId, toSlice(s), toPrefs(s))
  })

  return store
}

/** A bound WorkbenchRegions store instance (the factory's return type). */
export type WorkbenchRegionsStore = ReturnType<typeof createWorkbenchRegionsStore>

export const workbenchRegionsStore: WorkbenchRegionsStore = createWorkbenchRegionsStore()

export { DEFAULT_REGION_PREFS }
