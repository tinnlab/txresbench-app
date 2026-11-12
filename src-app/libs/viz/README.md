# @txresbench/viz

A domain-neutral, GPU-accelerated chart engine built on [deck.gl](https://deck.gl)
and [luma.gl](https://luma.gl). It renders scatter / image / grid / violin / box /
bar / histogram / dotplot / heatmap / volcano charts on the GPU — **there is no SVG
renderer**. Charts are pluggable: the core dispatches to a registry of chart-type
descriptors and knows nothing about what any individual chart is, so you can register
your own chart type with no privileged access.

The package is framework-neutral at its core (pure TypeScript + a plain-zustand
coordination layer) with a thin React binding on top. It ships no app-specific
vocabulary — everything is expressed in generic terms (points, values, groups,
regions, coordinate systems).

## Install

`@txresbench/viz` is a workspace package. React 19 is a peer dependency.

```ts
import { Viz } from '@txresbench/viz/react'
import { use, registerChartType } from '@txresbench/viz/core'
import { ScatterChart, installBuiltins } from '@txresbench/viz/charts'
```

### Subpath exports

Import from the narrowest subpath you need — the split keeps the engine
tree-shakeable (importing `/core` never pulls in the ten built-in charts).

| Subpath | What it exposes |
| --- | --- |
| `@txresbench/viz` | The full barrel — everything below, re-exported for back-compat. |
| `@txresbench/viz/core` | The engine: chart/coordinate-system registries, the `use(...)` extension surface, the declarative option pipeline (`parseOption`, `VizController`), the plain-zustand coordination + workspace stores, and the pure data/coordination helpers. Renders nothing on its own. |
| `@txresbench/viz/charts` | The ten built-in chart installers (`ScatterChart`, `ViolinChart`, …), `installBuiltins()` / `AllCharts`, and the deck-backed chart Views. |
| `@txresbench/viz/react` | The React surface: `<Viz option={...} />`, `GridWorkspace`, `ExportDialog`, `AxisDataZoom`. |
| `@txresbench/viz/popout` | The SDK-free pop-out window (`PopoutWindow`). |

Only these named subpaths are public — internal modules are not deep-importable.

## Render charts declaratively — `<Viz option={...} />`

`<Viz>` is the declarative façade. You pass a `VizOption` (a whole coordinated grid:
a `dataset`, one or more coordinate-system `grid` regions, and the `series` that bind
to them), plus the deck buffers / `source` / `catalog` that `GridWorkspace` needs.
The built-in chart types must be registered first.

```tsx
import { Viz } from '@txresbench/viz/react'
import { installBuiltins } from '@txresbench/viz/charts'
import type { VizOption } from '@txresbench/viz/core'

installBuiltins() // register the ten built-ins (idempotent)

const option: VizOption = {
  dataset: { id: 'primary' },
  grid: [
    { id: 'left', region: { col: 0 } },
    { id: 'right', region: { col: 1 } },
  ],
  // a selection made in one series fans out to the linked ones
  selection: { mode: 'rect', link: ['pts', 'dist'] },
  series: [
    { id: 'pts', type: 'scatter', coordId: 'left',
      encode: { colorBy: { mode: 'value', key: 'valueA' } } },
    { id: 'dist', type: 'violin', coordId: 'right',
      encode: { valueKey: 'valueA', groupKey: 'group' } },
  ],
}

function Panel(props) {
  // props supply the deck buffers + DataSource/catalog GridWorkspace renders from
  return <Viz option={option} {...props} />
}
```

`<Viz>` re-runs `setOption` whenever `option` changes (a clean replace). Pass
`onController={c => …}` to keep the `VizController` for post-mount `dispatch(action)`
calls (e.g. `{ type: 'select', originId, ids }`).

## Render imperatively — `registerChartType` + `use(...)`

Everything opt-in flows through the ECharts-style `use(installer)` surface. Each
built-in chart is exported as a self-registering installer, so you can pull in only
the ones you need instead of `installBuiltins()`:

```ts
import { use, getChartType } from '@txresbench/viz/core'
import { ScatterChart, ViolinChart } from '@txresbench/viz/charts'

use([ScatterChart, ViolinChart]) // registers ONLY these two
getChartType('scatter') // → the ScatterChart descriptor
```

`registerChartType(descriptor)` is the low-level primitive `use` calls underneath;
call it directly when you are not wrapping your type as an installer. Re-registering
the same `type` warns and replaces (last wins), so hot-reload never hard-fails.
Driving the stores directly is possible via the `VizController`:

```ts
import { VizController } from '@txresbench/viz/core'

const controller = new VizController({ resolveDataset: id => mySource })
await controller.setOption(option)
controller.dispatch({ type: 'select', originId: 'pts', ids: selectedIds })
```

## Write your own chart type

A chart type is one `ChartTypeDescriptor` (`@txresbench/viz/core`). The core dispatches to
it generically — a third-party type is byte-identical in shape to a built-in.

```tsx
import { registerChartType, makeChartModel } from '@txresbench/viz/core'
import type { ChartTypeDescriptor, ChartViewProps, BindingChannel } from '@txresbench/viz/core'

// The data channels this chart needs; each `source` names the catalog vocabulary
// that fills its default (value / categorical / valueList / continuous / table).
const schema: readonly BindingChannel[] = [
  { id: 'value', source: 'value', label: 'Value' },
  { id: 'group', source: 'categorical', label: 'Group' },
]

function MyChartView({ model, source }: ChartViewProps) {
  const valueCol = model.bindings.value // resolved column id
  const groupCol = model.bindings.group
  return <MyDeckCanvas source={source} valueCol={valueCol} groupCol={groupCol} />
}

const MyChart: ChartTypeDescriptor = {
  type: 'my-chart',                 // the `series[].type` / cell kind it matches
  coordinateSystem: 'chart2d',      // 'world2d' (shared deck) | 'chart2d' | 'matrix2d'
  view: MyChartView,                // renders from the uniform ChartViewProps
  capabilities: { consumesSelection: true, dataZoomAxes: ['y'] },
  bindingSchema: schema,
  // resolve a cell + the dataset catalog into the model the View reads
  model: (cell, ctx) => makeChartModel(cell, schema, ctx.catalog),
}

registerChartType(MyChart)
```

Once registered, a `series[].type: 'my-chart'` in a `VizOption` (or a grid cell of
that kind) renders through your `view`. The `view` receives a uniform
`ChartViewProps` — `{ model, source, catalog, coordination? }` — so it also gets the
shared cross-plot selection handle (`coordination`) for free.

### What is (and isn't) `view`-extensible today

The registry is fully open, but a few seams are still built-in. Be aware when
authoring a third-party chart:

- **`chart2d` / `matrix2d` chart types route through your `view`.** A **`world2d`**
  descriptor (dense scatter / image cells) is currently rendered by the built-in
  shared-deck renderer (`GridWorkspace` + `multiView` `layerFilter`), **not** by the
  descriptor's `view`. A registry-driven dense layer-builder seam is the planned
  extension point for world2d — until it lands, a custom world2d `view` is not yet
  invoked. (See `EXTENSIBILITY_STUDY.md`.)
- **`capabilities` flags are advisory today.** `consumesSelection` /
  `producesSelection` / `dataZoomAxes` are parsed into the resolved plan but are
  **not yet enforced at render** — the built-in Views consume/produce selection and
  self-host their dataZoom window unconditionally. Declarative dataZoom-window
  delivery via `ChartViewProps` is a planned seam; today a chart owns its own window
  state. Treat these flags as descriptive metadata for now.
- **`cellSpaceKey`** keys the coordinate-space on the built-in `image` kind — a known
  coupling to revisit when a third-party `world2d` chart needs its own space.
