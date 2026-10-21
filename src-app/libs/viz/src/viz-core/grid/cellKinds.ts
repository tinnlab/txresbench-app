// cellKinds.ts — which view-kinds a pane may switch to, and what each kind binds.
//
// PROVENANCE. These three functions were the only live exports of `CellChrome.tsx`. That file's
// namesake component — the floating dark chrome PILL that predated the occupied-space
// `PaneToolbar` — had no JSX call site anywhere in the tree: `PaneToolbar` replaced it, `CellView`
// renders only `PaneToolbar`, and `CellView`'s own comment beside its `remove` callback already
// recorded that "`CellChrome` is no longer rendered". The component, its props interface, its
// `bindingSummary` helper and its five style constants were therefore dead code — §15's "dead code
// = unfinished work" — while two e2e specs still probed its `viz-cell-chrome-*` testid to decide
// whether a pane's grip was hittable, so BOTH of them had been failing on every run since the pill
// was removed (measured on origin/main: `grid-tearoff` 4/4 red, `grid-cross-window-dock` 1/2 red).
// A dead component whose probes are still live is worse than either alone: the guard reads as
// coverage while asserting nothing about the surface that actually ships.
//
// So the component is gone and these helpers moved to a file named after what they DO. They are
// pure model queries over the chart-type registry — no React, no DOM, no chrome — which is why the
// toolbar was importing them from a component module in the first place.

import { type CellKind, type GridCell } from './gridModel'
import { chartTypes, compatibleChartTypes, getChartType, hasChartType } from '../registry/registry'
import type { BindingChannel } from '../registry/types'
import type { DatasetCatalog } from '../data/wire'

/**
 * Every view-kind a cell can switch to — sourced from the chart-type REGISTRY
 * (`chartTypes()`) instead of a hard-coded array (EXTENSIBILITY_STUDY Part 6 STEP 1).
 * A newly-registered chart type appears in the switcher automatically. REQUIRES
 * `installBuiltins()` to have run (the grid / popout entries call it at module load).
 */
export function cellKindOptions(): CellKind[] {
  return chartTypes().map(d => d.type)
}

/**
 * The view-kinds THIS cell can switch to — DATA-SHAPE-AWARE (the C? kind-switcher fix). A single
 * data shape fits several chart types (a `group`+`value` cell is a valid violin / box / bar /
 * dotplot), so the switcher offers only the COMPATIBLE types, not every registered kind:
 *   1. an EXPLICIT `cell.switchTo` (author-declared alternatives) WINS — filtered to registered
 *      types (parse already validated data-compatibility);
 *   2. else, when a `catalog` is available, the auto-inferred `compatibleChartTypes(catalog,
 *      cell.kind)` set (schema satisfiable + same render family);
 *   3. else (no catalog / compat info) fall back to today's ALL-registered-types behavior.
 * The cell's CURRENT `kind` is ALWAYS included so the `<select>` never drops its own value.
 */
export function cellKindOptionsFor(cell: GridCell, catalog?: DatasetCatalog): CellKind[] {
  let base: CellKind[]
  if (cell.switchTo && cell.switchTo.length > 0) {
    base = cell.switchTo.filter(t => hasChartType(t))
  } else if (catalog) {
    base = compatibleChartTypes(catalog, cell.kind).map(d => d.type)
  } else {
    base = cellKindOptions()
  }
  return base.includes(cell.kind) ? base : [cell.kind, ...base]
}

/**
 * A chart kind's binding schema, READ FROM THE REGISTRY DESCRIPTOR (EXTENSIBILITY_STUDY
 * Part 6 STEP 2). This is how the toolbar learns which data channels a kind needs
 * (value / group / valueKeys / table / …) WITHOUT a hard-coded per-kind list — every
 * per-kind binding fact now lives in the descriptor's `bindingSchema`. An unregistered
 * kind (or a kind with no bindings — scatter / image / grid) yields `[]`.
 */
export function cellBindingSchema(kind: CellKind): readonly BindingChannel[] {
  return getChartType(kind)?.bindingSchema ?? []
}
