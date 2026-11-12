// installBuiltins.tsx — the 10 built-in chart types as self-registering
// `ChartTypeDescriptor`s (EXTENSIBILITY_STUDY Part 6 STEP 2). Each descriptor now OWNS its
// chart's binding schema (`bindingSchema`) and a `model()` derived from it; its `view` is a
// THIN ADAPTER that SPREADS `model.bindings` onto the EXISTING `*View.tsx`'s props. So a
// registered chart renders IDENTICALLY to the old `CellView.ChartBody` `switch (cell.kind)`
// — this step lifts the per-kind binding knowledge out of the core and into each descriptor,
// with no behavior change (same bindings resolved, same View props, same render).
//
// `installBuiltins()` registers all ten through the `use(installer)` extension surface;
// it is idempotent (by installer identity + registry last-wins), so calling it from
// every entry (grid + popout + tests) installs exactly once. Call it once at grid setup
// so the registry is populated before any render.
//
// The `capabilities` flags are ENFORCED (viz-followups Area B): `parseOption` stamps the
// effective value onto the cell and `CellView.ChartBody` threads it (falling back to these
// declared defaults) onto the uniform `ChartViewProps`; each adapter forwards it to its View,
// which gates consume (dim/emphasis) / produce (brush/lasso) / dataZoom accordingly. A flag left
// at its declared default reproduces today's behavior — only an explicit opt-out changes render.

import { useMemo, type ComponentType, type ReactNode } from 'react'
import { filteredSource } from '../data/filteredSource'
import type { DataSource } from '../data/wire'
import { use, type Extension, type InstallRegisters } from '../extension'
import type {
  ChartModel,
  ChartTypeDescriptor,
  ChartViewProps,
} from '../registry/types'
import { bindingValue, bindingList } from '../registry/model'
import { categoricalOverrides } from '../data/engine'
import { Unsupported } from './Unsupported'
import { BUILTIN_CHART_SCHEMAS, descriptorFor, type ChartSchema } from './chartSchemas'

/** The categorical override bundle for a chart cell: the render-injected per-GROUP overrides
 *  (`cell.groupOverrides`, set by GridWorkspace from the colorOverride store for grouped charts) win;
 *  else the bundle carried on a dense cell's `colorBy`; else `undefined` (byte-identical no-override). */
function cellOverrides(model: ChartModel): ReturnType<typeof categoricalOverrides> {
  if (model.cell.groupOverrides) return model.cell.groupOverrides
  return model.cell.colorBy ? categoricalOverrides(model.cell.colorBy) : undefined
}
/** LINK FILTERING: wrap a grouped chart's source so it re-computes its shape from only the points inside
 *  its link group's value windows (`cell.linkValueFilters`). No filters ⇒ the SAME source (no re-fetch). */
function useLinkFilteredSource(model: ChartModel, source: DataSource): DataSource {
  const filters = model.cell.linkValueFilters
  return useMemo(() => filteredSource(source, filters), [source, filters])
}
import { RasterImageView } from '../spatial/RasterImageView'
import { ViolinView } from './ViolinView'
import { BoxView } from './BoxView'
import { BarView } from './BarView'
import { HistogramView } from './HistogramView'
import { DotplotView } from './DotplotView'
import { HeatmapView } from './HeatmapView'
import { VolcanoView } from './VolcanoView'

// ── the binding-schema channels + the 10 chart SCHEMAS ───────────────────────────────
// These moved to the render-free `chartSchemas.ts` so a parse-time consumer can register
// the chart types WITHOUT pulling the deck-backed Views below (see that file's header for
// the measured reason). They are re-exported here so every existing importer is unchanged;
// this module supplies the other half — the Views — and registers the full descriptors.
export {
  VALUE_CHANNEL,
  GROUP_CHANNEL,
  CONTINUOUS_VALUE_CHANNEL,
  VALUE_LIST_CHANNEL,
  TABLE_CHANNEL,
  BUILTIN_CHART_SCHEMAS,
  installBuiltinSchemas,
} from './chartSchemas'
export type { ChartSchema } from './chartSchemas'

// ── the thin adapters (uniform ChartViewProps → the existing View's bespoke props) ──
// Each SPREADS `model.bindings` onto exactly the props the old switch-case passed. The
// dense kinds (scatter / image) and the nested `grid` never render a ChartBody in the
// real path (CellView draws them on the shared deck / handles nesting), so their adapters
// render the same visible fallback the old switch produced for those cases.

function ScatterAdapter({ model }: ChartViewProps): ReactNode {
  return <Unsupported kind={model.kind} />
}
// The `image` kind is DENSE (world2d): in the real grid path `GridWorkspace` builds its
// layers on the shared deck via `buildRasterImageLayers` and never renders this adapter.
// It is reached only in the standalone/fallback dispatch path, so it renders the
// builder-backed `RasterImageView` (which consumes the SAME `buildRasterImageLayers`)
// from the cell's resolved `loader` + `channels`. A cell with no resolved pyramid yet
// (loader/channels absent) shows the visible unsupported fallback rather than crashing.
function ImageAdapter({ model }: ChartViewProps): ReactNode {
  const { loader, channels, colormap } = model.cell
  if (loader && loader.length > 0 && channels && channels.length > 0) {
    return <RasterImageView loader={loader} channels={channels} colormap={colormap} />
  }
  return <Unsupported kind={model.kind} />
}
function GridAdapter({ model }: ChartViewProps): ReactNode {
  return <Unsupported kind={model.kind} />
}
// The adapters SPREAD `model.bindings` onto the wrapped View AND forward the injected
// `ChartViewProps.coordination` handle (STEP 3) so the dispatched chart consumes/produces the
// shared selection through it (charts that don't participate — histogram — simply ignore it).
// The AGGREGATED (attribute-based) adapters ALSO forward the cell's OPT-IN `transitions` config
// (threaded from a declarative `series.transitions` by `parseOption` → `GridCell.transitions`), so
// a declarative `<Viz option>` enables + tunes per-plot GPU tweens. Absent ⇒ off (byte-identical).
function ViolinAdapter({ model, source, coordination, consumesSelection, producesSelection, dataZoomAxes }: ChartViewProps): ReactNode {
  const b = model.bindings
  const src = useLinkFilteredSource(model, source)
  // Wire the jitter-dot PRODUCER sink so the violin can publish a lasso selection through the shared
  // coordination handle under THIS cell's id. The GESTURE mode is driven by the global tool rail (via
  // ChartSelectModeContext), NOT a per-plot toolbar.
  return <ViolinView source={src} valueKey={bindingValue(b, 'value')} groupKey={bindingValue(b, 'group')} transitions={model.cell.transitions} coordination={coordination} consumesSelection={consumesSelection} producesSelection={producesSelection} onSelectPoints={coordination ? (idx, accumulate) => coordination.setSelection(model.cell.id, idx, accumulate) : undefined} selectionOriginId={model.cell.id} dataZoomAxes={dataZoomAxes} overrides={cellOverrides(model)} axisTitles={model.cell.axisTitles} typography={model.cell.typography} showGrid={model.cell.showGrid ?? true} />
}
function BoxAdapter({ model, source, coordination, consumesSelection, dataZoomAxes }: ChartViewProps): ReactNode {
  const b = model.bindings
  const src = useLinkFilteredSource(model, source)
  return <BoxView source={src} valueKey={bindingValue(b, 'value')} groupKey={bindingValue(b, 'group')} transitions={model.cell.transitions} coordination={coordination} consumesSelection={consumesSelection} dataZoomAxes={dataZoomAxes} overrides={cellOverrides(model)} axisTitles={model.cell.axisTitles} typography={model.cell.typography} showGrid={model.cell.showGrid ?? true} />
}
function BarAdapter({ model, source, coordination, consumesSelection, dataZoomAxes }: ChartViewProps): ReactNode {
  const src = useLinkFilteredSource(model, source)
  return <BarView source={src} groupKey={bindingValue(model.bindings, 'group')} mode="grouped" transitions={model.cell.transitions} coordination={coordination} consumesSelection={consumesSelection} dataZoomAxes={dataZoomAxes} overrides={cellOverrides(model)} axisTitles={model.cell.axisTitles} typography={model.cell.typography} showGrid={model.cell.showGrid ?? true} />
}
function HistogramAdapter({ model, source }: ChartViewProps): ReactNode {
  return <HistogramView source={source} valueKey={bindingValue(model.bindings, 'value')} transitions={model.cell.transitions} axisTitles={model.cell.axisTitles} typography={model.cell.typography} showGrid={model.cell.showGrid ?? true} />
}
function DotplotAdapter({ model, source, coordination, consumesSelection, dataZoomAxes }: ChartViewProps): ReactNode {
  const b = model.bindings
  const src = useLinkFilteredSource(model, source)
  return <DotplotView source={src} valueKeys={bindingList(b, 'valueKeys')} groupKey={bindingValue(b, 'group')} transitions={model.cell.transitions} coordination={coordination} consumesSelection={consumesSelection} dataZoomAxes={dataZoomAxes} overrides={cellOverrides(model)} axisTitles={model.cell.axisTitles} typography={model.cell.typography} colormap={model.cell.valueColormap} />
}
function HeatmapAdapter({ model, source, coordination, consumesSelection, dataZoomAxes }: ChartViewProps): ReactNode {
  const b = model.bindings
  const src = useLinkFilteredSource(model, source)
  return <HeatmapView source={src} valueKeys={bindingList(b, 'valueKeys')} groupKey={bindingValue(b, 'group')} coordination={coordination} consumesSelection={consumesSelection} dataZoomAxes={dataZoomAxes} overrides={cellOverrides(model)} axisTitles={model.cell.axisTitles} typography={model.cell.typography} colormap={model.cell.valueColormap} />
}
function VolcanoAdapter({ model, source }: ChartViewProps): ReactNode {
  return <VolcanoView source={source} tableName={bindingValue(model.bindings, 'table')} axisTitles={model.cell.axisTitles} typography={model.cell.typography} showGrid={model.cell.showGrid ?? true} />
}

// ── the 10 descriptors = the shared render-free SCHEMAS + this module's Views ─────────
// The schema table (`type` / coordinate system / binding schema / capabilities / the derived
// `model()`) lives in `chartSchemas.ts`; `descriptorFor` pairs one with its View. So the
// parse-time and render-time registrations cannot drift: there is ONE schema table, and a
// descriptor registered here differs from its parse-time placeholder ONLY in `view`.
const byType = (type: string): ChartSchema => {
  const schema = BUILTIN_CHART_SCHEMAS.find(s => s.type === type)
  // Unreachable via the literals below; a loud throw beats a silently missing chart type.
  if (!schema) throw new Error(`[viz] no built-in chart schema for type "${type}"`)
  return schema
}
const descriptor = (type: string, view: ComponentType<ChartViewProps>): ChartTypeDescriptor =>
  descriptorFor(byType(type), view)

// ── DENSE kinds (shared single-Deck, world2d) ────────────────────────────────────────
const scatterDescriptor = descriptor('scatter', ScatterAdapter)
const imageDescriptor = descriptor('image', ImageAdapter)
// ── nested-workspace container ─────────────────────────────────────────────────────
const gridDescriptor = descriptor('grid', GridAdapter)
// ── CHART kinds (own ChartCanvas, chart2d value/category) ──────────────────────────
const violinDescriptor = descriptor('violin', ViolinAdapter)
const boxDescriptor = descriptor('box', BoxAdapter)
const barDescriptor = descriptor('bar', BarAdapter)
// ── MATRIX kinds (own ChartCanvas, matrix2d texel-window) ──────────────────────────
const dotplotDescriptor = descriptor('dotplot', DotplotAdapter)
const heatmapDescriptor = descriptor('heatmap', HeatmapAdapter)
// ── remaining chart2d kinds (no dataZoom / selection today) ────────────────────────
const volcanoDescriptor = descriptor('volcano', VolcanoAdapter)
const histogramDescriptor = descriptor('histogram', HistogramAdapter)

/**
 * Wrap one descriptor as a self-registering `{ install }` extension (EXTENSIBILITY_STUDY
 * Part 6 STEP 7): `use(ScatterChart)` registers ONLY scatter, so an app tree-shakes the
 * chart types it doesn't `use`. Each installer is a stable module-level object so `use()`
 * dedupes it by identity across repeated installs.
 */
function chartInstaller(desc: ChartTypeDescriptor): Extension {
  return { install: r => r.registerChartType(desc) }
}

// ── per-chart installers (STEP 7): `import { ScatterChart, ViolinChart } from '@txresbench/viz/charts'`
//    then `use([ScatterChart, ViolinChart])` to opt into only those. ───────────────────────────
export const ScatterChart: Extension = chartInstaller(scatterDescriptor)
export const ImageChart: Extension = chartInstaller(imageDescriptor)
export const GridChart: Extension = chartInstaller(gridDescriptor)
export const ViolinChart: Extension = chartInstaller(violinDescriptor)
export const BoxChart: Extension = chartInstaller(boxDescriptor)
export const BarChart: Extension = chartInstaller(barDescriptor)
export const DotplotChart: Extension = chartInstaller(dotplotDescriptor)
export const HeatmapChart: Extension = chartInstaller(heatmapDescriptor)
export const VolcanoChart: Extension = chartInstaller(volcanoDescriptor)
export const HistogramChart: Extension = chartInstaller(histogramDescriptor)

/** All ten built-in chart installers (the eager "batteries-included" set). */
export const AllCharts: readonly Extension[] = [
  ScatterChart,
  ImageChart,
  GridChart,
  ViolinChart,
  BoxChart,
  BarChart,
  DotplotChart,
  HeatmapChart,
  VolcanoChart,
  HistogramChart,
]

const BUILTIN_DESCRIPTORS: ChartTypeDescriptor[] = [
  scatterDescriptor,
  imageDescriptor,
  gridDescriptor,
  violinDescriptor,
  boxDescriptor,
  barDescriptor,
  dotplotDescriptor,
  heatmapDescriptor,
  volcanoDescriptor,
  histogramDescriptor,
]

/** The single installer: registers every built-in chart type. Stable module-level
 *  reference so `use()` dedupes it across repeated `installBuiltins()` calls. */
const builtinsInstaller = (r: InstallRegisters): void => {
  for (const desc of BUILTIN_DESCRIPTORS) r.registerChartType(desc)
}

/**
 * Register all 10 built-in chart types into the registry. Idempotent (installs exactly
 * once regardless of how many entries call it). Call once at grid setup so the registry
 * is populated before any cell renders.
 */
export function installBuiltins(): void {
  use(builtinsInstaller)
}
