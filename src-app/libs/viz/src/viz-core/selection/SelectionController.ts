// ============================================================================================
// SELECTION BEHAVIOR CONTRACT — the single source of truth for how selection works on EVERY plot.
// ============================================================================================
// DEFINING RULE: a producer plot's selection must behave IDENTICALLY regardless of plot type.
// Scatter↔violin must feel exactly like scatter↔scatter. Any divergence from the table below is a
// BUG (measured against this contract), never a per-plot-type "variant".
//
// Two producer surfaces implement this today; a third (box/bar/heatmap brush) must satisfy every
// row or it is incomplete:
//   • Dense scatter cells — grid/GridWorkspace.tsx (shared-deck marquee overlay + `committedByCell`).
//   • Violin              — charts/ViolinView.tsx (own ChartCanvas draw overlay + `committedRegions`).
//
// THE RAIL TOOLS (controls/VizToolRail.tsx), threaded to producers via TWO React contexts
// (charts/chartSelectionMode.ts): `ChartSelectModeContext` ('pan'|'rect'|'lasso'|'move') +
// `ChartSelectMultiContext` (single/multi bool). A null/false context = "no grid rail" (standalone
// story) → the plot falls back to its own local mode toolbar.
//   select · single|multiple · rectangle · polygon/lasso · move · finish · clear · pan
//
// THE BEHAVIOR TABLE — scatter and violin MUST match every row:
//   1. RECT = drag a box → select points/dots in the box (violin: spans groups, NOT one column).
//   2. POLYGON = click vertices → freeform ring, auto-previews live at ≥3 verts.
//   3. ENTER → finish the polygon (a fresh one starts next).
//   4. ESC → discard the in-progress polygon.
//   5. committed outline PERSISTS (world coords, tracks pan/zoom) via buildSelectionOutlineLayer.
//   6. HOVER a committed region ⇒ cursor 'move' (checked in EVERY mode — never behind an early
//      return; that omission was the scatter-vs-violin hover bug). grid selHoverMove / violin hoverMove.
//   7. GRAB-DRAG a committed region (any tool) → translate + re-hit-test + re-publish.
//   8. SINGLE ⇒ a new region REPLACES (one region total across ALL plots).
//   9. MULTIPLE ⇒ regions accumulate + union (within a plot AND across plots).
//  10. CROSS-PLOT HIGHLIGHT — a selection dims non-selected points EVERYWHERE (publish canonical
//      ids via setSelection; consume usePointSelection → dot highlight).
//  11. CLEAR ⇒ every outline + highlight gone.
//  12. PAN/ZOOM tool ⇒ no selection gesture.
//  13. RECT tool + SINGLE mode: a plain CLICK OUTSIDE any committed region CLEARS the selection
//      (click empty space to deselect). Multi mode / on a region ⇒ no clear (a region press = grab).
//  14. DRAG-OUT-TO-REMOVE: grab a committed region and release it OUTSIDE the plot border ⇒ that region
//      is deleted (the multi-region remove affordance). grid: release outside the cell rect; violin:
//      release outside the data bounds (plotBoundsRef).
//
// CROSS-PLOT SYNC — the per-origin UNION (adapter/Coordination.store.ts). Each producer publishes
// under its OWN origin id: setSelection(originId, ids, accumulate). accumulate=false (single) REPLACES
// (pointSelection = its ids); accumulate=true (multi) UNIONs every origin (pointSelection = the union).
// `pointSelection` is the ONE shared value all plots consume to highlight. The violin threads
// `accumulate` from ChartSelectMultiContext; the grid from its `selMulti` state.
//
// CROSS-CELL LIFECYCLE — the EXCLUSIVE-selection epoch (the parity glue). The two producers keep
// committed outlines in SEPARATE stores (committedByCell vs committedRegions), so Clear + single-mode
// replace must reconcile across the boundary. Coordination carries `exclusiveSelectionOrigin` (the
// sole owner, null after a Clear) + `exclusiveSelectionEpoch` (bumped on every EXCLUSIVE change —
// single-mode select OR Clear; multi NEVER bumps it). Each producer watches the epoch and drops any
// committed outline it no longer owns (grid keeps committedByCell[owner]; violin clears
// committedRegions when owner !== its selectionOriginId). THIS is what makes "single-select on the
// scatter clears the violin's outline" and "Clear wipes both" behave like scatter↔scatter.
//
// INVARIANTS FOR A NEW PRODUCER: read both contexts; store regions as Area[] (areaContainsPoint /
// translateArea / areaRing handle BOTH rect & polygon — never special-case one kind and forget the
// other, the historical bug source); publish via setSelection(originId, ids, accumulate=railMulti) +
// consume usePointSelection; render outlines via buildSelectionOutlineLayer(controllerAreasToShapes);
// hover-move in EVERY mode; Enter/Esc; accept selectionOriginId + run the exclusive-epoch reconcile;
// add a parity check to tests/e2e/plot-editing.e2e.mjs; AND EMIT PROVENANCE (ITEM-9/ITEM-19) — map
// every committed Area through `provenance.areaToOp` and publish the ordered op list beside the ids
// (`useAreaSelection`'s `onCommitOps`, or the grid's publish path). A producer that skips this makes
// its selections silently unexplainable and un-re-derivable, which INV-2 and INV-7 both rely on.
//
// PROVENANCE CONTRACT (ITEM-19): the ids are a CACHE of an ordered recipe, not the truth. `ops`
// records HOW a set was made (tool + world region + combine op + pane + identity space) and
// `context` records WHAT THE USER WAS LOOKING AT when they made it (filters / hidden / per-pane
// positions hashes). Per DEC-20 a CONTEXT change never changes the ids — the API reports every point
// in the region and the consumer partitions (`partitionSelection`); per DEC-22 a context-only change
// must therefore do ZERO containment work and keep the ids array's IDENTITY (INV-8).
// ============================================================================================
//
// SelectionController.ts — framework-agnostic multi-area selection controller (DEC-24).
// Holds an ordered list of drawn AREAS (each a rect or polygon + a combine mode) and the
// combined `IndexMask` they resolve to. Each area is turned into a per-area mask via the
// pure `selectInBox` / `selectInPolygon` hit-tests, then folded into the running mask with
// the packed-bitmask set-ops (add=union / subtract=difference / intersect=intersect) — the
// legacy Union/Intersection/Custom model as O(N/32) bitwise ops (DEC-24). Pure logic, no
// deck.gl / react import → directly unit-testable in node.

import {
  IndexMask,
  bboxCandidates,
  polygonBoundingBox,
  selectInBox,
  selectInPolygon,
} from '../data/selection'

export type CombineMode = 'add' | 'subtract' | 'intersect'

/** An axis-aligned rectangle area in WORLD space: [x0,y0,x1,y1] (corner order free). */
export interface RectArea {
  readonly kind: 'rect'
  readonly box: readonly [number, number, number, number]
  readonly mode: CombineMode
}

/** A polygon (lasso) area in WORLD space: an ordered ring of [x,y] vertices. */
export interface PolygonArea {
  readonly kind: 'polygon'
  readonly polygon: readonly (readonly [number, number])[]
  readonly mode: CombineMode
}

export type Area = RectArea | PolygonArea

export interface SelectionControllerOptions {
  /** interleaved xy Float32Array (world space), length totalPoints*2. */
  positions: Float32Array
  totalPoints: number
  /** fired whenever the combined mask changes (applyArea / clear / undo). */
  onChange?: (mask: IndexMask) => void
}

/**
 * Compute the per-area membership mask for a single area, WITHOUT scanning all N
 * against the polygon. The expensive `polygonContains` test is confined to the
 * drawn shape's bounding box:
 *
 * - `candidates` (when supplied by the caller — e.g. a deck.gl `pickObjects(bbox)`
 *   region pick from `SelectableScatter`) is used verbatim: the point test runs on
 *   exactly O(candidates), never O(N).
 * - Otherwise a polygon area falls back to the exact bbox pre-filter
 *   (`bboxCandidates` over the polygon's bounding box), so `polygonContains` runs
 *   only on points inside the bbox — a point outside the bbox can't be inside the
 *   polygon, so the mask is byte-identical to a full-N scan (the CPU parity oracle).
 *   A rect area is already an O(N) scalar compare, so it just forwards candidates.
 */
/** ITEM-22 — the containment-pass counter INV-8 is measured with.
 *
 *  `areaMask` is the SINGLE chokepoint every geometric hit-test routes through: both producers
 *  (`GridWorkspace.publishCellAreas` after ITEM-4, `SelectionController.recompute()`) and the
 *  re-derivation engine (`selection/provenance.ts::deriveSelection`). Counting HERE counts every
 *  containment pass in the system without instrumenting three call sites — and, more importantly,
 *  without a FUTURE producer being able to add a fourth the counter silently misses.
 *
 *  Why a counter at all: INV-8 says a CONTEXT-only change performs ZERO containment tests. That is
 *  unfalsifiable from outside, because the defect it guards — running the full geometry on every
 *  filter tick — returns the byte-identical CORRECT ids and passes every value assertion. The
 *  counter is what turns "we don't do the work" from an optimization claim into a checkable
 *  property (TEST-24).
 *
 *  Module-level and ALWAYS incremented: a DEV-only guard here would make the count depend on build
 *  mode, and the seam that EXPOSES it (`window.__VIZ_PROV__`) carries the DEV gate instead. */
let containmentPasses = 0

/** Read the monotonic containment-pass count (ITEM-22). Surfaced via `window.__VIZ_PROV__`. */
export function containmentPassCount(): number {
  return containmentPasses
}

export function areaMask(
  area: Area,
  positions: Float32Array,
  totalPoints: number,
  candidates?: Iterable<number>,
): IndexMask {
  containmentPasses++
  if (area.kind === 'rect') {
    return selectInBox(positions, area.box, totalPoints, candidates)
  }
  const cands =
    candidates ?? bboxCandidates(positions, totalPoints, polygonBoundingBox(area.polygon))
  return selectInPolygon(positions, area.polygon as [number, number][], totalPoints, cands)
}

/** An area plus the (optional) caller-supplied candidate set that narrowed it. */
interface AreaEntry {
  readonly area: Area
  /** Cached region-pick candidates (materialised so recompute/undo can reuse them). */
  readonly candidates?: readonly number[]
}

export class SelectionController {
  private positions: Float32Array
  private totalPoints: number
  private readonly entries: AreaEntry[] = []
  private mask: IndexMask
  onChange?: (mask: IndexMask) => void

  constructor(opts: SelectionControllerOptions) {
    this.positions = opts.positions
    this.totalPoints = opts.totalPoints
    this.onChange = opts.onChange
    this.mask = new IndexMask(this.totalPoints)
  }

  /** The current combined selection mask (live reference; treat as read-only). */
  get selection(): IndexMask {
    return this.mask
  }

  /** Number of currently-selected points. */
  get count(): number {
    return this.mask.count()
  }

  /** The ordered list of drawn areas. */
  areasList(): readonly Area[] {
    return this.entries.map(e => e.area)
  }

  /**
   * Add a drawn area and recompute the combined mask. `positions` / `totalPoints`
   * default to the controller's own (the prompt's applyArea(area, positions, totalPoints)
   * form is supported by passing them explicitly). `candidates` is an optional
   * pre-narrowed index set (e.g. a deck.gl `pickObjects(bbox)` region pick) that
   * confines the polygon test to O(candidates) instead of O(N); it is cached so
   * `undo`/recompute reuse it. Returns the new combined mask.
   */
  applyArea(
    area: Area,
    positions: Float32Array = this.positions,
    totalPoints: number = this.totalPoints,
    candidates?: Iterable<number>,
  ): IndexMask {
    this.positions = positions
    this.totalPoints = totalPoints
    this.entries.push({
      area,
      candidates: candidates ? Array.from(candidates) : undefined,
    })
    return this.recompute()
  }

  /**
   * Replace the geometry of the area at `index` (e.g. a drag-to-move that translates
   * the whole ring/box) and recompute the combined mask. The entry's CACHED region-pick
   * candidates are DROPPED — they described the OLD geometry, so keeping them would
   * hit-test the moved shape against a stale candidate set. Recompute then re-narrows
   * via `areaMask`'s bbox pre-filter (byte-identical to a full-N scan). Out-of-range
   * `index` is a no-op. Returns the new combined mask.
   */
  updateArea(index: number, newArea: Area): IndexMask {
    const entry = this.entries[index]
    if (!entry) return this.mask
    this.entries[index] = { area: newArea }
    return this.recompute()
  }

  /** Remove the most-recently-added area and recompute. */
  undo(): IndexMask {
    this.entries.pop()
    return this.recompute()
  }

  /** Drop all areas and the mask. */
  clear(): void {
    this.entries.length = 0
    this.mask = new IndexMask(this.totalPoints)
    this.onChange?.(this.mask)
  }

  /** Fold every area (in order) into a fresh combined mask via the bitmask set-ops. */
  private recompute(): IndexMask {
    let out = new IndexMask(this.totalPoints)
    for (const { area, candidates } of this.entries) {
      const m = areaMask(area, this.positions, this.totalPoints, candidates)
      switch (area.mode) {
        case 'add':
          out = out.union(m)
          break
        case 'subtract':
          out = out.difference(m)
          break
        case 'intersect':
          out = out.intersect(m)
          break
      }
    }
    this.mask = out
    this.onChange?.(out)
    return out
  }
}
