// coordinationHandle.ts — the concrete `CoordinationHandle` backing the SELECTION component
// (EXTENSIBILITY_STUDY §5.2 / Part 6 STEP 3). This is the ONE place the `Coordination` store is
// wrapped for chart Views: a View reads the shared point-selection (+ color domain) and publishes
// a selection THROUGH this handle instead of importing `useCoordinationStore` directly, so the
// store becomes an implementation DETAIL of the component and every View is decoupled + testable.
//
// The `use*` members are React hooks (reactive reads) — a View calls them at the top of its render
// exactly like the store selector they replace, so the swap is a pure indirection with NO behavior
// change (same subscription, same value). `useGroupEmphasis` is the component's visual-stage
// handler: it computes each consuming group-chart's emphasis from the CURRENT shared selection via
// the PURE `selectionSync` helpers (`groupEmphasis`/`groupEmphasisByIds`), which are unchanged.
//
// PER-INSTANCE ISOLATION (VIZ_ISOLATION W2): the handle is now MINTED by `createCoordinationHandle(
// stores)` over an explicit `VizStores` set (default = the module singletons), so a per-instance
// `<Viz>` builds a handle bound to ITS OWN coordination store. `defaultCoordinationHandle` is the
// stable singleton-backed handle (its methods never change identity), so a View defaulting to it,
// and `CellView`/`GridWorkspace` threading the per-instance handle, both call the same hooks on the
// same store — the byte-identical single-source path when unprovided.

import { useMemo } from 'react'
import { useStore } from 'zustand'
import { type VizStores, defaultVizStores } from './vizStores'
import { resolveSharedDomain } from '../viz-core/coordination/colorScale'
import {
  groupEmphasis,
  groupEmphasisByIds,
  type GroupEmphasis,
  type IdToRow,
} from '../viz-core/coordination/selectionSync'
import type { CoordinationHandle } from '../viz-core/registry/types'

/**
 * Mint a `CoordinationHandle` bound to a specific `VizStores` set's coordination store. Every
 * reactive `use*` subscribes to `stores.coordination` and every imperative publisher routes through
 * its `.getState()`, so two handles built over two `createVizStores()` sets are fully independent.
 * Defaults to `defaultVizStores` (the module singletons) — the byte-identical unprovided path.
 */
export function createCoordinationHandle(
  stores: VizStores = defaultVizStores,
): CoordinationHandle {
  const coordination = stores.coordination

  /** Reactive read of the shared canonical-id point selection. */
  function usePointSelection(): Uint32Array | null {
    return useStore(coordination, s => s.pointSelection)
  }

  /** Reactive read of the origin id that produced the current selection. */
  function useSelectionOrigin(): string | null {
    return useStore(coordination, s => s.selectionOrigin)
  }

  /** Reactive read of the EXCLUSIVE-selection reconciliation signal: `{ epoch, origin }`. A producer
   *  surface watches `epoch` and drops its committed outline whenever `origin !== its own id` (a
   *  single-mode replace elsewhere, or a Clear where origin is null) — cross-cell lifecycle parity. */
  function useExclusiveSelection(): { epoch: number; origin: string | null } {
    const epoch = useStore(coordination, s => s.exclusiveSelectionEpoch)
    const origin = useStore(coordination, s => s.exclusiveSelectionOrigin)
    return useMemo(() => ({ epoch, origin }), [epoch, origin])
  }

  /**
   * Reactive group-mark emphasis for a consuming group chart — the component's visual-stage
   * handler. Reads the CURRENT shared selection and maps it to `{ selectedCodes, active }` over
   * this chart's per-point `codes` via the pure `selectionSync` helpers. `idToRow` is the
   * multi-source seam (absent ⇒ index identity, byte-identical to the legacy inline memo the
   * Views used).
   */
  function useGroupEmphasis(
    codes: Uint16Array | Uint32Array,
    idToRow?: IdToRow | null,
  ): GroupEmphasis {
    const pointSelection = useStore(coordination, s => s.pointSelection)
    return useMemo(
      () =>
        idToRow
          ? groupEmphasisByIds(pointSelection, idToRow, codes)
          : groupEmphasis(pointSelection, codes),
      [pointSelection, codes, idToRow],
    )
  }

  /** Reactive read of ONE identity space's shared canonical-id selection (ITEM-13 image↔data
   *  linking). Reads `selectionBySpace[spaceId]` — kept in lockstep with the top-level selection for
   *  `DEFAULT_SELECTION_SPACE` by the store's `syncDefaultSelectionSpace`, so the default space is
   *  byte-identical to `usePointSelection`; a selection in space A is invisible to a read of space B. */
  function usePointSelectionInSpace(spaceId: string): Uint32Array | null {
    return useStore(coordination, s => s.selectionBySpace[spaceId]?.ids ?? null)
  }

  /** Reactive read of ONE identity space's origin view id (self-echo suppression on the consume leg). */
  function useSelectionOriginInSpace(spaceId: string): string | null {
    return useStore(coordination, s => s.selectionBySpace[spaceId]?.origin ?? null)
  }

  /** Reactive shared (union) color domain across every registered scope coloring by `key`. */
  function useSharedColorDomain(key: string): [number, number] | null {
    const colorScales = useStore(coordination, s => s.colorScales)
    return useMemo(() => resolveSharedDomain(Object.values(colorScales), key), [colorScales, key])
  }

  return {
    usePointSelection,
    useSelectionOrigin,
    useExclusiveSelection,
    useGroupEmphasis,
    useSharedColorDomain,
    usePointSelectionInSpace,
    useSelectionOriginInSpace,
    setSelection: (originId, ids, accumulate) =>
      coordination.getState().setSelection(originId, ids, accumulate),
    setPointSelection: ids => coordination.getState().setPointSelection(ids),
    clearSelection: () => coordination.getState().clearSelection(),
    setSelectionInSpace: (spaceId, originId, ids) =>
      coordination.getState().setSelectionInSpace(spaceId, originId, ids),
    clearSelectionInSpace: spaceId =>
      coordination.getState().clearSelectionInSpace(spaceId),
  }
}

/**
 * The default `CoordinationHandle` — a stable singleton wrapping the app's DEFAULT `Coordination`
 * store (the module singleton set). Views default to it (so a bare `<View />` keeps working) and
 * `CellView`/`GridWorkspace` pass an explicit (per-instance) handle; the unprovided routes all
 * touch the same singleton store, so the handle is a pure indirection.
 */
export const defaultCoordinationHandle: CoordinationHandle = createCoordinationHandle()
