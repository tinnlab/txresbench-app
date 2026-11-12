// dragGeometry.ts — the PURE geometry for the cross-window GRIP DRAG (pointer-based). `resolveDrop` is
// the resolver: the pointer is over `hovered` (whichever dock window it's currently in); a drop in the
// SOURCE container is a SWAP (over another pane) / TEAR-OFF (released beyond the workspace) / none,
// while a drop in a DIFFERENT container is a MOVE (dock the pane into that window — beside a pane, or
// into its empty body). Same coordinate space per window: the caller snapshots each window's rects in
// THAT window's client coords and feeds the matching window's local pointer coords here.
// No DOM/React — node-unit-testable; the pointer-drag lifecycle in `@txresbench/dock`'s `useGripDrag` feeds
// it snapshots.

import type { SplitDir } from './layout/splitTree'

/** Minimal rectangle shape (a `DOMRect` satisfies it). */
export interface RectLike {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * True when the point `(x, y)` lies OUTSIDE `rect` — i.e. the drag was released beyond the main
 * container, so it's a TEAR-OFF, not an in-main swap. The boundary counts as INSIDE (a release exactly
 * on the container edge stays in the main). A non-finite point returns `false` (can't decide → never
 * tear off) and a degenerate/empty rect (`right < left`) also returns `false` (no meaningful outside).
 */
export function isPointOutsideRect(x: number, y: number, rect: RectLike): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (rect.right < rect.left || rect.bottom < rect.top) return false
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom
}

/** True when `(x, y)` is inside `rect` (boundary inclusive). */
function isPointInRect(x: number, y: number, rect: RectLike): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/** A docked cell's screen rect, tagged with its id (snapshotted at drag start). */
export interface DragRect {
  readonly id: string
  readonly rect: RectLike
}

/** The resolved outcome of a grip drag ending at `(x, y)`.
 *  - `swap`    — over another pane in the SAME container → trade their content/positions.
 *  - `move`    — over a DIFFERENT container (docking P4) → re-home the pane into that container:
 *                `overPaneId` names the pane to split beside (`dir`), or `null` to append into the
 *                container's empty body / become its root.
 *  - `tearoff` — released beyond the SOURCE container's workspace → a new window.
 *  - `none`    — no actionable target. */
export type DragResolution =
  | { readonly kind: 'swap'; readonly paneId: string }
  | { readonly kind: 'move'; readonly container: string; readonly overPaneId: string | null; readonly dir: SplitDir; readonly before: boolean }
  | { readonly kind: 'tearoff' }
  | { readonly kind: 'none' }

/** The 5 drop zones of a pane's "+"-cross: a CENTER square (swap the two panes) surrounded by four
 *  edge ARMS (split-insert the dragged pane on that side of the target). */
export type DropZone = 'center' | 'top' | 'bottom' | 'left' | 'right'

/**
 * Partition a pane rect into a "+"-cross of 5 drop zones. The pointer maps to a CENTER square (whose
 * half-extent is `centerFrac` of each half-axis — 0.34 ⇒ ~the middle third is center) or, outside it, to
 * the edge ARM along whichever axis the pointer is FURTHER from center on (diagonal boundaries, like an
 * IDE's dock indicator). A degenerate (zero-size) rect ⇒ `'center'`. Pure — unit-tested; the caller maps
 * an arm to a split `dir` + `before` (left/top LEAD the target; right/bottom TRAIL it) and the center to
 * a content swap.
 */
export function dropZoneFor(x: number, y: number, rect: RectLike, centerFrac = 0.34): DropZone {
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  if (w <= 0 || h <= 0) return 'center'
  const nx = (x - (rect.left + rect.right) / 2) / (w / 2) // ∈ [-1,1] (0 at center)
  const ny = (y - (rect.top + rect.bottom) / 2) / (h / 2)
  if (Math.abs(nx) <= centerFrac && Math.abs(ny) <= centerFrac) return 'center'
  if (Math.abs(nx) >= Math.abs(ny)) return nx < 0 ? 'left' : 'right'
  return ny < 0 ? 'top' : 'bottom'
}

/** Map an edge {@link DropZone} to its split axis (`col` = side-by-side, `row` = stacked) + whether the
 *  dragged pane LEADS the target (`before`: left/top) or TRAILS it (right/bottom). `'center'` ⇒ null. */
export function zoneToSplit(zone: DropZone): { dir: SplitDir; before: boolean } | null {
  switch (zone) {
    case 'left':
      return { dir: 'col', before: true }
    case 'right':
      return { dir: 'col', before: false }
    case 'top':
      return { dir: 'row', before: true }
    case 'bottom':
      return { dir: 'row', before: false }
    default:
      return null // center → swap, no split
  }
}

/** A dock container the drag can land in: its workspace rect + its pane rects, all in THAT container's
 *  window client coords (so the pointer's local coords in the same window compare directly). */
export interface ContainerSnapshot {
  readonly containerId: string
  readonly containerRect: RectLike
  readonly panes: readonly DragRect[]
}

/** Topmost pane (last in DOM/paint order) whose rect contains `(x, y)`, excluding the drag source. */
function topmostPaneAt(
  x: number,
  y: number,
  panes: readonly DragRect[],
  sourceId: string,
): DragRect | null {
  for (let i = panes.length - 1; i >= 0; i--) {
    const p = panes[i]
    if (p.id === sourceId) continue
    if (isPointInRect(x, y, p.rect)) return p
  }
  return null
}

/**
 * Which way to split a target pane so the dropped pane docks toward the pointer: the axis the pointer
 * is FURTHER from center along (normalized by the pane's size) decides. Horizontal dominance → `'col'`
 * (side-by-side); vertical dominance → `'row'` (stacked). A degenerate (zero-size) rect defaults to
 * `'col'`. Pure — the exact side is `splitLeaf`'s convention (the new pane trails the existing one).
 */
export function splitDirFor(x: number, y: number, rect: RectLike): SplitDir {
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  if (w <= 0 || h <= 0) return 'col'
  const dx = Math.abs(x - (rect.left + rect.right) / 2) / w
  const dy = Math.abs(y - (rect.top + rect.bottom) / 2) / h
  return dx >= dy ? 'col' : 'row'
}

/**
 * Resolve a cross-window grip drop. The pointer is currently over `hovered` — whichever dock container
 * (window) it's physically in — at local client coords `(x, y)` in THAT window. `sourceContainerId` is
 * where the dragged pane `sourceId` lives.
 *
 *   - SAME container as the source → byte-compatible with {@link resolveDragTarget}: outside the
 *     workspace rect = `tearoff`; over another pane = `swap`; else `none`.
 *   - a DIFFERENT container → a `move`: inside its workspace over a pane → dock beside that pane
 *     (`overPaneId` + `dir`); inside but over empty body → append (`overPaneId: null`); OUTSIDE that
 *     foreign window's workspace rect → `none` (a release in a foreign window's margin docks nothing,
 *     and never tears off — only the source window's outside means "new window").
 *
 * A non-finite point → `none` (undecidable). The boundary counts as INSIDE (edge = inside), matching
 * `isPointOutsideRect`.
 */
export function resolveDrop(
  x: number,
  y: number,
  hovered: ContainerSnapshot,
  sourceId: string,
  sourceContainerId: string,
): DragResolution {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'none' }
  const sameContainer = hovered.containerId === sourceContainerId
  if (isPointOutsideRect(x, y, hovered.containerRect)) {
    // Released beyond this window's workspace: only the SOURCE window's outside is a tear-off (a new
    // window); a foreign window's margin docks nothing.
    return sameContainer ? { kind: 'tearoff' } : { kind: 'none' }
  }
  const over = topmostPaneAt(x, y, hovered.panes, sourceId)
  if (sameContainer) {
    // Over another pane in the SAME container → a "+"-cross drop: the CENTER square swaps the two panes
    // (keeps the tree + divider sizes); an EDGE arm REPOSITIONS the dragged pane beside the target on
    // that side (a same-container `move`, which `movePane` handles as a reposition — remove + re-insert).
    if (!over) return { kind: 'none' }
    const split = zoneToSplit(dropZoneFor(x, y, over.rect))
    if (!split) return { kind: 'swap', paneId: over.id }
    return { kind: 'move', container: hovered.containerId, overPaneId: over.id, dir: split.dir, before: split.before }
  }
  // Foreign container → MOVE: split beside the hovered pane, or append into the empty body. Cross-window
  // docking keeps the axis-dominance split (always trailing) — `before:false`.
  return {
    kind: 'move',
    container: hovered.containerId,
    overPaneId: over ? over.id : null,
    dir: over ? splitDirFor(x, y, over.rect) : 'col',
    before: false,
  }
}
