// capabilityGates.ts — the PURE enforcement of the declarative chart CAPABILITIES
// (viz-followups Area B, ITEM-5/6). `ChartCapabilities` (registry/types.ts) declares whether a
// chart CONSUMES the shared selection, PRODUCES one, which dataZoom axes it honors, and whether it
// may join the linked color scale; `parseOption` stamps the effective value onto the `GridCell`
// and `CellView.ChartBody` threads it onto the uniform `ChartViewProps`. THESE helpers are the
// single decision point each built-in View calls to honor that flag, so the enforcement is:
//   • ONE place (no per-View re-implementation to drift), and
//   • unit-testable in node (no React / deck / DOM), which is why the gate is a pure function
//     rather than an inline ternary — the Views import + call it, so the test covers the real path.
//
// The DEFAULT (a flag left `undefined` — the descriptor + series both silent) is byte-identical to
// today: only an explicit `false` (consume/produce) or an axis-restricting `dataZoomAxes` changes
// behavior.

import type { GroupEmphasis } from '../coordination/selectionSync'
import type { DataZoomConfig } from './AxisDataZoom'

/** The "no selection" group emphasis: `active:false` ⇒ `markOpacity` returns 1 for every mark, so
 *  NOTHING dims. Returned by `gateGroupEmphasis` when a View is gated out of consuming. Frozen +
 *  shared so a non-consuming View has a stable, allocation-free result. */
export const INACTIVE_GROUP_EMPHASIS: GroupEmphasis = Object.freeze({
  selectedCodes: new Set<number>(),
  active: false,
})

/**
 * ITEM-5 CONSUME gate for a group-emphasis reader (bar / box / dotplot / violin). When
 * `consumesSelection` is an explicit `false` the shared emphasis is DISCARDED (the INACTIVE result
 * never dims / highlights); `undefined` / `true` pass the real emphasis through (byte-identical).
 */
export function gateGroupEmphasis(
  raw: GroupEmphasis,
  consumesSelection: boolean | undefined,
): GroupEmphasis {
  return consumesSelection === false ? INACTIVE_GROUP_EMPHASIS : raw
}

/**
 * ITEM-5 CONSUME gate for a raw point-selection reader (heatmap row-band, violin per-dot mask).
 * `consumesSelection === false` ⇒ `null` (reads downstream as "no selection" ⇒ no highlight);
 * `undefined` / `true` ⇒ the real selection (byte-identical).
 */
export function gatePointSelection<T>(
  raw: T | null,
  consumesSelection: boolean | undefined,
): T | null {
  return consumesSelection === false ? null : raw
}

/**
 * ITEM-5 PRODUCE gate: a View exposes its brush / lasso / band gesture ONLY when a producer sink is
 * wired (`hasSink`) AND `producesSelection` is not an explicit `false`. `undefined` / `true` ⇒ the
 * sink alone decides (byte-identical: no sink ⇒ still no gesture).
 */
export function producesEnabled(
  hasSink: boolean,
  producesSelection: boolean | undefined,
): boolean {
  return hasSink && producesSelection !== false
}

/**
 * ITEM-6 dataZoom gate for a VALUE-axis (y-only) View (bar / box / violin). A declared
 * `dataZoomAxes` that omits `'y'` (e.g. `[]`) disables the value zoom; `undefined` / any set
 * including `'y'` ⇒ the config passes through unchanged.
 */
export function gateValueDataZoom(
  dataZoom: false | DataZoomConfig | undefined,
  dataZoomAxes: readonly ('x' | 'y')[] | undefined,
): false | DataZoomConfig | undefined {
  const allowed = !dataZoomAxes || dataZoomAxes.includes('y')
  return allowed ? dataZoom : false
}

/**
 * ITEM-6 dataZoom gate for a MATRIX (x+y) View (heatmap / dotplot). An EMPTY declared `dataZoomAxes`
 * disables the matrix zoom; `undefined` / any axis declared ⇒ the config passes through (the
 * descriptor default is `['x','y']`, so built-ins are byte-identical).
 */
export function gateMatrixDataZoom(
  dataZoom: false | DataZoomConfig | undefined,
  dataZoomAxes: readonly ('x' | 'y')[] | undefined,
): false | DataZoomConfig | undefined {
  return dataZoomAxes && dataZoomAxes.length === 0 ? false : dataZoom
}
