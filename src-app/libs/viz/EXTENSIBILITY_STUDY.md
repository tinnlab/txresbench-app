# `@ziee/viz` extensibility study — an ECharts-style minimal-core + registered-extension architecture for a deck.gl renderer

**Status:** research + design recommendation. No code changes. Written against the current
`viz-core/` tree and a shallow clone of Apache ECharts (`apache/echarts`, `src/`).

**Thesis:** Our module already has all the *machinery* of an ECharts-style system —
a pure model/pipeline layer, a coordination layer, a generic dataZoom, a shared render
host — but it is wired together with a **closed `CellKind` union + an exhaustive
`switch`** instead of a **registry**. The refactor is therefore mostly a *re-seaming*, not
a rewrite: replace the closed union + switch with a `registerChartType(descriptor)` registry,
lift the four chart props (`source`, bindings, coordinate space, selection/zoom participation)
into a uniform descriptor + View contract, and express the whole workspace as a declarative
`option`. The 10 built-ins then become 10 self-registering extension modules over an
unchanged core.

> **As-shipped state vs. this design (honest scope).** The registry + `use(...)` +
> declarative `option` pipeline described below are **shipped**; a few of the seams this
> study lays out are still built-in, so the docs stay truthful about them:
>
> - **`world2d` is not `view`-extensible yet.** Dense scatter / image cells are drawn by
>   the built-in shared-deck renderer (`GridWorkspace` + `multiView` `layerFilter`), **not**
>   by the descriptor's `view`. A registry-driven dense layer-builder seam (the `world2d`
>   render host / `RenderHost` in §5.1 / Part 6) is the planned extension point; `chart2d`
>   and `matrix2d` chart types already route through their descriptor's `view`.
> - **`cellSpaceKey` keys the coordinate-space on the built-in `image` kind.** This is a
>   known coupling to the closed kind vocabulary, to revisit when a third-party `world2d`
>   chart needs its own coordinate space (fold into the `world2d` coord-system link policy,
>   §5.2 / step 5).
> - **`capabilities.consumesSelection` / `producesSelection` are advisory today.** They are
>   parsed into the resolved plan but **not yet enforced at render** — the built-in Views
>   consume/produce selection unconditionally. Declarative enforcement (and dataZoom-window
>   delivery via `ChartViewProps`) is the planned follow-up in §5.2.

---

## Part 1 — What ECharts actually does (with source references)

All paths below are under the ECharts `src/` tree.

### 1.1 The `option` API + the Model→View update pipeline

ECharts is a **two-layer** system: a **Model layer** (pure data/state, no rendering) and a
**View layer** (turns a model into zrender graphics). `setOption(option)` never touches the
DOM directly — it merges the option into models, runs a staged pipeline, and the views
reconcile.

- **`GlobalModel`** (`model/Global.ts`) — the root. Holds the merged option and the flat list
  of every component/series model. `_mergeOption` (`Global.ts:312`) does the deep option merge:
  it topologically travels the registered component types (`ComponentModel.topologicalTravel`,
  `Global.ts:357` — so axes build before the series that reference them), and `getClass(mainType,
  subType)` (`Global.ts:415`) maps an option section like `series[i].type==='bar'` to the
  registered `BarSeries` class (a missing class is the "used but not imported" error,
  `Global.ts:424`). Queries `getComponent(mainType, idx)` (`Global.ts:572`), `queryComponents`
  (`Global.ts:592`), `eachSeries` (`Global.ts:800`) resolve an option section to its model
  instance. The option is partitioned by **`mainType`** (`'series'`, `'xAxis'`, `'dataZoom'`,
  `'grid'`, `'brush'`, `'tooltip'`, …); each entry becomes a model of the matching registered
  class, and a re-`setOption` re-merges into the *same* model instances
  (`ComponentModel.mergeOption`, `Component.ts:178`) so per-model state survives.
- **`ComponentModel`** (`model/Component.ts`) — base class for every non-series component
  (axes, grid, dataZoom, legend, tooltip, visualMap, brush). `static registerClass(clz)` +
  `static registerSubTypeDefaulter` register a concrete subtype under a `type` string.
- **`SeriesModel`** (`model/Series.ts`) — base class for a chart series. Key members:
  `getInitialData(option, ecModel)` (line 348 — builds the series' `SeriesData`/dataset), a
  live `coordinateSystem` field (line 172 — the coord system instance this series was laid out
  in), and `static registerClass` (line 748). A series **declares its data + defaults**, not
  its rendering.
- **`ChartView`** (`view/Chart.ts`) and **`ComponentView`** (`view/Component.ts`) — the render
  side. `ChartView.render(seriesModel, ecModel, api, payload)` reads the (already
  visual-encoded + laid-out) `seriesModel.getData()` and emits zrender elements. Both have
  `static registerClass`.

- **The staged pipeline** lives in `core/echarts.ts` (`updateMethods.update`, lines 1880-1938).
  `setOption` → `prepareView` (line 1687: instantiate + pair a view per model, keyed
  `'_ec_'+model.id+'_'+model.type`) → the `Scheduler` runs the phases in priority order —
  series data tasks → **processors** (`performDataProcessorTasks`, :1909) → coord-system
  `create` (:1905) → coord `update` (:1920) → merged **visual+layout** tasks
  (`performVisualTasks`, :1923) → **`render`** (:1935 → `renderSeries`, :2472 drives each
  `ChartView.renderTask`). Partial-update variants (`updateView`, `updateVisual`, `updateLayout`,
  `updateTransform`) skip earlier phases — an **action's `update` field selects which one runs**
  (§1.5). The phase order (each phase is an *ordered list of registered handlers*, sequenced by
  the `PRIORITY` constants at `echarts.ts:189-208`):

  | Phase | Registered via | What it does |
  |---|---|---|
  | **preprocessor** | `registerPreprocessor` | rewrite the raw option before models exist (back-compat shims) |
  | **transform** | `registerTransform` | dataset → dataset (filter/sort/aggregate) — the `dataset.transform` API |
  | **processor** | `registerProcessor(PRIORITY.PROCESSOR.*, fn)` | operate on `SeriesData` (e.g. `FILTER` priority: **dataZoom's filter**; `STATISTIC`: bar downsample) |
  | **visual** | `registerVisual(PRIORITY.VISUAL.*, fn)` | assign per-datum visuals (color, symbol) — e.g. **brush** + **visualMap** run here |
  | **layout** | `registerLayout(PRIORITY.VISUAL.*, fn)` | assign per-datum geometry in coord space (e.g. `layoutPoints('scatter')`, bar layout) |
  | **coordinate-system** | `registerCoordinateSystem` | create/resize the coord systems before layout |
  | **render** | `ChartView.render` / `ComponentView.render` | model → graphics |

  Option merge/state: a re-`setOption` re-merges into the *same* models (identity preserved by
  `id`/index), so per-model state (a dataZoom window, a selection) survives across updates. The
  models are the single source of truth; views are disposable reconcilers.

### 1.2 The registration / extension system — **the crux**

Everything opt-in flows through **one install contract**. `src/extension.ts`:

```ts
const extensionRegisters = {
    registerPreprocessor, registerProcessor, registerPostInit, registerPostUpdate,
    registerUpdateLifecycle, registerAction, registerCoordinateSystem, registerLayout,
    registerVisual, registerTransform, registerLoading, registerMap, registerImpl, PRIORITY,
    ComponentModel, ComponentView, SeriesModel, ChartView,
    registerComponentModel(C)  { ComponentModel.registerClass(C); },
    registerComponentView(C)   { ComponentView.registerClass(C); },
    registerSeriesModel(C)     { SeriesModel.registerClass(C); },
    registerChartView(C)       { ChartView.registerClass(C); },
    registerCustomSeries(type, renderItem) { ... },
    registerSubTypeDefaulter(type, defaulter) { ... },
    registerPainter(type, Ctor) { ... },
};
export type EChartsExtensionInstallRegisters = typeof extensionRegisters;
export type EChartsExtensionInstaller = (ec: EChartsExtensionInstallRegisters) => void;
export interface EChartsExtension { install: EChartsExtensionInstaller }

export function use(ext /* installer | {install} | array */) {
    if (isArray(ext)) { each(ext, use); return; }
    if (indexOf(extensions, ext) >= 0) return;        // idempotent
    extensions.push(ext);
    if (isFunction(ext)) ext = { install: ext };
    ext.install(extensionRegisters);                   // <-- the whole contract, injected
}
```

So `echarts.use([...])` just calls each module's `install(registers)`, handing it the *entire*
register surface. A chart type is **a module whose `install` registers its own pieces**. The
canonical built-in, `chart/scatter/install.ts`:

```ts
export function install(registers: EChartsExtensionInstallRegisters) {
    use(installGridSimple);                       // ensure its coordinate system exists
    registers.registerSeriesModel(ScatterSeriesModel);
    registers.registerChartView(ScatterView);
    registers.registerLayout(layoutPoints('scatter'));
}
```

`chart/bar/install.ts` is the same shape but richer — it also registers two layout handlers at
different priorities, a `dataSample` **processor** at `PRIORITY.PROCESSOR.STATISTIC`, and an
`registerAction({type:'changeAxisOrder', ...}, handler)`. **The install fn is the entire public
contract of a chart type.** A third-party series (echarts-wordcloud, echarts-gl, liquidfill) is
*byte-identical in shape*: it exports `{ install }` / an installer fn that calls
`registers.registerSeriesModel(...)` + `registers.registerChartView(...)` (+ optionally a
layout/visual/coord-system) — no privileged access, same `registers` object as a built-in.

### 1.3 Series ↔ Component decoupling

`dataZoom`, `brush`, `visualMap`, `tooltip`, `legend`, `grid` are **independent components**,
each with its own model + view, that operate on series **without the series knowing**:

- **`grid`** — `component/grid/installSimple.ts`:
  ```ts
  registers.registerComponentView(GridView);
  registers.registerComponentModel(GridModel);
  registers.registerCoordinateSystem('cartesian2d', Grid);   // <-- grid PROVIDES the coord system
  // + registers x/y AxisModel + XAxisView/YAxisView
  ```
  The grid component is what supplies `cartesian2d`; a series just declares
  `coordinateSystem: 'cartesian2d'` and gets laid out into it.

- **`dataZoom`** — `component/dataZoom/installCommon.ts`:
  ```ts
  registers.registerProcessor(registers.PRIORITY.PROCESSOR.FILTER, dataZoomProcessor);
  installDataZoomAction(registers);              // the 'dataZoom' action mutates the window
  registers.registerSubTypeDefaulter('dataZoom', () => 'slider');
  ```
  dataZoom is **a FILTER-priority processor** (`dataZoomProcessor.ts`): its `getTargetSeries`
  resolves targets purely through model queries — dataZoom → axis index → the series referring to
  that axis (`AxisProxy.getTargetSeriesModels` → `seriesModel.getReferringComponents(axisMainType,
  SINGLE_REFERRING)`) — then `overallReset` calls `axisProxy.filterData(...)`, which reaches into
  each target series' `SeriesData` from the outside (`seriesData.filterSelf` / `.selectRange` /
  map-to-NaN by `filterMode`). **The series has zero dataZoom code and is never named by the
  dataZoom option** — the link is entirely `series → axisIndex → dataZoom`.
  `installDataZoomInside`/`installDataZoomSlider` add the two control UIs (wheel/drag vs. a rail)
  as separate component views over the same model.

- **`brush`** — `component/brush/install.ts`:
  ```ts
  registers.registerComponentView(BrushView);
  registers.registerComponentModel(BrushModel);
  registers.registerPreprocessor(brushPreprocessor);
  registers.registerVisual(registers.PRIORITY.VISUAL.BRUSH, brushVisualStageHandler);  // cross-series selection visual
  registers.registerAction({type:'brush',...}, ...); // + brushSelect / brushEnd actions
  ```
  brush is a **VISUAL-priority stage handler** (`brush` action has `update:'updateVisual'`, so
  only the visual stage re-runs): the user draws a region, `brushVisual` (`visualEncoding.ts`)
  iterates **all** series and asks each `seriesModel.brushSelector(...)` whether a datum is inside
  the region, then re-encodes selected-vs-dimmed across every series. `brushLink` links the
  selection across series by data index. **The series' only contribution is an optional
  `brushSelector` method** (e.g. `ScatterSeries.brushSelector`) — its opt-in *capability*, not a
  dependency on the brush component. (This is the direct precedent for our
  `capabilities.consumesSelection/producesSelection` descriptor flags in Part 3.)

- **`tooltip`/`legend`/`visualMap`** — same pattern: `registerComponentModel` +
  `registerComponentView` (+ actions). Legend toggling a series, visualMap re-coloring by a
  data dimension — all as independent components + actions + visual handlers.

The invariant: **a series composes components by being a passive target of pipeline handlers +
actions the component registered.** No series imports dataZoom or brush.

### 1.4 Coordinate systems as pluggable

`registerCoordinateSystem(type, creator)` (`core/echarts.ts:3190`) registers a coord-system
factory into `CoordinateSystemManager`; `getCoordinateSystemDimensions(type)` exposes its
dimensions. A `SeriesModel` **declares** the type it wants two ways: `defaultOption.coordinateSystem
= 'cartesian2d'` (`ScatterSeries.ts:127`) + `static dependencies = ['grid', ...]`
(`ScatterSeries.ts:88`, so the topological merge builds the grid first). The coord system's own
`create` then **injects the instance into the series**: `injectCoordSysByOption`
(`CoordinateSystem.ts:290`) sets `seriesModel.coordinateSystem = coordSys` (`:340`). So the series
never constructs a projection — it declares a type + gets an instance pushed in. Built-in types:
`cartesian2d` (grid), `polar`, `geo`, `calendar`, `single`, `parallel`, `radar`, `matrix`.

**Multiple systems in one component** — directly relevant to our grid-of-charts.
`coord/cartesian/Grid.ts` `class Grid` (line 103) holds `_coordsList: Cartesian2D[]` and
`_initCartesian` (line 407) iterates **every** `xAxis` + `yAxis` component
(`ecModel.eachComponent('xAxis', ...)`, `'yAxis'`) and builds **one `Cartesian2D` per
(x,y) pair** (line 444 `new Cartesian2D(key)` → `_coordsList.push`). So a *single* grid model
provides *N* independent cartesian systems, and a series binds to one via `xAxisIndex` /
`yAxisIndex`. That is exactly the "one component, many coordinate spaces" shape our grid needs.

### 1.5 Linking charts + the action/event system

- **Actions**: `registerAction(type, eventType, handler)` (`core/echarts.ts:3114`). An action is
  the *only* sanctioned way to mutate state after init: `chart.dispatchAction({type, ...})` →
  the registered handler mutates the relevant models → a re-render is scheduled →
  `eventType` fires on the message center. dataZoom's window change, brush selection, legend
  toggle, highlight/downplay are all actions.
- **`connect()`** (`core/echarts.ts:2994`): puts charts into a **named group**
  (`chart.group = groupId`). `enableConnect` (line 2808) makes every chart in a group listen on
  its `_messageCenter`; when one fires a connection-eligible event, it
  `makeActionFromEvent(event)` and **re-dispatches that action to every other chart in the same
  group** — with an `escapeConnect` guard + a `CONNECT_STATUS_PENDING` latch so the fan-out
  can't loop. dataZoom/brush/highlight thus sync across separate chart instances for free.

  **This is precisely our `Coordination` store fan-out** (a shared scope + `selectionOrigin`
  self-echo suppression), just expressed cross-*instance* instead of cross-*cell*.

### 1.6 Tree-shaking / minimal core

The bare core (`import { init, use } from 'echarts/core'`, entry `src/export/core.ts` —
re-exports `core/echarts` + `./api`) ships **only** the pipeline + registry + the
`use`/`registerXXX` surface. **No charts, no components, no coordinate systems, and no
renderer** — it renders nothing until you `use([...])`. The canonical tree-shaken minimum is
three opt-ins: a chart (`BarChart` → SeriesModel+ChartView), a coordinate-system component
(`GridComponent` → `cartesian2d` + axes), and a renderer (`CanvasRenderer` → a painter);
without any one, nothing draws. `echarts.all.ts` is just "core + eagerly `use` every installer."
Charts/components/renderers are exported as bare installers from `src/export/{charts,components,
renderers}.ts`.

---

## Part 2 — Our code today (what we're refactoring)

We already have the ECharts *substance*, minus the registry seam.

| ECharts concept | Our current equivalent | Where |
|---|---|---|
| Model layer (pure, testable) | pure `*.ts` helpers per chart (`axisWindow`, `selectionSync`, `aggregate`, `chartLayers`, `heatmapExtras`, `violinJitter`) | `viz-core/charts/*.ts`, `coordination/*.ts` |
| ChartView (model→graphics) | the `*View.tsx` React components emitting deck layers | `charts/{ViolinView,BoxView,BarView,HeatmapView,DotplotView,VolcanoView,HistogramView}.tsx`, `spatial/*View.tsx`, `DeckScatterCanvas.tsx` |
| zrender render host | `ChartCanvas` (per-chart `<DeckGL>` + OrthographicView auto-fit) and the shared `GridWorkspace` deck (one `<DeckGL>`, N views, `layerFilter`) | `charts/ChartCanvas.tsx`, `grid/GridWorkspace.tsx`, `layers/multiView.ts` |
| `registerCoordinateSystem` | **implicit**: `isDenseKind()` splits "shared-deck ortho world" vs "own-ChartCanvas fit"; `cellSpaceKey()` shards zoom-linking by space | `grid/gridModel.ts` |
| dataZoom component (FILTER processor) | `AxisDataZoom` + pure `axisWindow` (clamp/zoom/pan/fraction); each View owns the window→re-densify | `charts/AxisDataZoom.tsx`, `charts/axisWindow.ts` |
| brush + `connect()` fan-out | `Coordination` store (`pointSelection` in canonical ids + `selectionOrigin`) + pure `selectionSync` fan-out helpers | `adapter/Coordination.store.ts`, `coordination/selectionSync.ts`, `selection/SelectionController.ts` |
| dataset + `dataset.transform` | the `DataSource` interface (typed-array wire) + `FixtureSource` | `data/wire.ts`, `data/fixtures.ts`, `data/engine.ts` |
| **`registerChartView` / registry** | **MISSING** — a closed `CellKind` union + an exhaustive `switch (cell.kind)` | `grid/gridModel.ts` (`CellKind`), `grid/CellView.tsx` (`ChartBody` switch) |

**The one structural gap.** `CellKind` (`gridModel.ts:15`) is a hardcoded 10-member string union.
`CellView.tsx` `ChartBody` (line 421) is an exhaustive `switch (cell.kind)` that news up each
View **with bespoke props** — `ViolinView` takes `{source, valueKey, groupKey}`, `HeatmapView`
takes `{source, valueKeys, groupKey}`, `VolcanoView` takes `{source, tableName}`. There is no
uniform contract and no registry: adding a chart type means editing the union, the switch, the
`isDenseKind` predicate, `defaultBindings`, and the chrome's kind-switcher. That is the
anti-pattern the ECharts registry exists to kill.

Two more couplings worth naming, because the refactor must preserve them:

- **Dense vs. chart is a *coordinate-system* distinction, not a special case.** `isDenseKind`
  routes scatter/image into the shared single-`<DeckGL>`/N-views deck (one WebGL context, pan/zoom
  in world space, `layerFilter` by `<cellId>::` prefix) and everything else into its own
  `ChartCanvas` (auto-fit ortho, category/value axes). In ECharts terms these are **two
  coordinate systems**: a `world2d` (free ortho camera, shared context) and a `chart2d`
  (independent-axis auto-fit). Chart cells even sub-divide: violin/box/bar/volcano are
  value-vs-category with a free-ish camera; heatmap/dotplot are `controller:false` texel-matrix
  framing driven only by `bounds`. That is a *third* coordinate flavor (`matrix2d`).

- **Selection fan-out is already canonical-id + origin-tagged** (the `pointIds`/`idToRow` seam in
  `selectionSync.ts` + `Coordination.setSelection(originId, ids)`). This is more principled than
  ECharts brush (which is index-based within one dataset). Keep it; it is the moat.

---

## Part 3 — The core / extension boundary for `@ziee/viz`

### 3.1 What the MINIMAL CORE owns

The bare `@ziee/viz/core` renders **nothing** on its own (ECharts §1.6). It owns:

1. **The option parser + update pipeline.** Parse a declarative `VizOption` into models; run the
   staged pipeline (below); reconcile Views. State (dataZoom windows, selection) lives in models
   and survives re-`setOption`.
2. **The registry** — `registerChartType`, `registerCoordinateSystem`, `registerComponent`,
   `registerAction`, `registerLayout`/`registerVisual`/`registerProcessor`, and `use([...])`.
   This is `viz-core/extension.ts` (new), a near-verbatim port of ECharts `extension.ts`.
3. **The coordinate-system manager** — resolves a `coordinateSystem` type string to a registered
   creator. Ships **no** built-in systems in bare core (they arrive via `use`).
4. **The render-host abstraction** — the two deck hosts already exist (`ChartCanvas` +
   `GridWorkspace`/`multiView`). Core owns the *seam* (a `RenderHost` that accepts
   `Layer[]` + a viewState per coordinate region), not any chart's layers.
5. **The coordination + dataZoom components' *mechanism*** — the `Coordination` store, the pure
   `selectionSync`/`axisWindow` math, the `connect()`-style group fan-out. These are core
   *components* (like ECharts' brush/dataZoom living in `component/`), opt-in via `use` but part
   of the framework, not any one chart.

Everything chart-specific — every `*View`, every binding schema, every aggregation kernel — is
**out** of bare core.

### 3.2 What a CHART EXTENSION provides — the descriptor

A chart type is a self-contained module that, in its `install(registers)`, calls
`registers.registerChartType(descriptor)`. The descriptor is the uniform contract that replaces
the `CellKind` union + the bespoke-props switch:

```ts
// viz-core/registry/types.ts  (NEW — the public extension contract)

/** Which render host + coordinate flavor a chart lives in. */
export type CoordSystemId =
  | 'world2d'    // shared single-<DeckGL>/N-views deck, free ortho camera (scatter, image, spatial)
  | 'chart2d'    // own ChartCanvas, independent-axis auto-fit (violin, box, bar, volcano, histogram)
  | 'matrix2d'   // own ChartCanvas, controller:false texel-window framing (heatmap, dotplot)

/** Everything the core needs to run one chart type WITHOUT knowing what it is. */
export interface ChartTypeDescriptor<Opt extends ChartSeriesOption = ChartSeriesOption> {
  /** The `type` string an option's `series[].type` matches (e.g. 'violin'). Unique. */
  readonly type: string

  /** Which coordinate system / render host this series composes into. */
  readonly coordinateSystem: CoordSystemId

  /**
   * MODEL: normalize + validate the raw option section into a resolved model.
   * Pure; no React, no deck — unit-testable in node (mirrors SeriesModel.getInitialData).
   * `catalog` lets a series fill defaults from the dataset (our `defaultBindings`).
   */
  readonly model: (raw: Opt, ctx: ModelContext) => ChartModel<Opt>

  /**
   * VIEW: the React component that turns a resolved model into deck layers inside the
   * host the `coordinateSystem` selects. ONE uniform props contract (see ViewProps) —
   * NOT bespoke per chart. This replaces the `switch (cell.kind)`.
   */
  readonly view: React.ComponentType<ChartViewProps<Opt>>

  /** How this chart PARTICIPATES in the shared components (opt-in, all default off). */
  readonly capabilities?: {
    /** CONSUME a shared point-selection (emphasis). e.g. scatter dims, heatmap bands rows. */
    readonly consumesSelection?: boolean
    /** PRODUCE a point-selection (has a brush/lasso/band gesture). */
    readonly producesSelection?: boolean
    /** Which axes accept a dataZoom window: none | ['y'] | ['x','y'] | ['index-x','index-y']. */
    readonly dataZoomAxes?: readonly ('x' | 'y')[]
    /** Reads the shared color domain (linked color scale). */
    readonly linkableColorScale?: boolean
  }

  /** OPTIONAL pure pipeline handlers this chart contributes (like bar's dataSample). */
  readonly processors?: PipelineHandler[]
  readonly layouts?: PipelineHandler[]
}
```

The **uniform View props** — the single contract every chart View honors (this is what lets the
core dispatch generically instead of `switch`ing on bespoke props):

```ts
export interface ChartViewProps<Opt extends ChartSeriesOption = ChartSeriesOption> {
  /** The resolved model (post-`model()`), incl. the bindings the option declared. */
  readonly model: ChartModel<Opt>
  /** The data plane (unchanged DataSource). */
  readonly source: DataSource
  /** The live pixel rect this chart paints into (from the grid measurer). */
  readonly rect: PaneRect
  /** The coordination handle: read shared selection/zoom/color, publish selection. */
  readonly coordination: CoordinationHandle
  /** The dataZoom window(s) this chart's axes are currently framed to (core-owned). */
  readonly window?: Record<'x' | 'y', AxisWindow>
  /** Theme, a11y, export hooks. */
  readonly theme?: ChartTheme
}
```

- `model` carries the *validated bindings* (`valueKey`/`groupKey`/`valueKeys`/`tableName`/…), so
  the bespoke prop lists (`ViolinView({valueKey,groupKey})`, `HeatmapView({valueKeys,groupKey})`)
  become **fields of the resolved model** — each chart's `model()` knows its own binding schema,
  the core does not.
- `coordination` replaces every current direct `useCoordinationStore(...)` call *inside* a View
  with an injected handle, so the View is decoupled from the concrete store (testable + the
  coordination component is swappable).
- `window` is filled by the **dataZoom component** (core), not the View. The View reacts to a
  window by re-densifying (violin's KDE-in-window) or re-framing (matrix). Today each View owns
  its own window state + slider; after the refactor the window is *core state driven by the
  dataZoom component*, and the View is a passive consumer that declares `dataZoomAxes` in its
  descriptor. (This is exactly ECharts' "series is passive; dataZoom is a FILTER processor.")

### 3.3 The registry + `use`

```ts
// viz-core/extension.ts  (NEW — ~verbatim ECharts port)
const registers = {
  registerChartType, registerCoordinateSystem, registerComponent,
  registerAction, registerLayout, registerVisual, registerProcessor, PRIORITY,
}
export type InstallRegisters = typeof registers
export type Installer = (r: InstallRegisters) => void
export function use(ext: Installer | { install: Installer } | Array<...>) { /* idempotent, per ECharts */ }
```

A built-in chart module (e.g. `charts/violin/install.ts`) becomes:

```ts
export function install(r: InstallRegisters) {
  r.use(installChart2dCoord)                 // ensure the chart2d host/coord exists
  r.registerChartType(violinDescriptor)      // model + view + capabilities
}
```

And a **minimal app** does:

```ts
import { use } from '@ziee/viz/core'
import { GridWorkspace, DataZoom, Selection } from '@ziee/viz/components'
import { ScatterChart, ViolinChart, HeatmapChart } from '@ziee/viz/charts'
use([ GridWorkspace, DataZoom, Selection, ScatterChart, ViolinChart, HeatmapChart ])
```

Nothing chart-specific is hardcoded in core; a third-party `MyWeirdChart` is the same
`{ install }` shape with no privileged access — the ECharts external-extension path (§1.2).

### 3.4 The pipeline core runs on `setOption`

Port ECharts' staged pipeline, adapted to our layers:

```
parse VizOption
  → preprocessors (option shims)
  → dataset transforms (DataSource-level filter/derive — future; today identity)
  → per-series model() (validate bindings, fill from catalog)   [descriptor.model]
  → coordinate-system resolve (world2d / chart2d / matrix2d instances; grid builds N regions)
  → processors  (dataZoom FILTER: apply window → the series' visible data/domain)  [component]
  → visual      (selection emphasis, linked color-scale union)                     [component]
  → layout      (per-series geometry: jitter, KDE, matrix pivot)          [descriptor.layouts]
  → render      (mount each descriptor.view into its coord region's host)   [descriptor.view]
```

The Views stay React (deck's ergonomic binding), so "render" = reconcile which
`ChartViewProps` each mounted View gets; but *what data/window/selection those props carry* is
computed by the core pipeline, not ad-hoc inside each View.

---

## Part 4 — The `option` API shape for us

A declarative `VizOption` in the ECharts spirit, describing a **linked scatter + heatmap grid
with dataZoom + selection** — the exact scenario the current stores wire imperatively:

```ts
const option: VizOption = {
  dataset: { id: 'demo' },                      // resolves to a DataSource

  // Coordinate systems (like ECharts grid/xAxis/yAxis). ONE grid, MULTIPLE regions.
  grid: [
    { id: 'g-left',  region: { col: 0 } },      // split-tree slot (replaces GridWorkspace layout)
    { id: 'g-right', region: { col: 1 } },
  ],

  // Independent COMPONENTS, each composing over series by id (never baked into a series):
  dataZoom: [
    { id: 'z-scatter', type: 'inside', coordId: 'g-left',  axes: ['x', 'y'] },   // world2d pan/zoom
    { id: 'z-heat',    type: 'slider', coordId: 'g-right', axes: ['x'] },         // matrix2d window
  ],
  selection: {                                   // our brush/connect analog
    mode: 'lasso',
    link: ['s-scatter', 's-heat'],               // members fan selection to each other (connect())
  },
  colorScale: { link: ['s-scatter'] },           // linked color domain (ITEM-64)

  // Series — each names its TYPE (registry key), its coord, and its BINDINGS (the model schema):
  series: [
    {
      id: 's-scatter', type: 'scatter', coordId: 'g-left',
      encode: { layout: 'umap', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
      emphasis: { consumesSelection: true },     // dim unselected on shared selection
      select:   { produces: true },              // lasso/rect gesture publishes canonical ids
    },
    {
      id: 's-heat', type: 'heatmap', coordId: 'g-right',
      encode: { groupKey: 'celltype', valueKeys: ['Feature A', 'Feature B', 'Feature C'] },
      emphasis: { consumesSelection: true },     // selected points → highlighted group rows
      cluster: { rows: true, cols: false },      // chart-specific option, validated by heatmap's model()
    },
  ],
}

viz.setOption(option)
// later, imperatively (the ACTION path):
viz.dispatch({ type: 'select', originId: 's-scatter', ids })   // fans to s-heat via `selection.link`
viz.dispatch({ type: 'dataZoom', id: 'z-scatter', window: { x: {lo, hi}, y: {lo, hi} } })
```

Notes on the mapping:
- `series[].type` is the registry key (`registerChartType(descriptor).type`). No `CellKind`.
- `encode`/bindings are validated by that series' own `model()`; core never enumerates them.
- `dataZoom`/`selection`/`colorScale`/`grid` are the **decoupled components** — a series composes
  them by *id reference + capability flags*, exactly like ECharts.
- `dispatch(action)` is the sole post-init mutation path (dataZoom window, selection). The
  current imperative store calls (`setGridViewState`, `setSelection`) become action handlers.

---

## Part 5 — How our specifics map

### 5.1 deck.gl instead of zrender

The **model + pipeline layer is renderer-agnostic and transfers unchanged.** ECharts' Model
layer never touches zrender; ours never touches deck. What changes is only the **View layer**:

- ECharts `ChartView.render()` emits zrender `Element`s into a zrender group. Our
  `descriptor.view` emits deck `Layer[]` into an OrthographicView. Same contract ("model →
  graphics for my coord region"), different graphics primitive.
- ECharts' zrender host = one canvas. Ours = **two host flavors already built**: the shared
  single-`<DeckGL>`/N-views deck (`GridWorkspace` + `multiView.ts` `layerFilter` by `<cellId>::`
  prefix) for `world2d`, and per-chart `<DeckGL>` (`ChartCanvas` auto-fit) for `chart2d`/`matrix2d`.
  These become the two registered **render hosts** behind the `RenderHost` seam; the `layerFilter`
  cell-routing is our equivalent of zrender's per-view clipping.
- GPU specifics (LOD-while-panning, density auto-switch, in-shader colormap LUT, persistent
  attribute buffers in `DeckScatterCanvas`) are **View-internal** and stay put — they're the
  deck analog of a zrender custom element's paint routine. The core neither knows nor cares.

### 5.2 Cross-plot selection + zoom SYNC as decoupled components

- Our **`Coordination` store fan-out + `selectionOrigin`** IS ECharts `connect()` (§1.5): a
  shared group, an origin tag to suppress self-echo, notify-and-refetch. Reframe it as the
  **`Selection` component** (a core component registered via `use`), and make each chart's
  participation declarative (`capabilities.consumesSelection` / `producesSelection`) instead of
  each View reaching into the store. The pure `selectionSync` helpers
  (`highlightMaskForIds`/`groupEmphasisByIds`/`highlightedRowPositions`) become the component's
  **visual-stage handler** (ECharts' `brushVisualStageHandler` analog): one place computes each
  chart's emphasis artifacts from the shared selection.
- Our **`AxisDataZoom` + `axisWindow`** IS the ECharts dataZoom component (§1.3): the pure window
  math (clamp/zoom/pan/fraction) is the model; the rail/wheel is the control view. Reframe it as
  the **`DataZoom` component**: it owns each `dataZoomAxes`-declaring chart's window as core state
  and hands it down via `ChartViewProps.window`. The chart reacts (re-densify/re-frame) — it no
  longer owns the slider or the window `useState`. This is the biggest single decoupling win:
  today the value-window state + slider live *inside* `ViolinView`; after, they're a core
  component the violin merely *declares it accepts*.
- **Zoom sync across cells** (`cellSpaceKey` sharding + `gridScopeId`) becomes the `world2d`
  coordinate system's link policy: cells sharing a coord-space instance share a view state — the
  same "one grid, N cartesian regions, some sharing an axis" model as ECharts `Grid._coordsList`.

### 5.3 Grid-of-charts as the coordinate-system model

`GridWorkspace` + the split-tree (`gridModel.orderedCells`, `multiView.buildViews`) map onto
ECharts' **`grid` component providing N coordinate regions** (`Grid._initCartesian` builds one
`Cartesian2D` per axis pair, §1.4). Our `grid[]` option entries are the region definitions; each
`series[].coordId` binds a chart to a region (ECharts `xAxisIndex`/`yAxisIndex`). The measurer
(ResizeObserver → `PaneRect[]`) is the layout step that sizes each region — ECharts' `Grid.resize`.
Drag-to-swap / split / pop-out stay as **actions** that mutate the `grid`/`series` option and
re-`setOption`.

### 5.4 `DataSource` as the dataset/transform layer

`DataSource` (`data/wire.ts`) is already our `dataset`. Give the option a `dataset` section that
resolves to a `DataSource`, and add an optional **transform** phase (ECharts `registerTransform`)
for DataSource-level derive/filter (densify, subset, join) — today `FixtureSource` +
`engine.computeColoring` do this ad hoc inside Views; lifting it into a registered transform
makes it a pipeline stage every chart shares (mirrors our existing `chart/extensions/file/processor.ts`
"single source of truth" instinct on the backend).

---

## Part 6 — Migration path (incremental, no big-bang)

The refactor is a **strangler-fig around the `switch`**, in the order below. Each step ships
green; the `option` API arrives last, on top of a registry that already works.

1. **Introduce the descriptor + registry, adapter-backed (no behavior change).** Add
   `viz-core/registry/{types,registry}.ts` and `extension.ts`. Write a `ChartTypeDescriptor`
   for each of the 7 chart kinds whose `view` is a **thin adapter** wrapping the *existing*
   `*View.tsx` (mapping the uniform `ChartViewProps` → the current bespoke props). Register them
   from one `installBuiltins()`. **`CellView.ChartBody`'s `switch` is replaced by a registry
   lookup** (`registry.get(cell.kind).view`) — the only edit to the render path. `isDenseKind`
   becomes `registry.get(kind).coordinateSystem === 'world2d'`. `defaultBindings` moves into each
   descriptor's `model()`. Delete the `CellKind` union in favor of `type: string` validated
   against the registry. Everything else is byte-identical. *Risk: low.* This alone kills the
   closed-union anti-pattern.

2. **Lift the bindings into the model.** Move each View's bespoke prop shape into its
   descriptor's `model()` (violin's `{valueKey,groupKey}`, heatmap's `{valueKeys,groupKey}`,
   volcano's `{tableName}`), so the adapter shrinks to "render `model` fields." The chrome's
   kind-switcher + per-cell color-by picker read the registry (available types, each type's
   binding schema) instead of a hardcoded list. *Risk: low.*

3. **Extract the `Selection` component.** Replace direct `useCoordinationStore` reads inside Views
   with an injected `CoordinationHandle` + declarative `capabilities.consumesSelection/produces`.
   Move the emphasis computation into one visual-stage handler over `selectionSync`. Behavior
   identical; the store becomes an implementation detail of the component. *Risk: medium* (touches
   every consuming View, but the pure helpers don't change — they're already the moat).

4. **Extract the `DataZoom` component.** Hoist the value-window/matrix-window state out of the
   Views into the core component; feed it back via `ChartViewProps.window`; Views declare
   `dataZoomAxes` and react. `AxisDataZoom`/`ValueAxisZoom`/`MatrixDataZoom` become the component's
   control views. *Risk: medium-high* — the violin's window→KDE-re-densify effect is the trickiest
   (it's a real data recompute, not just a camera). Keep the re-densify *inside* the violin View
   (it's chart-specific); only the *window value* moves to the component.

5. **Formalize the coordinate systems.** Register `world2d`/`chart2d`/`matrix2d` as coordinate
   systems; `grid` becomes a component providing N `world2d` regions (fold in `cellSpaceKey`
   link policy). The two deck hosts become the registered `RenderHost`s. *Risk: medium.*

6. **Add `setOption` + the option parser + actions on top.** With the registry + components in
   place, the declarative `VizOption` (Part 4) is a thin front-end: parse → models →
   pipeline → mount. The current stores (`GridWorkspace.store`, `Coordination.store`) become the
   backing state the actions mutate. Ship `dispatch(action)` for selection/dataZoom/grid. *Risk:
   medium* — but purely additive; the imperative API keeps working underneath.

7. **Package split.** `@ziee/viz/core` (pipeline + registry + hosts + Coordination/DataZoom/Selection
   components), `@ziee/viz/charts/*` (one self-registering module each), `@ziee/viz/react` (the
   `<Viz option>` binding). Tree-shakeable: an app `use`s only the charts it needs.

**Sequencing rule:** steps 1–2 are pure re-seaming (do first, high value/low risk); 3–5 decouple
the components (medium); 6–7 add the declarative surface (additive). At no point is the app
non-functional.

---

## Part 7 — Honest gaps: where the ECharts model does NOT fit deck.gl / coordinated-multi-view

1. **One canvas vs. one WebGL context per host.** ECharts assumes a single zrender canvas; every
   component draws into it, so cross-component compositing (a brush rectangle over a series) is
   free. We deliberately run **two host regimes**: a *shared* single-`<DeckGL>` deck for
   `world2d` cells (one context, `layerFilter` routing) and *per-chart* `<DeckGL>` for
   chart/matrix cells (WebGL-context budget: too many live contexts crash the browser). A pure
   ECharts port would put every chart in one context; we cannot, because a 10M-point scatter's GPU
   state (LOD buffers, colormap LUT, density aggregation) must not share a context with a heatmap's
   texture. **Do instead:** keep the `CoordSystemId` → `RenderHost` seam (Part 3.1). The core owns
   *which host* a series mounts into; it does not assume one canvas. Cross-host overlays (a
   selection rectangle spanning a scatter and a heatmap) are DOM overlays (as `GridWorkspace`
   already does), not shared-canvas graphics.

2. **The FILTER-processor model of dataZoom is a poor fit for GPU re-densify.** ECharts dataZoom
   *filters the SeriesData array* before layout — cheap on a few-thousand-point series. Our violin
   value-window **re-runs a GPU KDE over the in-window values** (debounced, subsampled); our matrix
   window **re-frames + re-LODs a texel matrix**. These are not "filter the array" — they're
   chart-specific recomputes. **Do instead:** the DataZoom *component* owns only the window
   **value** (the model); the *reaction* (re-densify/re-frame) stays inside the chart's View as a
   window-keyed effect. Don't force the ECharts "processor mutates shared data" shape onto a GPU
   recompute — declare `dataZoomAxes` and let the View react.

3. **Selection is per-datum-index in ECharts, canonical-id in ours.** ECharts brush selects array
   indices within one dataset. Our selection is **canonical point ids across independently-computed
   embeddings/subsets/datasets** (`pointIds`/`idToRow`). This is *more* capable; don't regress it to
   index-based to match ECharts. **Do instead:** the `Selection` component's wire type is canonical
   ids; each chart maps ids ↔ its local rows in its visual handler (already implemented in
   `selectionSync`). Keep it.

4. **React Views vs. ECharts' imperative reconciler.** ECharts diffs zrender elements itself
   (`ChartView` keeps element references, animates transitions). We lean on React + deck's own
   attribute diffing. This means our "render" phase is *declarative reconciliation*, not ECharts'
   imperative element-diff. **Consequence:** we don't get ECharts' cross-update morph animations for
   free; deck's `updateTriggers` + our epoch-bump pattern (`colorEpoch`/`selectionEpoch`) are the
   substitute. Fine — but the pipeline's "render" step must be understood as "compute each mounted
   View's props," not "emit elements." The descriptor's `view` being a React component (not a
   `render(model)` fn) is the deliberate divergence.

5. **Progressive rendering / streaming.** ECharts has `registerProcessor` progressive-render hooks
   for huge series. Our large-N story is *GPU offload* (LOD sampling, density aggregation) inside
   the scatter View, not a CPU progressive pipeline. Don't port ECharts' progressive machinery;
   our GPU path is the equivalent and lives (correctly) in the View.

6. **`matrix2d` has no free camera — it breaks the "coordinate system = a projection" abstraction.**
   Heatmap/dotplot use `controller:false` + `bounds`-window framing (a free ortho zoom on a texel
   grid is meaningless). ECharts' cartesian is always a continuous projection. **Do instead:** model
   `matrix2d` as a coordinate system whose "zoom" is a **discrete index window**, not a continuous
   camera — which is why `axisWindow` already carries a `snap` (whole-cell) hook. Keep the two zoom
   idioms (continuous camera for world2d/chart2d, index-window for matrix2d) as distinct
   coordinate-system behaviors, not one camera abstraction.

---

## Summary recommendation

1. **Add a registry (`registerChartType(descriptor)` + `use([...])`), port ECharts `extension.ts`
   near-verbatim, and delete the closed `CellKind` union + the `switch (cell.kind)`.** This is the
   crux and the highest-value/lowest-risk step — do it first with adapter-backed descriptors so
   behavior is unchanged.
2. **Give every chart a uniform `ChartViewProps` contract** and push its bespoke bindings into the
   descriptor's `model()`. The core dispatches generically; each chart owns its own schema.
3. **Reframe our existing coordination + dataZoom as decoupled core *components*** (the ECharts
   brush/connect + dataZoom analogs) that charts *declare participation in* via capability flags —
   the pure `selectionSync`/`axisWindow` math is already the right shape and stays the moat.
4. **Model dense-vs-chart-vs-matrix as three registered coordinate systems** over the two deck
   render hosts we already have, and the split-grid as ECharts' "one grid, N coordinate regions."
5. **Layer the declarative `VizOption` + `setOption`/`dispatch(action)` on last**, on top of a
   registry + components that already work imperatively — additive, no big-bang.

The deck.gl renderer changes **only the View layer**; the ECharts model/pipeline/registry/
coordination architecture ports cleanly. The three honest divergences to hold onto: **multi-host
(not one canvas)**, **canonical-id selection (not index)**, and **chart-owned GPU recompute on a
dataZoom window (not a shared FILTER processor)**.
