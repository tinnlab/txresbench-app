// @ziee/viz/charts — the tree-shakeable CHARTS subpath (EXTENSIBILITY_STUDY Part 6 STEP 7).
// Each built-in chart is exported BOTH as a self-registering `{ install }` installer (so an app
// can `use([ScatterChart, ViolinChart])` and pull in ONLY those) AND collectively via
// `installBuiltins()` / `AllCharts` (the eager batteries-included set). Importing an individual
// installer does NOT register it — `use(...)` does — so a bare `import { ScatterChart }` is inert
// until opted in.
//
//   import { use } from '@ziee/viz/core'
//   import { ScatterChart, ViolinChart } from '@ziee/viz/charts'
//   use([ScatterChart, ViolinChart])   // only these two register
//
// The chart Views themselves (the deck-backed rendering surface) are also re-exported here for a
// caller that renders a View directly.

// ── installers ───────────────────────────────────────────────────────────────────────────
// NOTE `installBuiltinSchemas` (the render-free half — same types, same binding schemas, no
// Views) is deliberately NOT re-exported here: this subpath's whole purpose is to deliver the
// chart Views, so importing it from here would pull exactly what that function exists to avoid.
// It lives on `@ziee/viz/core` (and the main barrel).
export {
  installBuiltins,
  AllCharts,
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
} from './viz-core/charts/installBuiltins'

// ── chart Views (deck-backed) ──────────────────────────────────────────────────────────────
export { ViolinView } from './viz-core/charts/ViolinView'
export { BoxView } from './viz-core/charts/BoxView'
export { BarView } from './viz-core/charts/BarView'
export { HistogramView } from './viz-core/charts/HistogramView'
export { DotplotView } from './viz-core/charts/DotplotView'
export { HeatmapView } from './viz-core/charts/HeatmapView'
export { VolcanoView } from './viz-core/charts/VolcanoView'
export { DeckScatterCanvas } from './viz-core/DeckScatterCanvas'
