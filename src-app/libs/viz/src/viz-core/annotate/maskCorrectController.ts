// maskCorrectController.ts — wires the PURE mask-correction ops (`maskEdit.ts`) to the GPU layer's
// dirty-rect sub-upload (`LabelMaskLayer.updateSubRegion` / the `dirtyRect` prop) and a per-cell
// undo/redo stack (ITEM-12, DEC-D). This is the imperative glue that makes a correction (a) mutate
// the CPU label raster + id→category LUT in place, (b) re-upload ONLY the dirty rect (never the
// whole raster), and (c) be undoable/redoable as a single atom.
//
// Framework-agnostic (viz-core): NO deck / react / GL / I/O imports. The layer is reached through
// two injected callbacks — `onPixels(rect, mask)` (upload the dirty rect) and `onCategories(cat)`
// (rebuild the id→color LUT for a relabel/merge recolor) — so this controller is oracle-testable in
// node and the SAME controller drives the live `LabelMaskLayer` (the host passes callbacks that call
// `layer.updateSubRegion(...)` / bump the `categoryForId`+`dirtyRect` props).

import {
  applyBrush,
  applyMerge,
  applyRelabel,
  applySplit,
  applyUndoAtom,
  isEmptyRect,
  EMPTY_RECT,
  type BrushOp,
  type DirtyRect,
  type EditResult,
  type LabelRaster,
  type SplitOp,
  type SplitResult,
  type UndoAtom,
} from './maskEdit'

/** Upload the dirty rect of the (in-place-edited) raster to the GPU (e.g. `layer.updateSubRegion`). */
export type OnPixelsUpload = (rect: DirtyRect, mask: LabelRaster) => void
/** Rebuild the id→color LUT after a relabel/merge recolor (e.g. bump the layer's `categoryForId`). */
export type OnCategoriesChange = (categoryForId: Uint16Array) => void

export interface MaskCorrectControllerOpts {
  /** The editable CPU label raster (id per pixel, row-major, 0 = background). Mutated in place. */
  readonly mask: LabelRaster
  readonly width: number
  readonly height: number
  /** id→category code (index 0 = background). Mutated in place by relabel/merge. */
  readonly categoryForId: Uint16Array
  /** Called after any op that changed pixels, with the tight dirty rect to sub-upload. */
  readonly onPixels?: OnPixelsUpload
  /** Called after any op that changed the id→category assignment (relabel/merge recolor). */
  readonly onCategories?: OnCategoriesChange
  /** Bounded undo history (FIFO; oldest dropped past this). Default 200. */
  readonly maxHistory?: number
}

/** One reversible correction: the pixel delta and/or the category delta, each with its inverse. */
interface HistoryEntry {
  /** dirty rect of the pixel change (EMPTY when the op touched no pixels — e.g. relabel). */
  readonly rect: DirtyRect
  /** pixel inverse (old values) — restore with `applyUndoAtom(mask, pixelUndo)`. */
  readonly pixelUndo?: UndoAtom
  /** pixel forward (new values) — re-apply with `applyUndoAtom(mask, pixelRedo)`. */
  readonly pixelRedo?: UndoAtom
  /** category inverse (old values), indices = ids — `applyUndoAtom(categoryForId, catUndo)`. */
  readonly catUndo?: UndoAtom
  /** category forward (new values). */
  readonly catRedo?: UndoAtom
}

export interface MaskCorrectController {
  brush(op: BrushOp): EditResult
  relabel(id: number, newCategory: number): EditResult
  merge(from: number, to: number): EditResult
  split(op: SplitOp): SplitResult
  undo(): boolean
  redo(): boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Depth of the undo stack (mostly for tests / a history badge). */
  readonly historyDepth: number
  /** Drop all history (e.g. on a fresh mask load). */
  clearHistory(): void
}

/** Read the CURRENT values of `indices` out of `target` — the "forward" (redo) atom of an edit. */
function captureForward(target: Uint32Array | Uint16Array | number[], atom: UndoAtom): UndoAtom {
  const indices = atom.indices
  const values = new Uint32Array(indices.length)
  for (let k = 0; k < indices.length; k++) values[k] = target[indices[k]] >>> 0
  return { indices, oldValues: values }
}

/**
 * Create a per-cell mask-correction controller bound to one editable raster + its id→category LUT.
 * Each correction mutates the raster/LUT in place, re-uploads only the dirty rect, and pushes one
 * undoable atom.
 */
export function createMaskCorrectController(
  opts: MaskCorrectControllerOpts,
): MaskCorrectController {
  const { mask, width, height, categoryForId } = opts
  const onPixels = opts.onPixels
  const onCategories = opts.onCategories
  const maxHistory = Math.max(1, opts.maxHistory ?? 200)

  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []

  /** Push a fresh entry (clears the redo branch + enforces the FIFO cap). */
  const push = (entry: HistoryEntry): void => {
    undoStack.push(entry)
    redoStack.length = 0
    if (undoStack.length > maxHistory) undoStack.shift()
  }

  /** Fire the upload/recolor callbacks for whichever channels an entry touched. */
  const emit = (rect: DirtyRect, touchedCategories: boolean): void => {
    if (!isEmptyRect(rect)) onPixels?.(rect, mask)
    if (touchedCategories) onCategories?.(categoryForId)
  }

  return {
    brush(op: BrushOp): EditResult {
      const res = applyBrush(mask, width, height, op)
      if (!isEmptyRect(res.dirtyRect)) {
        push({
          rect: res.dirtyRect,
          pixelUndo: res.undoAtom,
          pixelRedo: captureForward(mask, res.undoAtom),
        })
        emit(res.dirtyRect, false)
      }
      return res
    },

    relabel(id: number, newCategory: number): EditResult {
      const res = applyRelabel(categoryForId, id, newCategory)
      push({
        rect: [...EMPTY_RECT] as DirtyRect,
        catUndo: res.undoAtom,
        catRedo: captureForward(categoryForId, res.undoAtom),
      })
      emit(res.dirtyRect, true)
      return res
    },

    merge(from: number, to: number): EditResult {
      // Capture the merged id's category BEFORE the op (applyMerge clears it to 0 in place).
      const oldCat = categoryForId[from] >>> 0
      const res = applyMerge(mask, width, height, { from, to, categoryForId })
      const catUndo: UndoAtom = { indices: [from], oldValues: Uint32Array.of(oldCat) }
      const catRedo: UndoAtom = { indices: [from], oldValues: Uint32Array.of(0) }
      push({
        rect: res.dirtyRect,
        pixelUndo: res.undoAtom,
        pixelRedo: captureForward(mask, res.undoAtom),
        catUndo,
        catRedo,
      })
      emit(res.dirtyRect, true)
      return res
    },

    split(op: SplitOp): SplitResult {
      const res = applySplit(mask, width, height, op)
      if (!isEmptyRect(res.dirtyRect)) {
        push({
          rect: res.dirtyRect,
          pixelUndo: res.undoAtom,
          pixelRedo: captureForward(mask, res.undoAtom),
        })
        emit(res.dirtyRect, false)
      }
      return res
    },

    undo(): boolean {
      const entry = undoStack.pop()
      if (!entry) return false
      if (entry.pixelUndo) applyUndoAtom(mask, entry.pixelUndo)
      if (entry.catUndo) applyUndoAtom(categoryForId, entry.catUndo)
      redoStack.push(entry)
      emit(entry.rect, entry.catUndo != null)
      return true
    },

    redo(): boolean {
      const entry = redoStack.pop()
      if (!entry) return false
      if (entry.pixelRedo) applyUndoAtom(mask, entry.pixelRedo)
      if (entry.catRedo) applyUndoAtom(categoryForId, entry.catRedo)
      undoStack.push(entry)
      emit(entry.rect, entry.catRedo != null)
      return true
    },

    get canUndo(): boolean {
      return undoStack.length > 0
    },
    get canRedo(): boolean {
      return redoStack.length > 0
    },
    get historyDepth(): number {
      return undoStack.length
    },
    clearHistory(): void {
      undoStack.length = 0
      redoStack.length = 0
    },
  }
}
