// useGridLinking.ts — SPLIT K (ITEM-27): the grid's LINK-GROUP plane.
//
// DEC-26's census row "link groups / filters / propagate" (246), moved verbatim out of
// `GridWorkspace`: the three `gridWorkspace` link subscriptions (`linkGroups`, `linkColorIdx`,
// `linkPicking`), the `cellLinkGroup` inverse and the `linkColorFor` / `linkAnchorDataset` readers
// the pane layer paints with, the FILTER-PROPAGATION derivations (`linkGroupHidden`,
// `linkedHiddenFor`, and the column-aware `linkColumnFilterFor` with its two shell-owned ref reads),
// the link-button UX (`linkPopoverCell` + `onToggleLink`), and the Track-C display fan-out
// (`propagateConfirm` + `applyDisplayToGroup`).
//
// It is ONE plane and not three, and the reason is `cellLinkGroup`: the popover handler, the column
// filter and the display fan-out all read it, and it is derived from `linkGroups`, which only the
// subscriptions have. Any internal cut puts that memo on one side of a module boundary and two of
// its three readers on the other.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a fourth time). Every output here is either a `useMemo`/
// `useCallback` derivation with no writer, or `useState` that is ALREADY state. Nothing would become
// state by being promoted into a store, and `linkColumnFilterFor` is read by the recolor effect
// (`useGridColoring`) and the layer-inputs memo (`useGridDeckInputs`) on the hot path, where an
// added subscription is exactly the extra commit TEST-P5 counts.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `linkGroups` / `linkColorIdx` / `linkPicking`
//                           NOT state this plane owns — they are `useStore` READS of
//                           `stores.gridWorkspace`, whose writers (`startLinkPicking`,
//                           `finishLinkPicking`, `applyDisplayPatches`, and the `__vizLinkCells` dev
//                           seam's `setState`) are all OUTSIDE this module and stay where they are.
//                           Moving a read cannot strand a writer, so `tsc` IS complete here.
//   `linkPopoverCell`       one writer set (`setLinkPopoverCell`), and it is a lexical `useState`
//                           whose setter is ALSO passed to `GridPaneLayer` as a prop. A prop is
//                           typed, so `tsc` sees that one; named here because no `grep` of this
//                           module finds it.
//   `propagateConfirm`      three writers: `applyDisplayToGroup` (moved) and the confirm dialog's
//                           two `setPropagateConfirm(null)` calls, which are INSIDE the shell's
//                           `gridRoot` JSX. The setter is therefore RETURNED, and the dialog is
//                           byte-identical.
//   `linkGroupsRef` / `cellLinkGroupRef`
//                           lexical render-time mirrors, written and read only by this plane; `tsc`
//                           is a complete backstop.
//   `perCellGroupLegendRef` / `perCellRangeRef`
//                           NOT moved. `linkColumnFilterFor` READS them, but the shell WRITES them
//                           (from `perCellGroupLegend` / `perCellRange`, two `cellDisplay` /
//                           `plotInteraction` reads that are not link state), and `perCellRangeRef`
//                           is additionally passed to `useGridSelection`. Values with two owners are
//                           passed, not taken — Split I's `activeCellRef` rule, applied twice.
//   `applyDisplayToGroup`   RETURNED rather than kept, because the shell's mask/link dev-window-hook
//                           effect publishes it as `__vizApplyDisplayToGroup`. That effect also
//                           publishes three MASK values, so it could not travel here; the callback
//                           travels instead and the effect reads it unchanged.
//
// NO DEV WINDOW SEAM is installed from this module, and that is deliberate rather than an omission:
// `__vizLinkCells` + `__vizApplyDisplayToGroup` sit in the same effect as `__vizSharedMasks` and the
// three mask mutators, so splitting the effect would duplicate its primary-instance gate and its
// teardown. Asserted absent, so "the seam moved" cannot be claimed by accident.
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { useStore } from 'zustand'
import { LINK_GROUP_COLORS } from '../../adapter/GridWorkspace.store'
import { propagateToLinked, cellHasDisplayOverrides } from './propagateToLinked'
import type { CellLegend } from '../../adapter/CellDisplay.store'
import type { GridCell } from './gridModel'
import type { VizStores } from '../../adapter/vizStores'

export interface GridLinkingInputs {
  readonly stores: VizStores
  /** The workspace's cell records, by id — `linkAnchorDataset` resolves the anchor pane's dataset. */
  readonly cellMap: Record<string, GridCell>
  readonly cells: readonly GridCell[]
  /** Shell-owned. `linkColumnFilterFor` runs from a `[]`-dep callback, so it reads cells off a ref. */
  readonly cellMapRef: RefObject<Record<string, GridCell>>
  /** Shell-owned (written from `cellDisplay.groupLegend`): a grouped chart's group COLUMN id. */
  readonly perCellGroupLegendRef: RefObject<Record<string, CellLegend>>
  /** Shell-owned (written from `plotInteraction.filters`, and also passed to `useGridSelection`). */
  readonly perCellRangeRef: RefObject<Record<string, readonly [number, number]>>
}

export function useGridLinking({
  stores,
  cellMap,
  cells,
  cellMapRef,
  perCellGroupLegendRef,
  perCellRangeRef,
}: GridLinkingInputs) {
  // ── LINK FILTERING groups (feature) ───────────────────────────────────────────────────────
  const linkGroups = useStore(stores.gridWorkspace, s => s.linkGroups)
  const linkColorIdx = useStore(stores.gridWorkspace, s => s.linkColorIdx)
  const linkPicking = useStore(stores.gridWorkspace, s => s.linkPicking)
  // A cell → its link-group id (or null). Memoized so lookups are O(1) in the render loops.
  const cellLinkGroup = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [gid, ids] of Object.entries(linkGroups)) for (const id of ids) out[id] = gid
    return out
  }, [linkGroups])
  const linkColorFor = useCallback(
    (cellId: string): string | undefined => {
      const gid = cellLinkGroup[cellId]
      return gid !== undefined ? LINK_GROUP_COLORS[linkColorIdx[gid] ?? 0] : undefined
    },
    [cellLinkGroup, linkColorIdx],
  )
  // The dataset of the pane that anchored the active link-picking session — only panes of the SAME
  // dataset (identity space) are eligible to join (undefined ⇒ the default/sole dataset ⇒ all eligible).
  const linkAnchorDataset = useMemo(() => {
    if (!linkPicking) return { active: false as const, dataset: undefined as string | undefined }
    const anchor = (linkGroups[linkPicking.groupId] ?? [])[0]
    return { active: true as const, dataset: anchor ? cellMap[anchor]?.datasetId : undefined }
  }, [linkPicking, linkGroups, cellMap])
  // FILTER PROPAGATION: a link group's SHARED hidden-code set = the UNION of every member's own hidden
  // categories (dense `colorBy.hidden`) + hidden groups (`hiddenGroups`). Because linked plots of one
  // dataset share the grouping/color-by column, these codes align — so hiding a category on one member
  // fans to all. Each member then renders with (its own hidden ∪ the group's union). NOTE: value-range
  // (visual-map) filters are NOT yet propagated (only category/group hides) — see the report.
  const linkGroupHidden = useMemo(() => {
    const out: Record<string, Set<number>> = {}
    for (const [gid, ids] of Object.entries(linkGroups)) {
      const set = new Set<number>()
      for (const id of ids) {
        const c = cellMap[id]
        if (c?.colorBy?.hidden) for (const code of c.colorBy.hidden) set.add(code)
        if (c?.hiddenGroups) for (const code of c.hiddenGroups) set.add(code)
      }
      out[gid] = set
    }
    return out
  }, [linkGroups, cellMap])
  // A cell's EFFECTIVE hidden codes = its own ∪ its link group's shared set (empty when unlinked).
  const linkedHiddenFor = useCallback(
    (cellId: string): Set<number> | undefined => {
      const gid = cellLinkGroup[cellId]
      if (gid === undefined) return undefined
      const shared = linkGroupHidden[gid]
      return shared && shared.size > 0 ? shared : undefined
    },
    [cellLinkGroup, linkGroupHidden],
  )
  // Which cell's link-manage popover is open (a linked cell's button opens it). `null` when none.
  const [linkPopoverCell, setLinkPopoverCell] = useState<string | null>(null)
  // The link button handler: linked ⇒ toggle the manage popover; else ⇒ start link-picking.
  const onToggleLink = useCallback(
    (cellId: string) => {
      // During an active picking session the link button FINISHES it (the overlay's per-pane
      // Link / Link-and-Finish buttons are how you add members).
      if (stores.gridWorkspace.getState().linkPicking) {
        stores.gridWorkspace.getState().finishLinkPicking()
        return
      }
      if (cellLinkGroup[cellId] !== undefined) {
        setLinkPopoverCell(prev => (prev === cellId ? null : cellId)) // linked ⇒ manage popover
      } else {
        stores.gridWorkspace.getState().startLinkPicking(cellId) // else ⇒ start picking
        setLinkPopoverCell(null)
      }
    },
    [cellLinkGroup, stores],
  )

  // LINK FILTERING: refs so the recolor effect can build a COLUMN-AWARE group filter (a hidden set is
  // in its CONTRIBUTING plot's column, so a linked plot coloring by a DIFFERENT column still filters).
  const linkGroupsRef = useRef(linkGroups)
  linkGroupsRef.current = linkGroups
  const cellLinkGroupRef = useRef(cellLinkGroup)
  cellLinkGroupRef.current = cellLinkGroup

  /** The link group's shared filter: hidden CATEGORY codes AND continuous VALUE RANGES, each keyed by the
   *  COLUMN it filters on (a dense categorical colorBy's key / a grouped chart's group column for hides;
   *  a continuous colorBy's key + its visual-map range for value windows). A linked cell masks its points
   *  by these columns even when it colors by another column — so a value-range on a linked QC scatter
   *  drops the out-of-range points on a linked category scatter / box / violin too. */
  const linkColumnFilterFor = useCallback(
    (cellId: string): { hiddenCols: Record<string, Set<number>>; valueCols: Record<string, [number, number]> } | null => {
      const gid = cellLinkGroupRef.current[cellId]
      if (gid === undefined) return null
      const hiddenCols: Record<string, Set<number>> = {}
      const valueCols: Record<string, [number, number]> = {}
      const addH = (col: string, codes: Iterable<number>) => {
        const s = (hiddenCols[col] ??= new Set<number>())
        for (const c of codes) s.add(c)
      }
      for (const mid of linkGroupsRef.current[gid] ?? []) {
        const c = cellMapRef.current[mid]
        if (c?.colorBy?.mode === 'categorical' && c.colorBy.hidden && c.colorBy.hidden.size > 0) {
          addH(c.colorBy.key, c.colorBy.hidden)
        }
        if (c?.hiddenGroups && c.hiddenGroups.length > 0) {
          const col = perCellGroupLegendRef.current[mid]?.columnId
          if (col) addH(col, c.hiddenGroups)
        }
        // Continuous/value colorBy with a custom visual-map RANGE ⇒ a value-window filter on that column.
        const rng = perCellRangeRef.current[mid]
        if (rng && c?.colorBy && (c.colorBy.mode === 'continuous' || c.colorBy.mode === 'value')) {
          const col = c.colorBy.key
          const cur = valueCols[col]
          valueCols[col] = cur ? [Math.max(cur[0], rng[0]), Math.min(cur[1], rng[1])] : [rng[0], rng[1]]
        }
      }
      return Object.keys(hiddenCols).length > 0 || Object.keys(valueCols).length > 0 ? { hiddenCols, valueCols } : null
    },
    [],
  )

  // ── Propagate display to link group (segmentation-scale Track C, ITEM-14) ───────────────────────
  // "Apply contrast + palette to link group": copy the focused (source) cell's channels + palette to
  // every OTHER cell in its link group (pure fan-out `propagateToLinked`). ESC-1: cells WITHOUT their
  // own overrides are applied directly; cells that already carry overrides are only overwritten after
  // a confirm listing them. The confirm holds the already-computed patches so accepting just applies.
  const [propagateConfirm, setPropagateConfirm] = useState<{
    patches: ReturnType<typeof propagateToLinked>
    overwriteLabels: string[]
    scopeLabel: string
  } | null>(null)
  const applyDisplayToGroup = useCallback(
    (sourceCellId: string) => {
      const groupId = cellLinkGroup[sourceCellId]
      if (!groupId) return
      const groupIds = linkGroups[groupId] ?? []
      if (groupIds.length < 2) return
      const scope = { channels: true, palette: true }
      const patches = propagateToLinked(sourceCellId, groupIds, cells, scope)
      if (patches.length === 0) return
      // which targets already have their OWN display overrides (⇒ confirm before overwriting them)?
      const patchIds = new Set(patches.map(p => p.cellId))
      const overwrite = cells.filter(c => patchIds.has(c.id) && cellHasDisplayOverrides(c))
      if (overwrite.length === 0) {
        stores.gridWorkspace.getState().applyDisplayPatches(patches)
        return
      }
      setPropagateConfirm({
        patches,
        overwriteLabels: overwrite.map(c => c.title || c.kind || c.id),
        scopeLabel: 'contrast + palette',
      })
    },
    [cellLinkGroup, linkGroups, cells, stores],
  )

  return {
    linkGroups,
    linkColorIdx,
    linkPicking,
    cellLinkGroup,
    linkColorFor,
    linkAnchorDataset,
    linkedHiddenFor,
    linkPopoverCell,
    setLinkPopoverCell,
    onToggleLink,
    linkColumnFilterFor,
    propagateConfirm,
    setPropagateConfirm,
    applyDisplayToGroup,
  }
}
