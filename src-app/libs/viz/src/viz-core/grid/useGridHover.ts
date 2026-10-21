// useGridHover.ts — SPLIT S (ITEM-35): the grid's HOVER / TOOLTIP-FIELD plane.
//
// DEC-26's "hover sink / tooltip fields" row (43) moved verbatim out of `GridWorkspace`, together with
// the CROSS-PLOT HIGHLIGHT state the sink writes — which the census row did not name but which cannot
// stay behind it: `onHoverPublish` is the sole writer of both `hoveredCellId` and `crossHighlight`, so
// a cut between the sink and the state puts a setter on one side of a module boundary and the only
// thing that calls it on the other. `sameHighlight` (a module-level helper of the shell) came too — it
// had exactly one reader, that same setter.
//
// What it owns: the deck hover SINK (`deckHoverRef` + the stable `deckHoverSink` wrapper), the hovered
// dense cell, the cross-plot highlight map + its equality guard, the chart-side hover twin
// (`chartHover` / `publishChartHover`), and the `tooltipFields` derivation.
//
// WHAT IS NOT HERE, and why. `hovered` itself, its rAF throttle, `onDeckHover`, `hoveredFields` and
// the main `<VizTooltip>` are NOT in this plane and never were — SPLIT B (ITEM-16) put them in
// `GridOverlayLayer`, on purpose: they are PER-FRAME values, and this decomposition's whole point is
// that a cursor moving within one point must not re-render anything above the overlay. What this plane
// holds is the narrow surface that survives that split — a ref the overlay fills, a publish callback
// it calls once per POINT change (not per frame), and the results the deck and pane layers read. Do
// not "reunite" the per-frame half into this plane; that would undo Split B and TEST-P1/P5 measure it.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a tenth time), and DEC-27's test is passed rather than
// dodged: `crossHighlight`, `hoveredCellId` and `chartHover` are ALREADY `useState`, so nothing is
// PROMOTED to state by this move; `tooltipFields` is already a `useMemo`. A store here would add a
// subscription without removing a render, on the one path a hover traverses.
//
// Writer-set completeness (HAZARD 1), per moved symbol — the method, and its limit:
//   `crossHighlight`     ONE writer, `setCrossHighlight`, inside `onHoverPublish`, which moves. The
//                        setter is NOT returned, so no other module can write it. Lexical; `tsc`
//                        complete. `effectiveHighlight` is a plain alias and is what callers read.
//   `hoveredCellId`      same: one writer, in `onHoverPublish`; `setHoveredCellId` not returned.
//   `chartHover`         one writer, `publishChartHover`, which moves and IS returned (the pane layer
//                        and the data table both call it — two PROP consumers, so `tsc` sees them).
//   `deckHoverRef`       a cross-LAYER ref: declared here, returned unchanged, and FILLED by
//                        `GridOverlayLayer` through its `deckHoverRef` prop while `GridDeckLayer` calls
//                        it through `deckHoverSink`. Re-passed, never re-declared (DEC-28's rule, fifth
//                        application) — a plane that hoisted it behind a subscription would break the
//                        identity two sibling layers depend on.
//   `sameHighlight`      module-level, one reader (the setter above). Moved, not copied — the shell's
//                        copy is DELETED, so there is exactly one equality semantics, which is what
//                        `hoverHighlightLayers` and the deck layer's `crossTooltips` memo depend on.
//   `tooltipContext` / `tooltipLabels`
//                        PROPS of the shell. Passed in; the shell still owns its public API.
//
// NO DEV WINDOW SEAM is installed from this module. Checked by grep over `__viz*`, not assumed.
import { useCallback, useMemo, useRef, useState } from 'react'
import { buildScatterTooltipFields, type TooltipCatalogLabels, type TooltipContext } from '../tooltip/tooltipModel'
import type { DeckHoverInfo } from './gridModel'

/** Shallow value-equality of two `cellId → rowIndex` highlight maps (the cross-plot hover channel). Used
 *  to skip a per-frame state update when the hovered point (hence the highlighted rows) is unchanged. */
function sameHighlight(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

export interface GridHoverInputs {
  readonly tooltipContext: TooltipContext | undefined
  readonly tooltipLabels: TooltipCatalogLabels | undefined
}

export function useGridHover({ tooltipContext, tooltipLabels }: GridHoverInputs) {
  // HOVER→HIGHLIGHT channel: per-cell the ORIGINAL point index a data-table row is hovering (or absent).
  // A dense cell renders a highlight ring at that index via `hoverHighlightLayers`; grouped chart Views
  // read it through `HoverHighlightContext` to emphasise the matching raw dot.
  // CROSS-PLOT hover: when a point is hovered in one cell (a plot dot OR a data-table row), the SAME row
  // is highlighted in every cell of the same dataset (rings + chart emphasis + tooltips). Filled by
  // `onHoverPublish` below; the data table feeds it via `publishChartHover`.
  const [crossHighlight, setCrossHighlight] = useState<Record<string, number>>({})
  const effectiveHighlight = crossHighlight
  // A CHART cell publishes the raw dot it's hovering here (box/violin) — the chart-side twin of the dense
  // `hovered`. Feeds the SAME cross-plot highlight effect so hovering a violin dot lights the scatters too.
  const [chartHover, setChartHover] = useState<{ cellId: string; index: number } | null>(null)
  const publishChartHover = useCallback((cellId: string, index: number | null) => {
    setChartHover(prev => {
      if (index == null) return prev?.cellId === cellId ? null : prev
      return prev?.cellId === cellId && prev.index === index ? prev : { cellId, index }
    })
  }, [])

  // ── Hover (SPLIT B — ITEM-16) ─────────────────────────────────────────────
  // `hovered`, its rAF throttle, `onDeckHover`, `hoveredFields`, the main `<VizTooltip>` AND the
  // cross-plot highlight derivation all moved into `GridOverlayLayer`.
  //
  // Moving `hovered` alone would have been theatre: the shell derived the cross-plot highlight
  // map from it (`hoverHighlightLayers` → deck; `HoverHighlightContext` → chart cells), so a hover
  // would still have re-rendered it once per frame, plus a hop. The DERIVATION therefore moved
  // with the state, and what comes back up is only its result — through `onHoverPublish`, guarded by
  // the same `sameHighlight` equality test the pre-split effect used. Net effect: cursor jitter within
  // one point no longer re-renders anything above the overlay, and a genuine point change re-renders
  // ONCE instead of twice.
  const deckHoverRef = useRef<((info: DeckHoverInfo) => void) | null>(null)
  /** The sink handed to `<GridDeckLayer>`. Deck's `onHover` owner is the overlay layer, which is
   *  deck's SIBLING, so it cannot be passed across directly; this stable wrapper forwards through the
   *  ref and keeps `GridDeckLayer`'s `memo` intact. */
  const deckHoverSink = useCallback((info: DeckHoverInfo) => {
    deckHoverRef.current?.(info)
  }, [])
  /** The hovered dense cell. Its ONLY consumer is `<GridDeckLayer>`, which skips the source
   *  cell's cross tooltip because the overlay layer already shows the main one for it. */
  const [hoveredCellId, setHoveredCellId] = useState<string | null>(null)
  const onHoverPublish = useCallback((cellId: string | null, highlight: Record<string, number>) => {
    setHoveredCellId(prev => (prev === cellId ? prev : cellId))
    // Equality guard, lifted VERBATIM from the pre-split effect: hovering WITHIN one point (cursor
    // jitter → a new `hovered` object, the SAME indices) must NOT churn the highlight map, or the ring
    // layers + cross-tooltips rebuild every frame for nothing. It lives on THIS setter so the identity
    // semantics `hoverHighlightLayers` and the deck layer's `crossTooltips` memo depend on are
    // byte-identical to before the split.
    setCrossHighlight(prev => (sameHighlight(prev, highlight) ? prev : highlight))
  }, [])

  const tooltipFields = useMemo(() => {
    if (!tooltipContext) return null
    // Surface every RESIDENT extra column (`columns`) as its own tooltip row (e.g. the color-by value),
    // after the default group / x / y — each accessor reads ONE index (O(1), no fetch on hover).
    const extra = tooltipContext.columns
      ? Object.entries(tooltipContext.columns).map(([key, col]) => ({
          key,
          label: key,
          accessor: (i: number) => (Number.isFinite(col[i]) ? (col[i] as number) : null),
        }))
      : []
    return buildScatterTooltipFields(tooltipContext, tooltipLabels, extra)
  }, [tooltipContext, tooltipLabels])
  // (SPLIT B: `hoveredFields` — the per-hovered-cell tooltip-field resolution — moved to
  //  `GridOverlayLayer` with `hovered`. `tooltipFields` above did NOT: it is not a per-frame value and
  //  `GridDeckLayer`, a sibling, consumes it too, so it belongs on this side of that boundary.)

  // (SPLIT A: the CROSS-PLOT tooltip memo AND its `<VizTooltip>`s moved to `GridDeckLayer`. They
  //  PROJECT a highlighted point through each cell's live camera, so they recompute per frame —
  //  leaving them above would have re-rendered the whole shell on every camera frame, which is
  //  the exact cost Split A removes. Split B (ITEM-16) owns the tooltip surface and reunites them
  //  with the main hover tooltip.)

  return {
    effectiveHighlight,
    chartHover,
    publishChartHover,
    deckHoverRef,
    deckHoverSink,
    hoveredCellId,
    onHoverPublish,
    tooltipFields,
  }
}
