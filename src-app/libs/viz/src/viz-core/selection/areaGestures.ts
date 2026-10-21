// areaGestures.ts — the PURE, host-agnostic core of the 2D-area selection interaction.
//
// Extracted from SelectableScatter (which was the ONLY surface with a persistent committed outline +
// drag-to-move) so the grid / spatial-ROI / violin-lasso surfaces share ONE implementation instead of
// hand-rolling their own draft/commit/outline/move lifecycle. Everything here is pure logic — no
// deck.gl / react import (only `d3-polygon` + the dependency-free `pointIndex` / `data/selection`) —
// so it is directly unit-testable in node, exactly like `SelectionController.ts`.
//
// The single per-HOST difference is an `unproject(clientX,clientY) → [x,y] | null` adapter (lives in
// the React hook, `useAreaSelection.tsx`); everything in THIS file is world-space + framework-free.

import { polygonContains } from 'd3-polygon'
import { IndexMask } from '../data/selection'
import { areaMask, type Area, type CombineMode } from './SelectionController'
import { polygonCandidates, type PointIndex } from '../spatial/pointIndex'
import { shortLabelFor, toolKeysForSurface, type ToolKeyFor } from '../tools/vocabulary'

export type Vec2 = [number, number]

// ── shared tool + mode vocabulary — DERIVED from the one registry (INV-14) ──────────────────────
// This block used to DECLARE the vocabulary and call itself "one definition, consumed by every
// host" — but `VizToolRail` never imported it, and four further restatements grew up alongside it.
// The declaration now lives in `tools/vocabulary.ts`; what remains here are derivations, kept so
// `SelectableScatter` and the progressive story compile unchanged.
// `vocabulary.ts` is pure DATA (no react, no lucide, no deck), so this module's documented purity
// is preserved — icons live in `tools/registry.ts`, which only UI surfaces import.
export type SelectionTool = 'pan' | ToolKeyFor<'select'>
export const SELECTION_TOOLS: readonly SelectionTool[] = ['pan', ...toolKeysForSurface('select')]
export const COMBINE_MODES: readonly CombineMode[] = ['add', 'subtract', 'intersect']
export type { CombineMode }

/** A rendered outline: a committed area (`role:'area'`) or an in-progress gesture (`role:'draft'`). */
export interface OverlayShape {
  polygon: Vec2[]
  role: 'area' | 'draft'
}

/** BUTTON-TEXT labels for the tool buttons — derived from the registry so every host reads the same.
 *  `pan` is the camera mode (surface `view`); the rest are the `select` surface's tools.
 *
 *  BLIND-AUDIT M15: this uses `shortLabelFor`, NOT `labelFor`. Its consumers (`SelectableScatter`'s
 *  `sel-tool-*` strip, the progressive-data story) render the value INSIDE the button, and `label` is
 *  tooltip prose — deriving from it printed "Pan + zoom (scroll to zoom, hold Space or drag to pan)"
 *  into a button and blew it out to 499px. */
export const SELECTION_TOOL_LABEL: Record<SelectionTool, string> = Object.fromEntries(
  SELECTION_TOOLS.map(t => [t, t === 'pan' ? shortLabelFor('view', 'pan') : shortLabelFor('select', t)]),
) as Record<SelectionTool, string>

// ── shared outline styling (ITEM-7 / DEC-4: byte-identical to SelectableScatter's original) ──────
export interface OutlineStyle {
  lineColor: readonly [number, number, number, number]
  lineWidth: number
  fillColor: readonly [number, number, number, number]
}

/**
 * The committed area gets a SUBTLE border (low alpha, thin); the in-progress draft stays
 * brighter/thicker so the active gesture reads clearly. This is the single source of the
 * persistent-committed-outline look shared by every migrated surface.
 */
export function outlineStyle(role: 'area' | 'draft'): OutlineStyle {
  return role === 'draft'
    ? { lineColor: [56, 132, 255, 220], lineWidth: 1.5, fillColor: [56, 132, 255, 30] }
    : { lineColor: [56, 132, 255, 110], lineWidth: 1, fillColor: [56, 132, 255, 18] }
}

/** The four CCW corners of an axis-aligned box, from any corner pair. */
export function boxCorners(box: readonly [number, number, number, number]): Vec2[] {
  const [ax, ay, bx, by] = box
  const x0 = Math.min(ax, bx)
  const x1 = Math.max(ax, bx)
  const y0 = Math.min(ay, by)
  const y1 = Math.max(ay, by)
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

/** Fold a per-area mask into a running mask with the area's combine op (mirrors the controller). */
export function combineMask(base: IndexMask, add: IndexMask, mode: CombineMode): IndexMask {
  return mode === 'add' ? base.union(add) : mode === 'subtract' ? base.difference(add) : base.intersect(add)
}

/** Translate a whole area (ring or box) by a world-space delta — no per-vertex editing. */
export function translateArea(area: Area, dx: number, dy: number): Area {
  if (area.kind === 'rect') {
    const [x0, y0, x1, y1] = area.box
    return { ...area, box: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] }
  }
  return { ...area, polygon: area.polygon.map(([x, y]) => [x + dx, y + dy] as const) }
}

/** Is world point `p` inside a committed area? (rect = inclusive box, polygon = ring test). */
export function areaContainsPoint(area: Area, p: Vec2): boolean {
  if (area.kind === 'rect') {
    const [ax, ay, bx, by] = area.box
    const x0 = Math.min(ax, bx)
    const x1 = Math.max(ax, bx)
    const y0 = Math.min(ay, by)
    const y1 = Math.max(ay, by)
    return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1
  }
  return polygonContains(area.polygon as [number, number][], p)
}

/**
 * The TOPMOST committed area (last drawn = on top) that contains `p`, or -1 when none does — the
 * Move-tool grab: a drag starts on the area under the cursor, honoring z-order.
 */
export function hitTestTopmostArea(areas: readonly Area[], p: Vec2): number {
  for (let i = areas.length - 1; i >= 0; i--) {
    if (areaContainsPoint(areas[i], p)) return i
  }
  return -1
}

/** Turn a committed area list into renderable `role:'area'` outlines (persistent after finish). */
export function controllerAreasToShapes(areas: readonly Area[]): OverlayShape[] {
  return areas.map(a =>
    a.kind === 'rect'
      ? { polygon: boxCorners(a.box), role: 'area' as const }
      : { polygon: a.polygon.map(v => [v[0], v[1]] as Vec2), role: 'area' as const },
  )
}

/**
 * All outlines to render: every committed area (`role:'area'`, PERSISTS after finish) plus the
 * in-progress rect/polygon draft (`role:'draft'`). The single builder every host feeds its outline
 * layer, so committed-border-persistence is identical everywhere.
 */
export function selectionShapes(
  committed: readonly Area[],
  rectDraft: { start: Vec2; end: Vec2 } | null,
  polyDraft: readonly Vec2[],
): OverlayShape[] {
  const shapes: OverlayShape[] = controllerAreasToShapes(committed)
  if (rectDraft) shapes.push({ polygon: boxCorners([...rectDraft.start, ...rectDraft.end]), role: 'draft' })
  if (polyDraft.length >= 2) shapes.push({ polygon: polyDraft.map(v => [v[0], v[1]] as Vec2), role: 'draft' })
  return shapes
}

/**
 * The narrowed candidate set for committing an area — the O(log N + k) spatial-index query the
 * controller's hit-test runs over (a rect range, or a polygon's bbox superset). Byte-identical to a
 * full-N scan since a point outside the bbox can never be inside the shape.
 */
export function commitCandidatesFor(area: Area, pointIndex: PointIndex): Uint32Array {
  if (area.kind === 'rect') {
    return pointIndex.range(
      Math.min(area.box[0], area.box[2]),
      Math.min(area.box[1], area.box[3]),
      Math.max(area.box[0], area.box[2]),
      Math.max(area.box[1], area.box[3]),
    )
  }
  return polygonCandidates(pointIndex, area.polygon as [number, number][])
}

/**
 * The REALTIME polygon-preview mask: the in-progress ring's membership (via `areaMask` narrowed by
 * `polygonCandidates`) folded onto the committed `base` mask with the current mode-op — so the lit
 * set updates as vertices drop, before Finish commits it. (BUG #10 seam, now shared.)
 */
export function previewMask(
  base: IndexMask,
  ring: readonly Vec2[],
  mode: CombineMode,
  positions: Float32Array,
  totalPoints: number,
  pointIndex: PointIndex,
): IndexMask {
  const poly = ring.map(v => [v[0], v[1]] as Vec2)
  const preview = areaMask(
    { kind: 'polygon', polygon: poly, mode },
    positions,
    totalPoints,
    polygonCandidates(pointIndex, poly),
  )
  return combineMask(base, preview, mode)
}
