// chartSelectionMode.ts — the GLOBAL chart selection mode threaded from the viz tool RAIL to each
// producer chart (violin), so a chart's brush/lasso is driven by the SAME left-rail Select/Pan/Zoom +
// shape sub-tools as the dense scatter — instead of a per-plot mode toolbar. The rail's exclusive tool +
// shape are mapped here:
//   • Pan / Zoom tool     → 'pan'   (camera; no selection gesture)
//   • Select + Rectangle  → 'rect'  (a DRAG brush; a producer chart maps it to its native drag gesture —
//                                    e.g. the violin's value-band drag — since the rail rect is a drag)
//   • Select + Polygon    → 'lasso' (the violin's freeform CLICK-to-add-vertices point lasso)
//   • Select + Move       → 'move'  (drag a committed lasso)
// A `null` context value means there is NO grid rail (a standalone showcase story) — then the producer
// View falls back to its OWN mode toolbar (byte-identical to before this seam). Mirrors `PlotCellIdContext`.

import { createContext } from 'react'

/** The rail-driven producer-chart gesture intent. `'rect'` is the DRAG brush (rail Rectangle tool);
 *  a producer maps it to its native drag gesture (the violin → its value-band drag). `'lasso'` is the
 *  click-to-add-vertices polygon. */
export type ChartSelectMode = 'pan' | 'rect' | 'lasso' | 'move'

/** The rail-driven chart selection mode, or `null` when no grid rail provides one (standalone). */
export const ChartSelectModeContext = createContext<ChartSelectMode | null>(null)

/** The rail's single/multi selection toggle, threaded to producer charts so a violin publishes its
 *  selection with the SAME accumulate semantics as the dense scatter: multi ⇒ union across all plots,
 *  single ⇒ replace. `false` when no grid rail provides one (standalone). */
export const ChartSelectMultiContext = createContext<boolean>(false)
