// dockPersistence — the storage plumbing for `WorkbenchDock.store` (ITEM-8/18). The MAIN
// (`'main'`) layout persists PER-PROJECT to localStorage (shared across a user's tabs); the
// POPUP layouts persist PER-TAB to sessionStorage (a pop-out window belongs to the tab that
// opened it). Both use a guarded storage (probe once, fall back to in-memory in a locked-down
// context, mirroring `WorkbenchLayout.store`'s `safeStorage`).

import { leafIds, removeLeaf, type ContainerId, type DropTarget, type LayoutNode } from '@txresbench/dock'
import type { WorkbenchPane } from './paneModel'
import {
  type DockMainSlice,
  DOCK_MAIN_VERSION,
  isRetiredPaneKind,
  migrateDockMain,
  migratePaneCells,
  type DockMainBlob,
} from './defaultLayout'

/** The minimal Web-Storage surface the store needs (a real `Storage` satisfies it; unit tests
 *  inject a Map-backed fake to inspect what landed in local vs. session). */
export interface SimpleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DockStorages {
  /** per-project MAIN layout (shared across a user's tabs). */
  local: SimpleStorage
  /** per-tab POPUP layouts. */
  session: SimpleStorage
}

/** The per-project popup slice persisted to sessionStorage. Carries the popped panes' CELLS
 *  too (the main slice only holds main-container panes), so a reload restore can render them. */
export interface PopupSlice {
  containerLayouts: Record<string, LayoutNode>
  paneContainer: Record<string, ContainerId>
  returnAnchors: Record<string, DropTarget>
  cells: Record<string, WorkbenchPane>
}

const MAIN_KEY = 'txr.wb.dock.main'
const POPUP_KEY = 'txr.wb.dock.popups'

/** Guarded storage: probe once, fall back to an in-memory map when Web Storage throws (private
 *  mode / sandboxed iframe / SSR) so the store never takes the app down. Shared with
 *  `regions/regionsPersistence` (the region-arrangement twin of this module). */
export function guardedStorage(get: () => Storage | undefined, probe = '__txr_wb_dock_probe__'): SimpleStorage {
  try {
    const s = get()
    if (!s) throw new Error('no storage')
    s.setItem(probe, probe)
    s.removeItem(probe)
    return s
  } catch {
    const mem = new Map<string, string>()
    return {
      getItem: k => mem.get(k) ?? null,
      setItem: (k, v) => {
        mem.set(k, v)
      },
      removeItem: k => {
        mem.delete(k)
      },
    }
  }
}

/** Real browser storages (guarded). Node/SSR → in-memory. */
export function defaultDockStorages(): DockStorages {
  const w = typeof window !== 'undefined' ? window : undefined
  return {
    local: guardedStorage(() => w?.localStorage),
    session: guardedStorage(() => w?.sessionStorage),
  }
}

/** Whether this page load was a RELOAD (session-restore is reload-gated). */
export function defaultIsReload(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    return nav?.type === 'reload'
  } catch {
    return false
  }
}

function readJson<T>(storage: SimpleStorage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function writeJson(storage: SimpleStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / locked-down — the layout just won't survive a reload here */
  }
}

/** Load every project's persisted MAIN slice (migrated to the current version). */
export function loadMain(storages: DockStorages): Record<string, DockMainSlice> {
  return migrateDockMain(readJson<DockMainBlob>(storages.local, MAIN_KEY))
}

/** Persist one project's MAIN slice into the shared localStorage blob (merge, don't clobber). */
export function saveMain(storages: DockStorages, projectId: string, slice: DockMainSlice): void {
  const byProject = loadMain(storages)
  byProject[projectId] = slice
  writeJson(storages.local, MAIN_KEY, { v: DOCK_MAIN_VERSION, byProject } satisfies DockMainBlob)
}

/**
 * Drop every retired-kind pane from a per-tab POPUP slice — the popup twin of
 * `dropRetiredPanes`. `ensureProject` merges the popup pane map OVER the (already-migrated) main
 * one, so a retired pane surviving HERE walks straight back into the live workspace as a tab with
 * no renderer, even though the main blob was repaired. Removes the pane, its `paneContainer`
 * entry, its return anchor, and its leaf from the owning container tree (dropping the container
 * outright when that empties it). Same slice back when nothing matched.
 */
function dropRetiredFromPopup(slice: PopupSlice): PopupSlice {
  const kept: Record<string, WorkbenchPane> = {}
  const retired: string[] = []
  for (const [id, pane] of Object.entries(slice.cells)) {
    if (isRetiredPaneKind(pane.kind)) retired.push(id)
    else kept[id] = pane
  }
  if (retired.length === 0) return slice
  const paneContainer = { ...slice.paneContainer }
  const returnAnchors = { ...slice.returnAnchors }
  const containerLayouts: Record<string, LayoutNode> = { ...slice.containerLayouts }
  for (const id of retired) {
    delete paneContainer[id]
    delete returnAnchors[id]
    for (const [containerId, tree] of Object.entries(containerLayouts)) {
      if (!leafIds(tree).includes(id)) continue
      const next = removeLeaf(tree, id)
      if (next) containerLayouts[containerId] = next
      else delete containerLayouts[containerId]
    }
  }
  return { containerLayouts, paneContainer, returnAnchors, cells: kept }
}

/** Load every project's per-tab POPUP slice from sessionStorage.
 *  The popup slice carries the popped panes' OWN MAP verbatim (unlike the MAIN slice, which
 *  prunes transient kinds before writing), so a popped-out `artifact` pane persisted BEFORE the
 *  ITEM-25 rename comes back as `kind: 'result'`. Run the same `migratePaneCells` remap the
 *  main-blob migration uses, so a legacy popup restores intact instead of rendering the fallback
 *  note — then the same retirement drop, so a popped-out DELETED pane does not restore at all. */
export function loadPopups(storages: DockStorages): Record<string, PopupSlice> {
  const raw = readJson<Record<string, PopupSlice>>(storages.session, POPUP_KEY) ?? {}
  for (const [pid, slice] of Object.entries(raw)) {
    const panes = slice?.cells
    if (slice && typeof slice === 'object' && panes && typeof panes === 'object') {
      raw[pid] = dropRetiredFromPopup({ ...slice, cells: migratePaneCells(panes) })
    }
  }
  return raw
}

/** Persist (or, with `null`, clear) one project's POPUP slice in sessionStorage. */
export function savePopups(storages: DockStorages, projectId: string, slice: PopupSlice | null): void {
  const all = loadPopups(storages)
  if (slice) all[projectId] = slice
  else delete all[projectId]
  writeJson(storages.session, POPUP_KEY, all)
}

/** A Map-backed `SimpleStorage` (unit-test helper — inspect what the store wrote to each). */
export function memoryStorage(): SimpleStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: k => {
      map.delete(k)
    },
  }
}
