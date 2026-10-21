// grid/multiView.ts — the grid's COORDINATE-SYSTEM REGION model (EXTENSIBILITY_STUDY §5.3,
// Part 6 STEP 5). This is the re-seam of the ad-hoc `isDenseKind` / `cellSpaceKey` branch
// into "which coordinate system / render host a cell's descriptor selects":
//
//   cell.kind ──registry──▶ ChartTypeDescriptor.coordinateSystem ──registry──▶ CoordSystemDef
//                                                                                    │
//                                                              host (shared-deck / own-canvas)
//
// The grid is the COMPONENT that provides N `world2d` regions on the shared deck (§1.4:
// one region per dense cell, ECharts' `grid` → N cartesian regions). Each region's identity
// folds in the `cellSpaceKey` link-zoom scope (`spaceKey`) — two shared-deck regions with
// the same key zoom-sync when linked, exactly as before.
//
// PURE (no React, no deck) so it is unit-testable in node. It resolves against BOTH
// registries, so `installBuiltins()` + `installCoordSystems()` must have run first (the
// grid entry point ensures this). Behavior-preserving: `cellRendersOnSharedDeck` is a
// registry-routed drop-in for `isDenseKind` (proven equal in the co-located test), and
// `regionSpaceKey` returns exactly `cellSpaceKey`.

import type { GridCell } from './gridModel'
import { cellSpaceKey } from './gridModel'
import type { CoordSystemId } from '../registry/types'
import { getChartType } from '../registry/registry'
import { getCoordSystem, type CoordSystemDef, type RenderHostId } from '../registry/coordSystem'

/**
 * One grid cell resolved to its coordinate-system REGION (§5.3). This is the coord-system
 * expression of a cell: which system it composes into, which host that system renders on,
 * whether that host is the shared deck (the "dense" partition), and the region's `spaceKey`
 * (link-zoom scope / shared-deck region identity).
 */
export interface GridRegion {
  /** The region's identity — the grid cell id. */
  readonly cellId: string
  /** The coordinate system this cell's descriptor selects. */
  readonly coordSystem: CoordSystemId
  /** The render host that coordinate system draws into. */
  readonly hostId: RenderHostId
  /** `true` when the region lives on the shared single-`<DeckGL>` deck (the dense partition). */
  readonly shared: boolean
  /** The coordinate-space key (`cellSpaceKey`): link-zoom scope + shared-deck region identity. */
  readonly spaceKey: string
}

/**
 * Resolve a cell's coordinate-system def via the two registries: its `kind` → chart
 * descriptor → `coordinateSystem` id → registered `CoordSystemDef`. `undefined` when the
 * kind is unregistered OR its coordinate system is unregistered (either miss ⇒ the cell is
 * not dense and renders the own-canvas fallback — same as `isDenseKind`'s registry miss).
 */
export function cellCoordSystem(cell: Pick<GridCell, 'kind'>): CoordSystemDef | undefined {
  return getCoordSystem(getChartType(cell.kind)?.coordinateSystem)
}

/**
 * Whether a cell renders on the SHARED single-`<DeckGL>` deck (the "dense" partition) —
 * the registry-routed replacement for `isDenseKind`. A cell is on the shared deck IFF its
 * coordinate system's host is `shared`. Behavior-identical to `isDenseKind(cell.kind)`:
 * `world2d` → `shared-deck` host (`shared:true`); `chart2d`/`matrix2d` → `own-canvas`
 * (`shared:false`); an unregistered kind/system → `false`.
 */
export function cellRendersOnSharedDeck(cell: Pick<GridCell, 'kind'>): boolean {
  return cellCoordSystem(cell)?.host.shared === true
}

/**
 * The chart kinds MIGRATED to render as VIEWS in the shared grid deck (shared-deck-charts refactor)
 * instead of their own per-cell `<ChartCanvas>`. Grows one kind per milestone; when it covers every
 * chart kind the own-canvas in-grid path is retired (DEC-2/8). Pop-out windows always use ChartCanvas.
 */
export const SHARED_DECK_CHART_KINDS: ReadonlySet<string> = new Set<string>([
  'volcano',
  'histogram',
  'box',
  'heatmap',
  'bar',
  'dotplot',
  'violin',
])

/**
 * Whether a CHART cell (own-canvas coord system) has been migrated to the shared deck. Dense
 * (world2d) cells are already shared and return false here (they go through `cellRendersOnSharedDeck`).
 */
export function isMigratedChart(cell: Pick<GridCell, 'kind'>): boolean {
  return !cellRendersOnSharedDeck(cell) && SHARED_DECK_CHART_KINDS.has(cell.kind)
}

/**
 * The coordinate-space key a cell's region is identified by (the link-zoom scope, folded
 * into the coord-system region identity). Delegates to `cellSpaceKey` — the single source
 * of truth for the embedding-scoped-zoom policy — so it stays byte-identical.
 */
export function regionSpaceKey(cell: Pick<GridCell, 'kind' | 'layoutId'>): string {
  return cellSpaceKey(cell)
}

/**
 * Resolve one cell to its `GridRegion`, or `null` when its coordinate system is
 * unregistered (a registry miss — the cell renders the own-canvas fallback). Pure.
 */
export function resolveCellRegion(cell: GridCell): GridRegion | null {
  const cs = cellCoordSystem(cell)
  if (!cs) return null
  return {
    cellId: cell.id,
    coordSystem: cs.id,
    hostId: cs.host.id,
    shared: cs.host.shared,
    spaceKey: regionSpaceKey(cell),
  }
}

/**
 * Map the grid's cells to their coordinate-system regions, dropping cells whose system is
 * unregistered. Order-preserving. Pure.
 */
export function buildGridRegions(cells: readonly GridCell[]): GridRegion[] {
  const out: GridRegion[] = []
  for (const cell of cells) {
    const region = resolveCellRegion(cell)
    if (region) out.push(region)
  }
  return out
}

/**
 * The regions that live on the shared single-`<DeckGL>` deck (the N `world2d` regions the
 * grid provides). These are exactly the dense cells; a chart/matrix region owns its own
 * `ChartCanvas` and never enters the shared deck's view/`layerFilter` set.
 */
export function sharedDeckRegions(regions: readonly GridRegion[]): GridRegion[] {
  return regions.filter(r => r.shared)
}
