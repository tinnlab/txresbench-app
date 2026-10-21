// regionsPersistence — the storage plumbing for `WorkbenchRegions.store`, the region-ARRANGEMENT
// twin of `dock/dockPersistence` (the pane-LAYOUT plumbing). Same conventions: a `cyto.wb.*`
// localStorage key holding a versioned `{ v, byProject }` blob, the same guarded-storage fallback,
// the same "merge, don't clobber" save, and the same never-throw migration.
//
// WHAT PERSISTS — and, critically, WHAT DOES NOT:
//   • PER-PROJECT (localStorage, shared across a user's tabs, keyed by project id): the durable
//     arrangement — collapse state, active tab + its MRU history, tab order, per-pane region
//     override, and the bottom-extend toggles.
//   • GLOBAL prefs (localStorage, NOT project-bound): the region SIZES (left/right width, bottom
//     height). These are a user preference rather than a property of a project's arrangement —
//     `WorkbenchRegions.store.reset()` has always kept widths across a project switch, and storing
//     them outside `byProject` preserves exactly that semantic while still surviving a reload.
//   • NOTHING per-WINDOW. `poppedOut` (paneId → popup container id) and the live drag state are
//     deliberately NEVER persisted. A popup container id is only meaningful while its OS window is
//     open and REGISTERED in `@ziee/dock`'s per-tab popup registry (`RegionPopoutWindows` portals
//     through `getPopupWindow(containerId)`); a reload closes those windows and clears the
//     registry, and a second tab never had them at all. Restoring `poppedOut` would therefore
//     strand each listed pane — filtered out of its region by `notPopped` with no window to render
//     it in, and unrecoverable without a user gesture (which is why the DOCK store puts its popup
//     slice in per-TAB sessionStorage behind a reload gate + an explicit restore dialog). Region
//     pop-outs have no such restore surface, so the correct scoping is "transient, never stored".

import { type SimpleStorage, guardedStorage } from '@/modules/workbench/core/shell/dock/dockPersistence'
import type { PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'
import { REGIONS, type Region } from './regionModel'

/** The DURABLE, per-project region arrangement (everything except sizes + transient state). */
export interface RegionsProjectSlice {
  active: Record<Region, string | null>
  activeHistory: Record<Region, string[]>
  collapsed: { left: boolean; right: boolean; bottom: boolean }
  bottomExtendLeft: boolean
  bottomExtendRight: boolean
  regionOverride: Record<string, Region>
  order: Partial<Record<Region, string[]>>
  /** visualize-pane ITEM-7 — the user's SECTION order per pane kind (`{ visualize: [...] }`),
   *  written by a section drag-reorder.
   *
   *  It belongs in THIS bucket and not one of the other two: it is arrangement (like tab
   *  order), not a size preference, and deliberately not per-window — a user who reorders
   *  the pane in one tab wants that order in the next one, which is exactly what
   *  `localStorage` gives and `sessionStorage` would take away.
   *
   *  SPARSE in both directions: a pane kind the user has never dragged is absent, and a
   *  present list names only the sections they moved (`resolveSectionOrder` places the rest
   *  by their authors' declared `order`). Absent-by-default is also why this needs NO
   *  `REGIONS_VERSION` bump — an older blob simply has no key, which reads as "never
   *  dragged", which is the correct answer. */
  sectionOrder: Partial<Record<PaneKind, string[]>>
}

/** The GLOBAL (not project-bound) size preferences. */
export interface RegionsPrefs {
  leftWidth: number
  rightWidth: number
  bottomHeight: number
}

/** The persisted blob: a version tag + the global prefs + the per-project slices. */
export interface RegionsBlob {
  v: number
  prefs?: RegionsPrefs
  byProject: Record<string, RegionsProjectSlice>
}

const REGIONS_KEY = 'cyto.wb.regions'

/** Bump on a breaking arrangement-shape change (a FUTURE version reads as "no data"). */
export const REGIONS_VERSION = 1

export const DEFAULT_REGION_PREFS: RegionsPrefs = { leftWidth: 260, rightWidth: 300, bottomHeight: 240 }

/**
 * The width band a SIDE region (left / right) may be dragged through, in px — the clamp
 * `WorkbenchRegions.store`'s `setLeftWidth`/`setRightWidth` apply.
 *
 * Named here, beside the DEFAULTS, rather than spelled twice inside those two setters, because
 * the band is a CONTRACT with everything that has to fit inside a side pane. `MIN` in particular
 * is not a curiosity: it is a width the user can reach with one drag, so it is the width at which
 * "nothing clips" still has to hold. A surface that fits at `DEFAULT_REGION_PREFS` and bursts at
 * `MIN` is a clipped surface that nobody measured.
 *
 * The declarative gallery fixtures mount their frames at exactly these numbers
 * (`core/gallery/fixtureSpecs.ts`), so moving the band moves the measurement with it instead of
 * leaving a stale literal behind in a spec.
 */
export const SIDE_REGION_WIDTH_MIN = 180
export const SIDE_REGION_WIDTH_MAX = 560

/** The default (empty) arrangement — what a project with nothing persisted starts from. */
export function defaultRegionsSlice(): RegionsProjectSlice {
  return {
    active: { left: null, center: null, right: null, bottom: null },
    activeHistory: { left: [], center: [], right: [], bottom: [] },
    collapsed: { left: false, right: false, bottom: false },
    bottomExtendLeft: false,
    bottomExtendRight: false,
    regionOverride: {},
    order: {},
    sectionOrder: {},
  }
}

/** Real browser localStorage (guarded). Node/SSR → in-memory. */
export function defaultRegionsStorage(): SimpleStorage {
  const w = typeof window !== 'undefined' ? window : undefined
  return guardedStorage(() => w?.localStorage, '__cyto_wb_regions_probe__')
}

function readBlob(storage: SimpleStorage): RegionsBlob | null {
  try {
    const raw = storage.getItem(REGIONS_KEY)
    return raw ? (JSON.parse(raw) as RegionsBlob) : null
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

/** Normalize one persisted slice, filling any missing/hand-corrupted field from the default (so a
 *  partially-written blob degrades field-by-field rather than dropping the whole arrangement). */
function normalizeSlice(raw: unknown): RegionsProjectSlice | null {
  if (!isRecord(raw)) return null
  const d = defaultRegionsSlice()
  const active = { ...d.active }
  const activeHistory = { ...d.activeHistory }
  const rawActive = isRecord(raw.active) ? raw.active : {}
  const rawHistory = isRecord(raw.activeHistory) ? raw.activeHistory : {}
  const order: Partial<Record<Region, string[]>> = {}
  const rawOrder = isRecord(raw.order) ? raw.order : {}
  // The section order is keyed by PANE KIND, which is an open-ended vocabulary owned by the
  // shell — so it is normalized by iterating what was STORED rather than a fixed key list.
  // A key that is no longer a pane kind is inert (nothing looks it up); a stale SECTION id
  // inside a list is likewise inert, and `resolveSectionOrder` is written not to depend on
  // pruning having run.
  const sectionOrder: Partial<Record<PaneKind, string[]>> = {}
  if (isRecord(raw.sectionOrder)) {
    for (const [kind, list] of Object.entries(raw.sectionOrder)) {
      if (Array.isArray(list)) {
        sectionOrder[kind as PaneKind] = list.filter((x): x is string => typeof x === 'string')
      }
    }
  }
  for (const r of REGIONS) {
    const a = rawActive[r]
    active[r] = typeof a === 'string' ? a : null
    const h = rawHistory[r]
    activeHistory[r] = Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : []
    const o = rawOrder[r]
    if (Array.isArray(o)) order[r] = o.filter((x): x is string => typeof x === 'string')
  }
  const rawCollapsed = isRecord(raw.collapsed) ? raw.collapsed : {}
  const regionOverride: Record<string, Region> = {}
  if (isRecord(raw.regionOverride)) {
    for (const [id, region] of Object.entries(raw.regionOverride)) {
      if (typeof region === 'string' && (REGIONS as readonly string[]).includes(region)) {
        regionOverride[id] = region as Region
      }
    }
  }
  return {
    active,
    activeHistory,
    collapsed: {
      left: rawCollapsed.left === true,
      right: rawCollapsed.right === true,
      bottom: rawCollapsed.bottom === true,
    },
    bottomExtendLeft: raw.bottomExtendLeft === true,
    bottomExtendRight: raw.bottomExtendRight === true,
    regionOverride,
    order,
    sectionOrder,
  }
}

function normalizePrefs(raw: unknown): RegionsPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_REGION_PREFS }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return {
    leftWidth: num(raw.leftWidth, DEFAULT_REGION_PREFS.leftWidth),
    rightWidth: num(raw.rightWidth, DEFAULT_REGION_PREFS.rightWidth),
    bottomHeight: num(raw.bottomHeight, DEFAULT_REGION_PREFS.bottomHeight),
  }
}

/**
 * Migrate a persisted blob to the current version (mirrors `migrateDockMain`):
 *  - current version (or an untagged v0 blob) → its `byProject`, normalized slice-by-slice so one
 *    corrupt project can't take the rest down.
 *  - an UNKNOWN / FUTURE version, or an unrecognizable value → empty, WITHOUT throwing (the store
 *    falls back to the default arrangement per project).
 */
export function migrateRegions(raw: unknown): { prefs: RegionsPrefs; byProject: Record<string, RegionsProjectSlice> } {
  const empty = { prefs: { ...DEFAULT_REGION_PREFS }, byProject: {} as Record<string, RegionsProjectSlice> }
  if (!isRecord(raw)) return empty
  const blob = raw as Partial<RegionsBlob>
  if (typeof blob.v === 'number' && blob.v > REGIONS_VERSION) return empty
  const byProject: Record<string, RegionsProjectSlice> = {}
  if (isRecord(blob.byProject)) {
    for (const [pid, slice] of Object.entries(blob.byProject)) {
      const norm = normalizeSlice(slice)
      if (norm) byProject[pid] = norm
    }
  }
  return { prefs: normalizePrefs(blob.prefs), byProject }
}

/** Load the global prefs + every project's persisted arrangement. */
export function loadRegions(storage: SimpleStorage): {
  prefs: RegionsPrefs
  byProject: Record<string, RegionsProjectSlice>
} {
  return migrateRegions(readBlob(storage))
}

/** Persist one project's arrangement + the global prefs (merge, don't clobber the other projects). */
export function saveRegions(
  storage: SimpleStorage,
  projectId: string,
  slice: RegionsProjectSlice,
  prefs: RegionsPrefs,
): void {
  const { byProject } = loadRegions(storage)
  byProject[projectId] = slice
  try {
    storage.setItem(REGIONS_KEY, JSON.stringify({ v: REGIONS_VERSION, prefs, byProject } satisfies RegionsBlob))
  } catch {
    /* quota / locked-down — the arrangement just won't survive a reload here */
  }
}

export { REGIONS_KEY }
