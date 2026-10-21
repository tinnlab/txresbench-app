// gridSelection.ts — PURE screen→world hit-testing for the grid's selection tool
// (ITEM-25 producer). The grid is ONE `<DeckGL>` hosting N `OrthographicView`s over
// the dense cells, so a selection drawn on screen must be (a) attributed to the CELL
// whose viewport it falls in, then (b) unprojected through THAT cell's viewport
// (rect + view state) into WORLD coords, where `selectInBox` / `selectInPolygon`
// (data/selection.ts) narrow the point test by bounding box — hit-tested ONCE on
// completion, never a per-mouse-move O(N) loop.
//
// deck.gl-only (no React, no DOM, no @ziee/*), so the math is unit-testable in node:
// `OrthographicView.makeViewport` is pure matrix math (no GL context needed), exactly
// like `multiView.ts`. An offset-less view of the cell's pixel size is fed
// container-local coords MINUS the cell's rect origin (mirrors SelectableScatter's
// `vp.unproject([clientX - rect.left, …])`, generalised to a per-cell rect offset).

import { OrthographicView } from '@deck.gl/core'
import type { PaneRect } from '../layers/multiView'
import type { PointIndex } from '../spatial/pointIndex'
import {
  IndexMask,
  bboxCandidates,
  polygonBoundingBox,
  selectInBox,
  selectInPolygon,
} from '../data/selection'

/** The minimal view-state a cell viewport needs (deck `target:[x,y(,z)]`, `zoom`). `zoom` may be a
 *  per-axis `[zx,zy]` (chart cells) — deck's `makeViewport` accepts either, so unproject/rect-select
 *  work unchanged for both dense and chart cells. */
export interface CellViewStateLike {
  readonly target: readonly number[]
  readonly zoom: number | [number, number]
}

/** A container-local screen point (px from the workspace's top-left corner). */
export type ScreenPoint = readonly [number, number]

// One reusable offset-less orthographic view — `makeViewport` is pure, so a single
// instance serves every cell (we pass the cell's pixel size + view state per call).
const ORTHO = new OrthographicView({ flipY: false })

/**
 * The dense cell whose pixel rect contains the container-local screen point, or
 * `null` when the point is in no dense cell (a gap / a chart cell). First match wins;
 * dense rects don't overlap.
 */
export function cellAtPoint(
  rects: readonly PaneRect[],
  x: number,
  y: number,
): string | null {
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return r.id
  }
  return null
}

/**
 * Build a cell's orthographic viewport (pure matrix math, no GL context) at a given pixel size + view
 * state — the SAME transform `unprojectInCell` uses for hit-testing, exposed so a caller can PROJECT
 * world→screen (`vp.project([x,y])`) for many points against one reused viewport (vector export). The
 * returned viewport's pixel origin is the cell's top-left (0,0), so projected coords are cell-local.
 * `null` on a degenerate (zero-size) size.
 */
export function makeCellViewport(width: number, height: number, viewState: CellViewStateLike) {
  if (width <= 0 || height <= 0) return null
  return ORTHO.makeViewport({
    width,
    height,
    viewState: {
      target: [viewState.target[0] ?? 0, viewState.target[1] ?? 0, 0],
      zoom: viewState.zoom,
    },
  })
}

/**
 * Unproject a container-local screen point to WORLD coords through a cell's viewport.
 * Builds a viewport of the cell's pixel size at the cell's view state, then unprojects
 * the point relative to the cell's own top-left (screen − rect origin). `null` on a
 * degenerate (zero-size) rect.
 */
export function unprojectInCell(
  rect: PaneRect,
  viewState: CellViewStateLike,
  x: number,
  y: number,
): [number, number] | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const vp = ORTHO.makeViewport({
    width: rect.width,
    height: rect.height,
    viewState: {
      target: [viewState.target[0] ?? 0, viewState.target[1] ?? 0, 0],
      zoom: viewState.zoom,
    },
  })
  if (!vp) return null
  const world = vp.unproject([x - rect.x, y - rect.y])
  return [world[0], world[1]]
}

/**
 * The VISIBLE world region of a cell (full-res image px, `[minX,minY,maxX,maxY]`) at a given pixel
 * size + view state — the four screen corners of the cell rect unprojected through its viewport, then
 * min/max'd (so a `flipY` axis order is handled by taking extremes, not corner identity). Feeds the
 * annotation overlay's `viewport` cull (`buildAnnotationLayers`) so a large committed collection only
 * tessellates the features inside the camera window. `null` on a degenerate (zero-size) rect.
 */
export function cellVisibleWorldBounds(
  rect: PaneRect,
  viewState: CellViewStateLike,
): [number, number, number, number] | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const vp = ORTHO.makeViewport({
    width: rect.width,
    height: rect.height,
    viewState: {
      target: [viewState.target[0] ?? 0, viewState.target[1] ?? 0, 0],
      zoom: viewState.zoom,
    },
  })
  if (!vp) return null
  // Unproject relative to the cell's OWN top-left (0,0) — the viewport is offset-less (see `ORTHO`).
  const corners: [number, number][] = [
    [0, 0],
    [rect.width, 0],
    [0, rect.height],
    [rect.width, rect.height],
  ]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [cx, cy] of corners) {
    const w = vp.unproject([cx, cy])
    if (w[0] < minX) minX = w[0]
    if (w[0] > maxX) maxX = w[0]
    if (w[1] < minY) minY = w[1]
    if (w[1] > maxY) maxY = w[1]
  }
  return [minX, minY, maxX, maxY]
}

/**
 * Hit-test a rectangle (two container-local screen corners) in a cell → the selected
 * point mask. Unprojects both corners through the cell's viewport, then `selectInBox`
 * (which orders the corners itself). A prebuilt `index` (built ONCE from `positions` by
 * the caller, memoized on positions change) turns the box selection into an
 * O(log N + k) KD-tree range query instead of the O(N) scalar-compare scan.
 */
export function selectRectInCell(
  rect: PaneRect,
  viewState: CellViewStateLike,
  positions: Float32Array,
  totalPoints: number,
  a: ScreenPoint,
  b: ScreenPoint,
  index?: PointIndex,
): IndexMask {
  const w0 = unprojectInCell(rect, viewState, a[0], a[1])
  const w1 = unprojectInCell(rect, viewState, b[0], b[1])
  if (!w0 || !w1) return new IndexMask(totalPoints)
  return selectInBox(positions, [w0[0], w0[1], w1[0], w1[1]], totalPoints, undefined, index)
}

/**
 * Hit-test a polygon (container-local screen vertices) in a cell → the selected point
 * mask. Unprojects every vertex through the cell's viewport, then `selectInPolygon`
 * narrowed to the polygon's world bounding box, so the expensive point-in-polygon test
 * runs only on points inside the lasso's bbox. A prebuilt `index` (built ONCE from
 * `positions` by the caller, memoized on positions change) supplies those bbox
 * candidates via an O(log N + k) range query, REPLACING the O(N) `bboxCandidates`
 * coordinate scan; without an index it falls back to that scan (byte-identical result
 * either way). Fewer than 3 vertices ⇒ an empty mask.
 */
export function selectPolygonInCell(
  rect: PaneRect,
  viewState: CellViewStateLike,
  positions: Float32Array,
  totalPoints: number,
  screenPoints: readonly ScreenPoint[],
  index?: PointIndex,
): IndexMask {
  if (screenPoints.length < 3) return new IndexMask(totalPoints)
  const polygon: [number, number][] = []
  for (const p of screenPoints) {
    const w = unprojectInCell(rect, viewState, p[0], p[1])
    if (!w) return new IndexMask(totalPoints)
    polygon.push(w)
  }
  if (index) return selectInPolygon(positions, polygon, totalPoints, undefined, index)
  const candidates = bboxCandidates(positions, totalPoints, polygonBoundingBox(polygon))
  return selectInPolygon(positions, polygon, totalPoints, candidates)
}
