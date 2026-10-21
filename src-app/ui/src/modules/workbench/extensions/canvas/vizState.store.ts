// vizState.store (ITEM-59) — the EXTENSION-OWNED per-project canvas/viz state,
// relocated OFF the shell `ProjectLayout`/`WorkbenchLayout.store`. Holds the generic
// viz controls the canvas + toolbar drive:
// `activeProjection` (which computed coordinate artifact the canvas plots points in),
// `plotType` (a viz chart-type id) and `plotLayout` (single vs split). Kept a
// plain-zustand module singleton (mirrors the viz `GridWorkspace.store` /
// `WorkbenchDock.store` factory idiom), persisted per-project to localStorage under
// its OWN key — so the shell layout store no longer knows about "color-by".
//
// TWO PERSISTED MIGRATIONS run on load (both pure + idempotent, both unit-tested):
//   1. ONE-TIME LIFT (ITEM-59) — a user upgrading from the pre-ITEM-59 build has these
//      four fields living inside the legacy `cyto.wb.layout` blob (the WorkbenchLayout
//      persist key). `migrateLegacyVizState` lifts them out ONCE into this store
//      (guarded by a `_migrated` flag) so a saved coloring/plot-type survives.
//   2. FIELD RENAME (WS-D / finding C5) — `activeProjection` was previously persisted
//      under a domain-flavoured field name (`LEGACY_PROJECTION_KEY`). A bare rename
//      would silently drop every already-migrated user's saved selection, since the
//      `_migrated` short-circuit returns the stored map verbatim. `migrateVizStateKeys`
//      upgrades the key in place on EVERY load, and the eager re-persist below writes
//      the upgraded map straight back. The NEW key always wins when present, so an
//      already-migrated blob is never clobbered.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { PlotLayout, PlotType } from '../../core/shell/types'

/** The canvas default chart-type id — resolved against viz's `chartTypes()` at the
 *  toolbar, but a stable literal here so this node-safe store never imports deck. */
export const DEFAULT_PLOT_TYPE: PlotType = 'scatter'

/** The persisted key for this store (distinct from the shell layout's `cyto.wb.layout`). */
export const VIZ_STATE_KEY = 'cyto.wb.viz'
/** The legacy blob the one-time migration reads the four viz fields out of. */
export const LEGACY_LAYOUT_KEY = 'cyto.wb.layout'

/**
 * The PRE-RENAME persisted field name for `activeProjection` (WS-D / finding C5).
 * Kept as a lone constant — the ONLY surviving spelling of it in this file — because a
 * rename migration cannot avoid naming the key it upgrades away from. Every read of the
 * old shape goes through this constant so the string is never re-typed inline.
 */
export const LEGACY_PROJECTION_KEY = 'activeEmbedding'

/** The per-project viz state (the four fields that left `ProjectLayout`). */
export interface VizProjectState {
  /** The computed coordinate artifact whose 2-D positions the canvas plots marks at.
   *  A generic artifact id — the app never interprets what produced it. */
  activeProjection: string | null
  plotType: PlotType
  plotLayout: PlotLayout
}

export function defaultVizState(): VizProjectState {
  return { activeProjection: null, plotType: DEFAULT_PLOT_TYPE, plotLayout: 'single' }
}

/** The persisted blob shape (a `_migrated` latch + the per-project map). */
export interface VizStateBlob {
  _migrated: boolean
  byProject: Record<string, VizProjectState>
}

// ── pure migration (node-unit-testable, TEST-525) ────────────────────────────

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Lift `{activeProjection, plotType, plotLayout}` out of every project's
 * legacy `ProjectLayout` (the pre-ITEM-59 `cyto.wb.layout` blob) into a fresh
 * per-project `VizProjectState` map. Fields absent from a legacy slice fall back to
 * the default (never dropping a present `plotType`). A malformed blob → an
 * empty map (never throws). `legacyRaw` is the PARSED blob (zustand-persist shape
 * `{ state: { byProject } }` OR a bare `{ byProject }`).
 *
 * A pre-ITEM-59 blob can only ever spell the projection field under
 * `LEGACY_PROJECTION_KEY`, so the lift reads the new key first and falls back to the
 * old one — the two migrations compose in a single pass.
 */
export function migrateLegacyVizState(legacyRaw: unknown): Record<string, VizProjectState> {
  if (!legacyRaw || typeof legacyRaw !== 'object') return {}
  const root = legacyRaw as Record<string, unknown>
  const stateNode = (root.state && typeof root.state === 'object' ? root.state : root) as Record<string, unknown>
  const byProject = stateNode.byProject
  if (!byProject || typeof byProject !== 'object') return {}
  const out: Record<string, VizProjectState> = {}
  for (const [pid, slice] of Object.entries(byProject as Record<string, unknown>)) {
    if (!slice || typeof slice !== 'object') continue
    const s = slice as Record<string, unknown>
    // Only migrate a slice that actually carried at least one viz field (a pure
    // dock-chrome slice from a newer build has none → skip, leaving the default).
    const hasVizField =
      // `colorBy` is no longer a field, but a blob that carried ONLY it is still a viz
      // slice — dropping it from this check would make such a blob skip migration and
      // silently reset the rest of the slice to defaults.
      'colorBy' in s ||
      'activeProjection' in s ||
      LEGACY_PROJECTION_KEY in s ||
      'plotType' in s ||
      'plotLayout' in s
    if (!hasVizField) continue
    const plotLayout: PlotLayout = s.plotLayout === 'split' ? 'split' : 'single'
    out[pid] = {
      activeProjection: 'activeProjection' in s ? asString(s.activeProjection) : asString(s[LEGACY_PROJECTION_KEY]),
      plotType: asString(s.plotType) ?? DEFAULT_PLOT_TYPE,
      plotLayout,
    }
  }
  return out
}

/**
 * WS-D (finding C5) — upgrade an ALREADY-PERSISTED `VIZ_STATE_KEY` map from the
 * pre-rename field name to `activeProjection`.
 *
 * Needed because `loadBlob` short-circuits on the `_migrated` latch and returns the
 * stored `byProject` verbatim: without this step the rename would silently drop the
 * saved selection of every user who had already booted an ITEM-59 build. Runs on EVERY
 * load (it is idempotent) rather than behind a second latch, so a blob written by an
 * older build at any point is repaired the next time the app opens.
 *
 * The NEW key always wins when the slice already carries it — an already-migrated blob
 * is never clobbered by a stale legacy key sitting next to it. Unrecognised sibling
 * fields are preserved untouched; only the renamed key is rewritten. A malformed map →
 * an empty map (never throws).
 */
export function migrateVizStateKeys(byProject: unknown): Record<string, VizProjectState> {
  if (!byProject || typeof byProject !== 'object') return {}
  const out: Record<string, VizProjectState> = {}
  for (const [pid, slice] of Object.entries(byProject as Record<string, unknown>)) {
    if (!slice || typeof slice !== 'object') continue
    const { [LEGACY_PROJECTION_KEY]: legacyValue, ...rest } = slice as Record<string, unknown>
    out[pid] = {
      ...(rest as unknown as VizProjectState),
      activeProjection:
        'activeProjection' in rest ? asString(rest.activeProjection) : asString(legacyValue),
    }
  }
  return out
}

// ── guarded localStorage (mirrors WorkbenchLayout.store's safeStorage probe) ──

interface KV {
  read(key: string): string | null
  write(key: string, value: string): void
}

function browserKv(): KV {
  // Probe localStorage ONCE and cache the handle (mirrors WorkbenchLayout's `safeStorage`)
  // rather than re-probing on every read/write. `null` → fall back to an in-memory map.
  let storage: Storage | null = null
  try {
    const probe = '__cyto_wb_viz_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    storage = window.localStorage
  } catch {
    storage = null
  }
  const mem = new Map<string, string>()
  return {
    read: key => (storage ? storage.getItem(key) : (mem.get(key) ?? null)),
    write: (key, value) => {
      if (storage) storage.setItem(key, value)
      else mem.set(key, value)
    },
  }
}

/** Load the persisted viz blob, running the one-time legacy migration when this store
 *  has never persisted (`_migrated` absent) — so the first boot after the relocation
 *  imports the user's saved coloring/plot-type from `cyto.wb.layout` — and the
 *  (idempotent) field-rename migration on whatever this store had already persisted. */
function loadBlob(kv: KV): VizStateBlob {
  let existing: Partial<VizStateBlob> | null = null
  try {
    const raw = kv.read(VIZ_STATE_KEY)
    if (raw) existing = JSON.parse(raw) as Partial<VizStateBlob>
  } catch {
    existing = null
  }
  // Rename-migrate what THIS store persisted, on both branches below.
  const existingByProject = migrateVizStateKeys(existing?.byProject)
  if (existing?._migrated) {
    return { _migrated: true, byProject: existingByProject }
  }
  // First run under ITEM-59 → migrate the legacy blob once.
  let legacyRaw: unknown = null
  try {
    const raw = kv.read(LEGACY_LAYOUT_KEY)
    if (raw) legacyRaw = JSON.parse(raw)
  } catch {
    legacyRaw = null
  }
  const migrated = migrateLegacyVizState(legacyRaw)
  return { _migrated: true, byProject: { ...migrated, ...existingByProject } }
}

export interface VizStateStore {
  byProject: Record<string, VizProjectState>
  activeProjectId: string | null
  ensureProject: (projectId: string) => void
  current: () => VizProjectState
  setActiveProjection: (id: string | null) => void
  setPlotType: (plotType: PlotType) => void
  setPlotLayout: (plotLayout: PlotLayout) => void
  reset: () => void
}

export interface VizStateStoreOptions {
  kv?: KV
}

export function createVizStateStore(opts: VizStateStoreOptions = {}) {
  const kv = opts.kv ?? browserKv()
  const blob = loadBlob(kv)

  // Persist the migration latch EAGERLY (not only on the first mutation) so the one-time
  // legacy migration doesn't re-run on every boot until the user first touches a viz
  // control. Idempotent: writes `_migrated:true` + the (possibly migrated) per-project map.
  try {
    kv.write(VIZ_STATE_KEY, JSON.stringify({ _migrated: true, byProject: blob.byProject } satisfies VizStateBlob))
  } catch {
    /* storage unavailable → in-memory only */
  }

  const store = create<VizStateStore>()(
    subscribeWithSelector((set, get) => {
      const stateOf = (projectId: string): VizProjectState => get().byProject[projectId] ?? defaultVizState()
      const patch = (patchFn: (s: VizProjectState) => VizProjectState) => {
        const id = get().activeProjectId
        if (!id) return
        set(prev => ({ byProject: { ...prev.byProject, [id]: patchFn(stateOf(id)) } }))
      }
      return {
        byProject: blob.byProject,
        activeProjectId: null,
        ensureProject: projectId => {
          if (!get().byProject[projectId]) {
            set(prev => ({ byProject: { ...prev.byProject, [projectId]: defaultVizState() } }))
          }
          set({ activeProjectId: projectId })
        },
        current: () => stateOf(get().activeProjectId ?? ''),
        setActiveProjection: activeProjection => patch(s => ({ ...s, activeProjection })),
        setPlotType: plotType => patch(s => ({ ...s, plotType })),
        setPlotLayout: plotLayout => patch(s => ({ ...s, plotLayout })),
        reset: () => {
          const id = get().activeProjectId
          if (!id) return
          set(prev => ({ byProject: { ...prev.byProject, [id]: defaultVizState() } }))
        },
      }
    }),
  )

  // Persist byProject (with the migration latch) on every change.
  store.subscribe(
    s => s.byProject,
    byProject => {
      try {
        kv.write(VIZ_STATE_KEY, JSON.stringify({ _migrated: true, byProject } satisfies VizStateBlob))
      } catch {
        /* storage unavailable → in-memory only */
      }
    },
  )

  return store
}

export type VizStateStoreInstance = ReturnType<typeof createVizStateStore>

/** The app's module-singleton viz-state store. */
export const vizStateStore: VizStateStoreInstance = createVizStateStore()

/** The active project's viz state, read REACTIVELY (subscribes) — use in render
 *  bodies; handlers use `vizStateStore.getState().current()`. */
export function useVizState(): VizProjectState {
  return vizStateStore(s => s.byProject[s.activeProjectId ?? ''] ?? defaultVizState())
}

