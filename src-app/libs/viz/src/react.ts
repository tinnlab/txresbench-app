// @ziee/viz/react — the REACT-binding subpath (EXTENSIBILITY_STUDY Part 6 STEP 7): the
// declarative `<Viz option={...} />` component (wraps the STEP-6 `VizController`) plus the
// existing imperative `GridWorkspace` component + the pop-out surface. Importing this subpath
// pulls in the chart Views (via `GridWorkspace`, which `installBuiltins()` at module load), so
// it is the "batteries-included" React surface; `@ziee/viz/core` stays chart-free.

export { Viz } from './react/Viz'
export type { VizProps } from './react/Viz'

export { GridWorkspace } from './viz-core/grid/GridWorkspace'
export { ExportDialog } from './viz-core/export/ExportDialog'
export { AxisDataZoom } from './viz-core/charts/AxisDataZoom'

// ── pop-out (portal-move: each cell pops into a real window via useWindowPortal) ─────────
export { useCellPopout } from './adapter/useCellPopout'
