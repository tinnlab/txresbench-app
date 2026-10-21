// chartSchemas.ts — the RENDER-FREE half of the built-in chart registry: each chart's
// `type` + coordinate system + binding schema + capabilities + derived `model()`.
// Everything `option/parse.ts` reads, and nothing it does not.
//
// ── WHY THIS SPLIT EXISTS (measured, not stylistic) ──────────────────────────────────
// A host app validates every declarative `view_spec`'s `canvas` block through
// `parseOption` at REGISTRATION time — module eval, boot path, every route including the
// login screen. `parseOption` requires the chart types to be registered (it resolves
// `getChartType(series.type)` and checks `bindingSchema` satisfiability), so the app had
// to call `installBuiltins()` at boot. `installBuiltins()` attaches each descriptor's
// deck-backed View, so that one requirement pulled the entire GPU render stack onto the
// boot path.
//
// Measured by ABLATION in the CytoAnalyst app (revert this split, rebuild, read the
// modulepreload set out of `dist/index.html`): calling `installBuiltins()` from the
// validator instead of `installBuiltinSchemas()` puts **+339.7 kB gzip** back onto the
// preloaded critical path — bytes a login screen can never use. (Tree-shaking already
// handles the barrels; it cannot help here, because `installBuiltins` genuinely REQUIRES
// the Views it registers. That is what makes this split, and not an import-path tweak,
// the thing that works.)
//
// `parseOption` never reads `descriptor.view` (verified: it reads only `bindingSchema`,
// `capabilities` and `model`). So the parse-time need is fully served WITHOUT any View.
//
// `installBuiltinSchemas()` registers these descriptors with a visible placeholder View and
// the `SCHEMA_ONLY_DESCRIPTOR` marker. `installBuiltins()` (charts/installBuiltins.tsx,
// unchanged public API) later registers the render-capable descriptors over them — and
// because `GridWorkspace.tsx` calls `installBuiltins()` at MODULE LOAD, any path that can
// actually paint a chart has already performed that upgrade before the first render.
//
// The placeholder is deliberately the VISIBLE `Unsupported` note rather than `null`: if the
// upgrade ever failed to happen, the result must be a loud, testable artifact on screen, not
// a silently blank cell.

import { Unsupported } from './Unsupported'
import { use, type Extension, type InstallRegisters } from '../extension'
import { makeChartModel } from '../registry/model'
import { SCHEMA_ONLY_DESCRIPTOR } from '../registry/schemaOnly'
import type {
  BindingChannel,
  ChartCapabilities,
  ChartTypeDescriptor,
  ChartViewProps,
  CoordSystemId,
} from '../registry/types'

// ── the binding-schema channels (each chart declares which it needs) ─────────────────
/** One value column + one grouping (violin / box). */
export const VALUE_CHANNEL: BindingChannel = { id: 'value', source: 'value', label: 'Value' }
export const GROUP_CHANNEL: BindingChannel = { id: 'group', source: 'categorical', label: 'Group' }
/** The same grouping, for charts that are meaningful WITHOUT one.
 *
 *  A violin or box of a single column is a complete chart — the grouping splits a distribution
 *  that already exists. A BAR or heatmap is not: its grouping IS an axis, so those keep the
 *  required channel above. The distinction is what lets a metrics-only frame (no categorical
 *  column at all) still offer a violin. */
export const OPTIONAL_GROUP_CHANNEL: BindingChannel = { ...GROUP_CHANNEL, optional: true }
/** Histogram's value channel is a CONTINUOUS column (the old `bindings.continuousKey`). */
export const CONTINUOUS_VALUE_CHANNEL: BindingChannel = { id: 'value', source: 'continuous', label: 'Value' }
/** Several value columns (dotplot / heatmap matrices — the old `bindings.valueKeys`). */
export const VALUE_LIST_CHANNEL: BindingChannel = { id: 'valueKeys', source: 'valueList', label: 'Values' }
/** Volcano reads a bulk stat table by name; the fixture ignores the name and returns its DE
 *  table regardless (fixtures.ts `table()`). `'de'` mirrors the old `VOLCANO_TABLE` constant. */
export const TABLE_CHANNEL: BindingChannel = { id: 'table', source: 'table', label: 'Table', constant: 'de' }

/** One built-in chart's render-FREE definition: everything except its View. */
export interface ChartSchema {
  type: string
  coordinateSystem: CoordSystemId
  bindingSchema: readonly BindingChannel[]
  capabilities?: ChartCapabilities
}

/**
 * The 10 built-in chart schemas.
 *
 * coordinateSystem: world2d = the shared single-`<DeckGL>` deck (dense; `isDenseKind`
 * true); chart2d = own ChartCanvas value/category chart; matrix2d = own ChartCanvas
 * texel-matrix. `[]` binding schema for the dense + nested kinds, which have no chart
 * bindings.
 *
 * The capability flags are ENFORCED (viz-followups Area B): `parseOption` stamps the
 * effective value onto the cell and the render path threads it onto `ChartViewProps`.
 * box / bar / dotplot CONSUME the shared selection (group-mark emphasis via the pure
 * `selectionSync` helpers); that was under-declared in STEP 1 and corrected in STEP 3.
 */
export const BUILTIN_CHART_SCHEMAS: readonly ChartSchema[] = [
  // ── DENSE kinds (shared single-Deck, world2d) ──────────────────────────────────────
  {
    type: 'scatter',
    coordinateSystem: 'world2d',
    bindingSchema: [],
    capabilities: { consumesSelection: true, producesSelection: true, dataZoomAxes: ['x', 'y'], linkableColorScale: true },
  },
  {
    type: 'image',
    coordinateSystem: 'world2d',
    bindingSchema: [],
    capabilities: { consumesSelection: true, producesSelection: false, dataZoomAxes: ['x', 'y'], linkableColorScale: true },
  },
  // ── nested-workspace container ─────────────────────────────────────────────────────
  { type: 'grid', coordinateSystem: 'chart2d', bindingSchema: [] },
  // ── CHART kinds (own ChartCanvas, chart2d value/category) ──────────────────────────
  {
    type: 'violin',
    coordinateSystem: 'chart2d',
    bindingSchema: [VALUE_CHANNEL, OPTIONAL_GROUP_CHANNEL],
    capabilities: { consumesSelection: true, producesSelection: true, dataZoomAxes: ['y'] },
  },
  {
    type: 'box',
    coordinateSystem: 'chart2d',
    bindingSchema: [VALUE_CHANNEL, OPTIONAL_GROUP_CHANNEL],
    capabilities: { consumesSelection: true, producesSelection: false, dataZoomAxes: ['y'] },
  },
  {
    type: 'bar',
    coordinateSystem: 'chart2d',
    bindingSchema: [GROUP_CHANNEL],
    capabilities: { consumesSelection: true, dataZoomAxes: ['y'] },
  },
  // ── MATRIX kinds (own ChartCanvas, matrix2d texel-window) ──────────────────────────
  {
    type: 'dotplot',
    coordinateSystem: 'matrix2d',
    bindingSchema: [VALUE_LIST_CHANNEL, GROUP_CHANNEL],
    capabilities: { consumesSelection: true, dataZoomAxes: ['x', 'y'] },
  },
  {
    type: 'heatmap',
    coordinateSystem: 'matrix2d',
    bindingSchema: [VALUE_LIST_CHANNEL, GROUP_CHANNEL],
    capabilities: { consumesSelection: true, producesSelection: true, dataZoomAxes: ['x', 'y'] },
  },
  // ── remaining chart2d kinds (no dataZoom / selection today) ────────────────────────
  { type: 'volcano', coordinateSystem: 'chart2d', bindingSchema: [TABLE_CHANNEL], capabilities: { dataZoomAxes: [] } },
  { type: 'histogram', coordinateSystem: 'chart2d', bindingSchema: [CONTINUOUS_VALUE_CHANNEL], capabilities: { dataZoomAxes: [] } },
]

/**
 * Build a descriptor whose `model()` resolves the chart's OWN `bindingSchema` against the
 * catalog (EXTENSIBILITY_STUDY Part 6 STEP 2). The schema lives in the descriptor; the
 * generic `model` closure is derived from it, so no per-chart binding logic lives in the
 * core. `view` is supplied by the caller — the real adapter (`installBuiltins`) or the
 * placeholder (`installBuiltinSchemas`).
 */
export function descriptorFor(
  schema: ChartSchema,
  view: ChartTypeDescriptor['view'],
): ChartTypeDescriptor {
  return {
    type: schema.type,
    coordinateSystem: schema.coordinateSystem,
    view,
    bindingSchema: schema.bindingSchema,
    capabilities: schema.capabilities,
    model: (cell, ctx) => makeChartModel(cell, schema.bindingSchema, ctx.catalog),
  }
}

/** The visible placeholder standing in for a real chart View at parse time. */
function PlaceholderView({ model }: ChartViewProps) {
  return Unsupported({ kind: model.kind })
}

const schemaOnlyInstaller = (r: InstallRegisters): void => {
  for (const schema of BUILTIN_CHART_SCHEMAS) {
    const desc = descriptorFor(schema, PlaceholderView)
    ;(desc as unknown as Record<symbol, unknown>)[SCHEMA_ONLY_DESCRIPTOR] = true
    r.registerChartType(desc)
  }
}

/**
 * Register all 10 built-in chart types for PARSE/VALIDATION only — real binding schemas
 * and capabilities, placeholder Views, no deck.gl. Idempotent (`use` dedupes by installer
 * identity). Call this from a boot/registration path that must validate a declarative
 * `VizOption`; call `installBuiltins()` (which supersedes these) from a path that renders.
 */
export function installBuiltinSchemas(): void {
  use(schemaOnlyInstaller)
}
