// sharedMaskFanout.ts — cross-pane dirty-rect fan-out (segmentation-scale Track A, ITEM-6).
//
// After a correction mutates the ONE shared raster in place, the changed pixel rect (in shared-raster
// pixel space) must repaint in EVERY pane viewing that mask — but each pane should sub-upload ONLY the
// portion it actually shows (F-TILE-1/2 / INV-8): a pane whose viewport doesn't overlap the edit does
// no upload at all. Since every view renders the SAME raster reference, "sub-upload" is the same
// `updateSubRegion`/`encodeLabelMaskSubRect` primitive Track 0 already uses — this module only decides
// the per-view rect, it never copies pixels.
//
// Pure (viz-core): no deck / react / GL. The host feeds each emitted `{cellId, rect}` to that cell's
// `LabelMaskLayer` dirty-rect prop.

import { EMPTY_RECT, isEmptyRect, type DirtyRect } from './maskEdit'
import type { SharedLabelMask, WorldRect } from './sharedMask'

/** One pane's slice of a shared-mask edit: the cell + the dirty rect (shared-raster pixel coords) it
 *  must sub-upload. A non-overlapping view is NOT emitted (no wasted upload). */
export interface FanoutTarget {
  readonly cellId: string
  readonly rect: DirtyRect
}

/** Intersect two INCLUSIVE `[minX,minY,maxX,maxY]` pixel rects; `EMPTY_RECT` when disjoint. */
export function intersectRect(a: DirtyRect, b: DirtyRect): DirtyRect {
  if (isEmptyRect(a) || isEmptyRect(b)) return [...EMPTY_RECT] as DirtyRect
  const minX = Math.max(a[0], b[0])
  const minY = Math.max(a[1], b[1])
  const maxX = Math.min(a[2], b[2])
  const maxY = Math.min(a[3], b[3])
  if (maxX < minX || maxY < minY) return [...EMPTY_RECT] as DirtyRect
  return [minX, minY, maxX, maxY]
}

/** Map a view's WORLD viewport to the shared raster's inclusive pixel window, clamped to the raster. */
export function viewPixelWindow(mask: SharedLabelMask, worldViewport: WorldRect): DirtyRect {
  const [wx0, wy0, wx1, wy1] = worldViewport
  const [ax, ay] = mask.worldToPixel(wx0, wy0)
  const [bx, by] = mask.worldToPixel(wx1, wy1)
  // world→pixel is monotonic per axis, but a viewport may be given in either corner order — normalize.
  const minX = Math.max(0, Math.floor(Math.min(ax, bx)))
  const minY = Math.max(0, Math.floor(Math.min(ay, by)))
  const maxX = Math.min(mask.width - 1, Math.ceil(Math.max(ax, bx)))
  const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(ay, by)))
  if (maxX < minX || maxY < minY) return [...EMPTY_RECT] as DirtyRect
  return [minX, minY, maxX, maxY]
}

/**
 * Fan a shared-raster edit's dirty rect out to every registered view. For each view: the emitted rect
 * is the intersection of `worldPixelRect` (the edit, in shared-raster pixels) with the view's visible
 * pixel window; a view with `worldViewport: null` "covers everything" so it gets the full edit rect.
 * Views not overlapping the edit are omitted entirely.
 */
export function fanOutDirtyRect(worldPixelRect: DirtyRect, mask: SharedLabelMask): FanoutTarget[] {
  const out: FanoutTarget[] = []
  if (isEmptyRect(worldPixelRect)) return out
  // clamp the edit to the raster so a view-window intersection can't exceed bounds.
  const editRect = intersectRect(worldPixelRect, [0, 0, mask.width - 1, mask.height - 1])
  if (isEmptyRect(editRect)) return out
  for (const view of mask.views.values()) {
    if (view.worldViewport == null) {
      out.push({ cellId: view.cellId, rect: [...editRect] as DirtyRect })
      continue
    }
    const window = viewPixelWindow(mask, view.worldViewport)
    const rect = intersectRect(editRect, window)
    if (!isEmptyRect(rect)) out.push({ cellId: view.cellId, rect })
  }
  return out
}
