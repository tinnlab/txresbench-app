// Shared shell vocabulary (P6). The dock areas + the per-project layout shape the
// WorkbenchLayout store persists. Kept tiny + dependency-free so every shell file can
// import it without cycles.
//
// ITEM-55/56: `center` is now a first-class dock area (the canvas is a registered
// `center`-area `ViewContribution` placed by `placeViews('center')`), so `DockArea`
// carries all four areas — extensions contribute panes/tabs into ANY area.
// ITEM-59: the per-project viz state (`colorBy`/`activeProjection`/`plotType`/`plotLayout`)
// moved OFF this layout model into the extension-owned viz store
// (`builtins/viz-canvas/vizState.store.ts`); `ProjectLayout` now holds ONLY the
// dock chrome (per-area collapsed/size + the active tab per area).

/** The four dock areas. `center` (the canvas hero) is now a placed area too. */
export type DockArea = 'left' | 'right' | 'bottom' | 'center'
export const DOCK_AREAS: readonly DockArea[] = ['left', 'right', 'bottom', 'center'] as const

/** Per-dock UI state. `size` is a PERCENTAGE (0–100) of the enclosing resizable
 *  group along the dock's variable axis (react-resizable-panels is percentage-based:
 *  width for L/R, height for bottom); `collapsed` swaps the region for a labeled
 *  stripe. Keyed by stable `area`, never per-tab id, so contribution churn can't
 *  force a reset. */
export interface DockState {
  collapsed: boolean
  size: number
}

/** The canvas plot-type control VALUE — a chart-type id resolved against viz's
 *  chart-type registry (`chartTypes()`), NOT a closed union (ITEM-56). */
export type PlotType = string

/** Single hero vs linked small-multiples (a canvas layout MODE). Driven by the
 *  layout-options registry (`shell/registryTail.ts`) rather than a hardcoded list. */
export type PlotLayout = 'single' | 'split'

/** The persisted per-project layout — dock chrome ONLY (ITEM-59 moved the viz state
 *  out). Sizes key by stable `area`, never per-tab id, so a contribution churn can't
 *  force a reset (a plan risk). */
export interface ProjectLayout {
  left: DockState
  right: DockState
  bottom: DockState
  center: DockState
  /** the active tab id per dock area (which contributed view is foremost). */
  activeTab: Partial<Record<DockArea, string>>
}

/** IA defaults (WORKBENCH_IA §5/§6): left + bottom + right all OPEN, canvas maximal
 *  by default sizes. Named struct (not inline magic) per DEC-14 so it's promotable to
 *  a per-user pref later. */
export const WORKBENCH_LAYOUT_DEFAULTS = {
  /** default panel sizes as PERCENTAGES of their resizable group. */
  leftSize: 18,
  rightSize: 20,
  bottomSize: 30,
  centerSize: 62,
  /** react-resizable-panels min percentages for the outer/inner groups. */
  minPct: { left: 12, right: 12, center: 30, bottom: 12 },
} as const

export function defaultProjectLayout(): ProjectLayout {
  return {
    left: { collapsed: false, size: WORKBENCH_LAYOUT_DEFAULTS.leftSize },
    right: { collapsed: false, size: WORKBENCH_LAYOUT_DEFAULTS.rightSize },
    bottom: { collapsed: false, size: WORKBENCH_LAYOUT_DEFAULTS.bottomSize },
    center: { collapsed: false, size: WORKBENCH_LAYOUT_DEFAULTS.centerSize },
    activeTab: {},
  }
}
