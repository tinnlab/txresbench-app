// sharedMaskController.ts — the cross-pane correction controller (segmentation-scale Track A, ITEM-5/6).
//
// WRAPS (does NOT fork) `createMaskCorrectController` bound to the ONE shared raster. Every gesture is
// expressed in WORLD coordinates (the pane's own screen→world mapping happens UPSTREAM in the grid,
// via that cell's existing `coords` facade); this controller maps world→shared-raster pixel through
// the shared mask's single affine and delegates the actual mutation to the wrapped per-raster
// controller unchanged. Two consequences:
//
//   • INV-9 (seam-invisible): the same WORLD point produced by pane A's mapper or pane B's mapper maps
//     to the IDENTICAL shared pixel, because `mask.worldToPixel` is the ONE shared affine — there is no
//     pane-local pixel math on the edit path. A stroke that drags from pane A into pane B is one
//     continuous run of shared-raster texels.
//   • INV-8 (one raster / one undo): undo/redo delegate straight to the wrapped controller's single
//     stack; the fan-out (`onFanout`) routes the wrapped controller's dirty rect to each viewing pane.
//
// Pure (viz-core): no deck / react / GL. `applyMaskPick`-style tools (relabel/merge on a picked id)
// don't need mapping and pass through; `brush`/`split` take world coords and are mapped here.

import {
  createMaskCorrectController,
  type MaskCorrectController,
} from './maskCorrectController'
import type { EditResult, SplitResult, SplitSeed } from './maskEdit'
import type { SharedLabelMask } from './sharedMask'
import { fanOutDirtyRect, type FanoutTarget } from './sharedMaskFanout'

/** A brush stroke expressed in WORLD units: center `(wx, wy)` + radius `rWorld` (world length). */
export interface WorldBrushOp {
  readonly wx: number
  readonly wy: number
  /** brush radius in WORLD units (mapped to shared-raster pixels via the shared affine). */
  readonly rWorld: number
  readonly id: number
}

/** A seeded split whose seed points are in WORLD coords. */
export interface WorldSplitSeedOp {
  readonly cellId: number
  readonly seeds: readonly { readonly wx: number; readonly wy: number; readonly id: number }[]
}

export interface SharedMaskControllerOpts {
  readonly mask: SharedLabelMask
  /** called after any pixel-changing op with the per-view dirty-rect fan-out (host sub-uploads each). */
  readonly onFanout?: (targets: FanoutTarget[], raster: Uint32Array) => void
  /** called after any op that changed the id→category LUT (relabel/merge recolor). */
  readonly onCategories?: (categoryForId: Uint16Array) => void
  readonly maxHistory?: number
}

export interface SharedMaskController {
  /** paint a disk given in WORLD coords onto the shared raster. */
  brushWorld(op: WorldBrushOp): EditResult
  /** reclassify a label id (LUT-only; no coordinate mapping needed). */
  relabel(id: number, newCategory: number): EditResult
  /** merge label `from` into `to` (no coordinate mapping needed). */
  merge(from: number, to: number): EditResult
  /** seeded split whose seeds are in WORLD coords. */
  splitWorld(op: WorldSplitSeedOp): SplitResult
  undo(): boolean
  redo(): boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly historyDepth: number
  clearHistory(): void
  /** the wrapped per-raster controller (escape hatch for pixel-space ops / tests). */
  readonly inner: MaskCorrectController
}

/**
 * Create a shared-mask controller. All edits flow through ONE wrapped `createMaskCorrectController` so
 * the undo stack is single and the raster identity is preserved; world coords are mapped to shared
 * pixels here, never in a pane.
 */
export function createSharedMaskController(opts: SharedMaskControllerOpts): SharedMaskController {
  const { mask } = opts
  const inner = createMaskCorrectController({
    mask: mask.raster,
    width: mask.width,
    height: mask.height,
    categoryForId: mask.categoryForId,
    // the wrapped controller reports its dirty rect in SHARED-raster pixels → fan out to every view.
    onPixels: rect => opts.onFanout?.(fanOutDirtyRect([...rect], mask), mask.raster),
    onCategories: cats => opts.onCategories?.(cats),
    maxHistory: opts.maxHistory,
  })

  const toPixel = (wx: number, wy: number): readonly [number, number] => {
    const [px, py] = mask.worldToPixel(wx, wy)
    return [Math.round(px), Math.round(py)]
  }

  return {
    inner,
    brushWorld(op) {
      const [x, y] = toPixel(op.wx, op.wy)
      const r = Math.max(0, Math.round(mask.worldLengthToPixels(op.rWorld)))
      return inner.brush({ x, y, r, id: op.id })
    },
    relabel(id, newCategory) {
      return inner.relabel(id, newCategory)
    },
    merge(from, to) {
      return inner.merge(from, to)
    },
    splitWorld(op) {
      const seeds: SplitSeed[] = op.seeds.map(s => {
        const [x, y] = toPixel(s.wx, s.wy)
        return { x, y, id: s.id }
      })
      return inner.split({ cellId: op.cellId, seeds })
    },
    undo() {
      return inner.undo()
    },
    redo() {
      return inner.redo()
    },
    get canUndo() {
      return inner.canUndo
    },
    get canRedo() {
      return inner.canRedo
    },
    get historyDepth() {
      return inner.historyDepth
    },
    clearHistory() {
      inner.clearHistory()
    },
  }
}
