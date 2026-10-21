// registry/registry.ts — the module-level chart-type REGISTRY (EXTENSIBILITY_STUDY
// §3.2/§3.3). This is the ECharts `SeriesModel.registerClass` / `getClass` analog: the
// single source of truth mapping a `type` string → its `ChartTypeDescriptor`, replacing
// the closed `CellKind` union + the exhaustive `switch (cell.kind)`.
//
// PURE: a `Map` + accessor functions, no React, no deck — so `gridModel` (which is also
// deck-free) can read it from `isDenseKind` / `defaultBindings` without pulling in the
// View layer. The descriptors' Views ARE deck-backed, but they live in
// `charts/installBuiltins.tsx`, which this module never imports.

import type { DatasetCatalog } from '../data/wire'
import type { BindingChannel, ChartTypeDescriptor } from './types'
import { isSchemaOnly } from './schemaOnly'

/** The single module-level registry, keyed by the descriptor's `type`. */
const registry = new Map<string, ChartTypeDescriptor>()

/**
 * Register a chart type. Idempotent in the ECharts sense: re-registering the same
 * `type` WARNS and REPLACES (last wins) rather than throwing — so a hot-reload or a
 * double-install never hard-fails. Registration is normally funneled through the
 * `use(installer)` extension surface, which dedupes by installer identity, so this
 * warn path only fires on a genuine duplicate `type` from two different installers.
 *
 * ── SCHEMA-ONLY IS UPGRADE-ONLY (order-independence) ────────────────────────────────
 *
 * A parse-time SCHEMA-ONLY placeholder (registered by `installBuiltinSchemas()` — the real
 * binding schema, no View) may be UPGRADED to its render-capable descriptor from
 * `installBuiltins()`; that is the designed hand-off, so it replaces silently.
 *
 * The reverse is REFUSED. Which installer runs first is decided by module-eval order —
 * `grid/GridWorkspace.tsx` installs the real charts at module load, a host app installs the
 * schemas from its declarative-option validator — and nothing orders those two. When the
 * builtins won that race, the placeholders landed SECOND and clobbered every registered
 * chart: each cell rendered `unsupported kind: <type>` on a fully-registered type, with one
 * "already registered; replacing" warning per built-in as the only trace. Making the
 * placeholder yield to an incumbent chart makes the outcome the same in BOTH orders, which
 * is the property the call sites actually need (`registrationOrder.test.ts`).
 *
 * This is a POLICY on the descriptor's kind, not a re-ordering: a re-order would be one
 * more unwritten rule for the next entry point to break.
 */
export function registerChartType(desc: ChartTypeDescriptor): void {
  const prev = registry.get(desc.type)
  if (prev && isSchemaOnly(desc) && !isSchemaOnly(prev)) {
    // A render-capable descriptor already holds this type — the placeholder has nothing to
    // add and would only take the View away. Silent: this is a no-op on a normal boot path,
    // not a conflict anyone can act on.
    return
  }
  if (prev && !isSchemaOnly(prev) && typeof console !== 'undefined') {
    console.warn(`[viz] chart type "${desc.type}" is already registered; replacing.`)
  }
  registry.set(desc.type, desc)
}

/** Resolve a `type` to its descriptor, or `undefined` for an unregistered type. */
export function getChartType(type: string): ChartTypeDescriptor | undefined {
  return registry.get(type)
}

/** Whether a `type` has a registered descriptor. */
export function hasChartType(type: string): boolean {
  return registry.has(type)
}

/** Every registered descriptor, in registration order. */
export function chartTypes(): ChartTypeDescriptor[] {
  return [...registry.values()]
}

// ── data-shape-aware compatibility (the chart-type switcher's source of truth) ─────────
// A single data shape is compatible with SEVERAL chart types (a `group`+`value` cell is a
// valid violin, box, bar, or dotplot). `compatibleChartTypes` is the pure predicate the
// per-cell kind switcher (and the declarative `switchTo` validation) read to offer ONLY the
// types the data can actually satisfy — instead of every registered type.

/**
 * How many columns of each catalog vocabulary a dataset has. Derived from a `DatasetCatalog`;
 * a chart type's `bindingSchema` is SATISFIABLE iff the counts here cover the channels it needs.
 */
export interface ColumnAvailability {
  readonly categorical: number
  readonly value: number
  readonly continuous: number
}

/** The column counts a `DatasetCatalog` exposes (the availability a schema is checked against). */
export function columnAvailability(catalog: DatasetCatalog): ColumnAvailability {
  return {
    categorical: catalog.categoricalColumns.length,
    value: catalog.valueColumns.length,
    continuous: catalog.continuousColumns.length,
  }
}

/**
 * Whether a chart's `bindingSchema` can be resolved against the available columns — i.e. the
 * dataset has ENOUGH columns of each single-column source for every channel the chart declares.
 * Multiple channels of ONE single-column source (candlestick's five `continuous` price channels)
 * each need a DISTINCT column, so the check counts channels PER source and compares to that
 * source's column count. An empty schema (scatter / image / grid — no channels) is trivially
 * satisfiable; a `valueList` channel consumes several value columns so it only needs ≥1; a `table`
 * channel binds a fixed name (no dataset column) and is always satisfiable.
 *
 * NOTE: compatibility keys each channel on its DECLARED vocabulary — a `continuous` channel counts
 * against continuous columns (not the value-column fallback `overlayEncode` allows for an EXPLICIT
 * binding). That is deliberate: a candlestick (5 continuous channels) must NOT be offered as a
 * switch target for a `group`+`value` cell just because the dataset happens to have value columns.
 */
export function schemaSatisfiable(
  schema: readonly BindingChannel[] | undefined,
  avail: ColumnAvailability,
): boolean {
  let needCategorical = 0
  let needValue = 0
  let needContinuous = 0
  let needValueList = false
  for (const ch of schema ?? []) {
    // An OPTIONAL channel never makes a chart unofferable. The chart renders without it — see
    // `BindingChannel.optional` for why the kind switcher is the thing this protects.
    if (ch.optional) continue
    switch (ch.source) {
      case 'categorical':
        needCategorical++
        break
      case 'value':
        needValue++
        break
      case 'continuous':
        needContinuous++
        break
      case 'valueList':
        needValueList = true
        break
      case 'table':
        break
    }
  }
  if (needCategorical > avail.categorical) return false
  if (needValue > avail.value) return false
  if (needContinuous > avail.continuous) return false
  if (needValueList && avail.value < 1) return false
  return true
}

/** A chart type is "bindingless" — dense (scatter / image, `world2d`) or the nested `grid`
 *  container — when it declares NO binding channels. A bindingless type has no `bindingSchema` to
 *  check columns against, so its offerability is decided by the dataset's SPATIAL substrate (dense)
 *  or excluded outright (the container). */
function isBindingless(desc: ChartTypeDescriptor): boolean {
  return !desc.bindingSchema || desc.bindingSchema.length === 0
}

/**
 * The registered chart types a cell can COMPATIBLY switch to, given the dataset (`catalog`) and —
 * optionally — the cell's `currentKind`. This is DATA-DRIVEN (a data shape is genuinely viewable as
 * several chart types, INCLUDING across the dense↔chart boundary when the dataset supports both —
 * e.g. cells with an embedding AND value/group columns can be a scatter OR a violin). A type is
 * offered iff the dataset can satisfy it:
 *   • a DATA-BOUND chart (non-empty schema) — its `bindingSchema` is `schemaSatisfiable` by the
 *     available columns;
 *   • a DENSE view (bindingless `world2d` — scatter / image) — the catalog has a SPATIAL SUBSTRATE
 *     (≥1 layout OR an image), so it never offers an embedding view for pure tabular data;
 *   • the nested `grid` CONTAINER (bindingless, non-`world2d`) — NEVER a switch target.
 * The `currentKind` is ALWAYS included in its registration position (so the switcher never drops the
 * cell's own selection). Registration order is otherwise preserved.
 */
export function compatibleChartTypes(
  catalog: DatasetCatalog,
  currentKind?: string,
): ChartTypeDescriptor[] {
  const avail = columnAvailability(catalog)
  const hasSpatialSubstrate = catalog.layouts.length > 0 || catalog.hasImage
  const current = currentKind ? registry.get(currentKind) : undefined
  const out: ChartTypeDescriptor[] = []
  for (const desc of registry.values()) {
    if (desc === current) {
      out.push(desc) // the cell's own kind is always selectable
      continue
    }
    if (isBindingless(desc)) {
      // Dense scatter/image render an embedding/raster — offer only when the dataset provides one.
      // A bindingless NON-world2d type is the nested `grid` container — never a switch target.
      if (desc.coordinateSystem !== 'world2d' || !hasSpatialSubstrate) continue
    } else if (!schemaSatisfiable(desc.bindingSchema, avail)) {
      continue
    }
    out.push(desc)
  }
  return out
}
