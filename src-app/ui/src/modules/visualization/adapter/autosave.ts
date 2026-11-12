// autosave.ts — ADAPTER binding of the pure autosave core (viz-core/persist) to the
// declarative `<Viz>` state model (viz-api-consolidation ITEM-23, adopter half). This
// RETIRES the legacy `WorkspaceSpec` dialect (layout + cells only): the single
// serialization format is now the strict-JSON `VizOption` produced by
// `VizController.getOption()` — surfaced to the page via `<Viz onChange>` — and re-applied
// on restore via `VizController.setOption(saved, { replace: true })`.
//
// Durability contract: the live workspace lives in the per-instance `<Viz>` store set
// (per-tab, vanishes on tab-close); this hook mirrors the emitted `VizOption` into a
// DISTINCT localStorage key so an accidental close can be recovered. Server-persisted
// saved views are OUT of scope (no backend) — this is local-only.
//
// A stale `WorkspaceSpec` (the retired dialect: `{ layout, cells }`, no `series`/`grid`)
// left under the key by a prior build is TOLERATED — `isRestorableOption` recognizes only a
// real `VizOption`, so the old shape is simply ignored (no restore offered, never a crash).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  INITIAL_CELL_ID,
  AUTOSAVE_KEY,
  debounce,
  readAutosave,
  writeAutosave,
  type VizController,
  type VizOption,
} from '@txresbench/viz'

/** Coalesce a burst of `onChange` emits (drag-resize, rapid edits) into one localStorage write. */
const AUTOSAVE_DEBOUNCE_MS = 400

/**
 * True when a value read back from the autosave key is a real, RESTORABLE `VizOption` — i.e.
 * it is the current `VizOption` dialect (carries `series[]` + `grid[]`) AND is worth OFFERING
 * to restore (it carries live interaction state, OR is more than the bare single default
 * scatter cell). A stale legacy `WorkspaceSpec` (`{ layout, cells }`, no `series`/`grid`)
 * fails the shape test and is ignored — the retired dialect is tolerated, never crashed on.
 */
function isRestorableOption(o: unknown): o is VizOption {
  if (o == null || typeof o !== 'object') return false
  const opt = o as Partial<VizOption>
  if (!Array.isArray(opt.series) || !Array.isArray(opt.grid) || opt.grid.length === 0) return false
  // Any live interaction state (selection / zoom / filter / overrides / color-by / colorScale /
  // docking) always makes the workspace worth restoring. `colorScale` is included to match
  // `Viz.optionCarriesLiveState` (which replace-applies a colorScale-only option on restore) — the two
  // liveness tests must AGREE, else a colorScale-only save is applied by Viz but not offered here.
  if (
    opt.selection != null ||
    opt.dataZoom != null ||
    opt.filters != null ||
    opt.colorOverrides != null ||
    opt.colorBySelection != null ||
    opt.colorScale != null ||
    opt.docking != null
  ) {
    return true
  }
  // Otherwise: restorable only when it is NOT just the bare single default scatter cell
  // (which would make the prompt pointless noise).
  if (opt.grid.length > 1) return true
  const only = opt.series[0]
  return !(only != null && only.type === 'scatter' && only.id === INITIAL_CELL_ID)
}

export interface WorkspaceAutosave {
  /** A prior-session workspace is saved and worth offering to restore. */
  hasSaved: boolean
  /** Apply the saved workspace via `controller.setOption(saved, { replace })` + hide the prompt. */
  restore: () => void
  /** Hide the prompt WITHOUT discarding the autosave (durability is preserved). */
  dismiss: () => void
  /** Wire to `<Viz onChange>`: debounced persist of the current `VizOption` to localStorage. */
  persist: (option: VizOption) => void
  /** Wire to `<Viz onController>` so `restore()` can drive `setOption(saved, { replace })`. */
  bindController: (controller: VizController) => void
}

/**
 * Autosave the live `<Viz>` workspace to localStorage (debounced, driven by `<Viz onChange>`)
 * and, on mount, surface any recoverable prior-session `VizOption` via `{ hasSaved, restore,
 * dismiss }` so the page can show a non-blocking "Restore last workspace?" prompt. Restore
 * feeds the saved option back through the bound controller (`setOption(saved, { replace })`),
 * which re-drives the `<Viz>` store set — an end-to-end, single-format save/restore.
 */
export function useWorkspaceAutosave(): WorkspaceAutosave {
  // Read the prior-session option ONCE, during the first render — before any `persist` from an
  // early `onChange` can overwrite it. `savedRef` is the in-memory source of truth for
  // `restore`, so a later on-disk overwrite can't defeat the offered restore.
  const savedRef = useRef<VizOption | null>(null)
  const readRef = useRef(false)
  if (!readRef.current) {
    readRef.current = true
    const saved = readAutosave<unknown>(AUTOSAVE_KEY)
    if (isRestorableOption(saved)) savedRef.current = saved
  }

  const [hasSaved, setHasSaved] = useState(() => savedRef.current != null)
  const controllerRef = useRef<VizController | null>(null)

  const write = useMemo(
    () => debounce((o: VizOption) => writeAutosave(AUTOSAVE_KEY, o), AUTOSAVE_DEBOUNCE_MS),
    [],
  )
  useEffect(() => () => write.cancel(), [write])

  const persist = useCallback((o: VizOption) => write(o), [write])

  const bindController = useCallback((controller: VizController) => {
    controllerRef.current = controller
  }, [])

  const restore = useCallback(() => {
    const saved = savedRef.current
    if (saved && controllerRef.current) {
      // The documented restore path: re-apply the saved `VizOption` verbatim. `{ replace: true }`
      // rebuilds (rather than merges into) the live state so a restore is a clean fixpoint.
      void controllerRef.current.setOption(saved, { replace: true })
    }
    setHasSaved(false)
  }, [])

  const dismiss = useCallback(() => setHasSaved(false), [])

  return { hasSaved, restore, dismiss, persist, bindController }
}
