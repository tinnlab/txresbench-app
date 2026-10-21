// maskEdit.ts — PURE mask-correction core for the label-mask editor (ITEM-12, DEC-D).
//
// Operates on an EDITABLE integer label raster typed as `Uint32Array` (row-major, one id per
// pixel, 0 = background). Uint32 — NOT Uint16 — because a whole-slide segmentation can carry
// millions of distinct cell ids (far past Uint16's 65535), and the rgb id-pack in
// `../spatial/labelMaskColor.ts` (`packIdToRGB`, id = r + g·256 + b·65536) spans the full 2^24
// range. This module is the CPU twin of `labelMaskColor.ts`: pure domain logic, NO GL / deck /
// react / I/O — oracle-testable in node.
//
// Each correction op mutates the raster (or the id→category LUT array) IN PLACE and returns an
// `EditResult`:
//   • `dirtyRect = [minX, minY, maxX, maxY]` — the INCLUSIVE bounding box of the pixels the op
//     actually changed (`maxX < minX` ⇒ EMPTY: no pixel changed). This is the ONLY region the
//     GPU layer must re-encode + sub-upload, so cost tracks the EDIT, not the image (the
//     gigapixel-safety invariant): brush O(r²), merge O(cell), split O(bbox), relabel O(1).
//   • `undoAtom = { indices, oldValues }` — the exact pixels changed + their prior values, so
//     `applyUndoAtom(raster, atom)` restores the raster byte-for-byte (napari-style undo atoms:
//     O(diff) memory, not O(image) snapshots).
//
// The four ops (INV-6, first-class correction): brush-fix (paint id in a disk), relabel
// (id→category LUT edit, no pixels), merge (rewrite B→A over bbox(B)), split (a fresh id +
// repartition within bbox(cell) — manual cut line by default, optional seeded marker-controlled
// watershed on the cell's distance transform).

import type { LabelMask } from '../spatial/labelMaskColor'
import {
  type HierObject,
  type HierarchyDelta,
  EMPTY_HIERARCHY_DELTA,
  shapeOfMaskObject,
  splitPreserveChildren,
  mergePreserveChildren,
  reresolveParentage,
} from './hierarchy'

/** The editable label raster: id per pixel, row-major, 0 = background. Uint32 per DEC-D. */
export type LabelRaster = Uint32Array

/**
 * A dirty rectangle in pixel space: `[minX, minY, maxX, maxY]`, INCLUSIVE on all four bounds.
 * `maxX < minX` (canonically `EMPTY_RECT`) means the op changed nothing.
 */
export type DirtyRect = [minX: number, minY: number, maxX: number, maxY: number]

/** The canonical empty dirty-rect (no pixel changed). Sub-upload skips an empty rect. */
export const EMPTY_RECT: DirtyRect = [0, 0, -1, -1]

/** True iff a dirty-rect encloses no pixels. */
export function isEmptyRect(rect: DirtyRect): boolean {
  return rect[2] < rect[0] || rect[3] < rect[1]
}

/**
 * An undo atom: the flat indices that changed + their PRIOR values. Restoring is `raster[i] =
 * old` for each — O(diff), the minimal reversible delta. `indices`/`oldValues` are parallel.
 */
export interface UndoAtom {
  readonly indices: Uint32Array | number[]
  readonly oldValues: Uint32Array
}

/** The uniform return of every pixel-mutating op: the changed region + its inverse. */
export interface EditResult {
  readonly dirtyRect: DirtyRect
  readonly undoAtom: UndoAtom
}

/** Any writable integer-indexed numeric array — the pixel raster OR the id→category LUT array. */
export type WritableIntArray = Uint32Array | Uint16Array | Int32Array | Uint8Array | number[]

// ── shared rect/undo accumulation ────────────────────────────────────────────────────────────

/** A mutable accumulator gathering changed indices + a growing dirty bbox. */
interface EditAccum {
  indices: number[]
  oldValues: number[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function newAccum(): EditAccum {
  return {
    indices: [],
    oldValues: [],
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }
}

/** Record a single pixel change into the accumulator (old value already captured). */
function record(acc: EditAccum, index: number, oldValue: number, px: number, py: number): void {
  acc.indices.push(index)
  acc.oldValues.push(oldValue)
  if (px < acc.minX) acc.minX = px
  if (px > acc.maxX) acc.maxX = px
  if (py < acc.minY) acc.minY = py
  if (py > acc.maxY) acc.maxY = py
}

/** Finalize an accumulator into the uniform `EditResult` (EMPTY when nothing changed). */
function finalize(acc: EditAccum): EditResult {
  if (acc.indices.length === 0) {
    return {
      dirtyRect: [...EMPTY_RECT] as DirtyRect,
      undoAtom: { indices: new Uint32Array(0), oldValues: new Uint32Array(0) },
    }
  }
  return {
    dirtyRect: [acc.minX, acc.minY, acc.maxX, acc.maxY],
    undoAtom: { indices: Uint32Array.from(acc.indices), oldValues: Uint32Array.from(acc.oldValues) },
  }
}

/** Clamp a search rect to the raster bounds, returning inclusive `[x0, y0, x1, y1]`. */
function clampRect(rect: DirtyRect | undefined, w: number, h: number): DirtyRect {
  const r = rect ?? [0, 0, w - 1, h - 1]
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(r[0])))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(r[1])))
  const x1 = Math.max(0, Math.min(w - 1, Math.ceil(r[2])))
  const y1 = Math.max(0, Math.min(h - 1, Math.ceil(r[3])))
  return [x0, y0, x1, y1]
}

// ── restore ────────────────────────────────────────────────────────────────────────────────

/**
 * Restore an undo atom over `target` in place (the inverse of the op that produced it). Generic
 * over any writable integer array so it undoes both a pixel-raster edit (pass the `LabelRaster`)
 * and a relabel/merge LUT edit (pass the `categoryForId` array).
 */
export function applyUndoAtom(target: WritableIntArray, atom: UndoAtom): void {
  const { indices, oldValues } = atom
  for (let k = 0; k < indices.length; k++) {
    target[indices[k]] = oldValues[k]
  }
}

// ── brush-fix ────────────────────────────────────────────────────────────────────────────────

/** A brush stamp: paint filled disk of radius `r` at center `(x, y)` with label `id`. */
export interface BrushOp {
  readonly x: number
  readonly y: number
  readonly r: number
  readonly id: number
}

/**
 * Paint a filled disk of radius `r` centered at `(x, y)` with label `id`. Only pixels whose value
 * actually changes are recorded, so `dirtyRect` tightly bounds the painted footprint (O(r²)).
 */
export function applyBrush(mask: LabelRaster, w: number, h: number, op: BrushOp): EditResult {
  const { x, y, r } = op
  const id = op.id >>> 0
  const r2 = r * r
  const x0 = Math.max(0, Math.floor(x - r))
  const x1 = Math.min(w - 1, Math.ceil(x + r))
  const y0 = Math.max(0, Math.floor(y - r))
  const y1 = Math.min(h - 1, Math.ceil(y + r))
  const acc = newAccum()
  for (let py = y0; py <= y1; py++) {
    const dy = py - y
    const dy2 = dy * dy
    for (let px = x0; px <= x1; px++) {
      const dx = px - x
      if (dx * dx + dy2 > r2) continue
      const i = py * w + px
      const old = mask[i]
      if (old === id) continue
      mask[i] = id
      record(acc, i, old, px, py)
    }
  }
  return finalize(acc)
}

// ── relabel (LUT-only, no pixels) ────────────────────────────────────────────────────────────

/**
 * Reclassify label `id` to `newCategory` by editing the id→category LUT array IN PLACE — NO pixel
 * touch (recolor = an O(numLabels) LUT rebuild downstream via `buildIdColorLut`, never an O(pixels)
 * pass). `dirtyRect` is EMPTY (no pixel changed); the returned `undoAtom` targets `categoryForId`
 * (restore with `applyUndoAtom(categoryForId, atom)`).
 */
export function applyRelabel(
  categoryForId: Uint16Array,
  id: number,
  newCategory: number,
): EditResult {
  const old = categoryForId[id]
  categoryForId[id] = newCategory
  return {
    dirtyRect: [...EMPTY_RECT] as DirtyRect,
    undoAtom: { indices: [id], oldValues: Uint32Array.of(old >>> 0) },
  }
}

// ── merge ────────────────────────────────────────────────────────────────────────────────────

/** Merge label `from` into `to`: every `from` pixel becomes `to`. Optional bbox/category hints. */
export interface MergeOp {
  readonly from: number
  readonly to: number
  /** If given, `categoryForId[from]` is cleared to 0 (the merged id no longer labels any pixel). */
  readonly categoryForId?: Uint16Array
  /** Search region hint — the known `bbox(from)`; omit to scan the whole raster. */
  readonly bbox?: DirtyRect
}

/**
 * Rewrite every pixel labeled `from` to `to` (over `bbox(from)`), and — when `categoryForId` is
 * supplied — clear `categoryForId[from]` to 0 (the merged id labels nothing now). Cost is
 * O(search-region); `dirtyRect` tightly bounds `bbox(from)`. The returned `undoAtom` restores the
 * PIXELS byte-for-byte; the caller separately restores the category (capture it before merging).
 */
export function applyMerge(mask: LabelRaster, w: number, h: number, op: MergeOp): EditResult {
  const from = op.from >>> 0
  const to = op.to >>> 0
  // Merging an id into ITSELF changes no pixel — a true no-op: EMPTY dirtyRect + EMPTY undoAtom,
  // and NO category clear (the id still labels its pixels). Without this guard the loop below
  // rewrites every `from` pixel to the same value yet records each as "changed".
  if (from === to) return finalize(newAccum())
  const [sx0, sy0, sx1, sy1] = clampRect(op.bbox, w, h)
  const acc = newAccum()
  for (let py = sy0; py <= sy1; py++) {
    const row = py * w
    for (let px = sx0; px <= sx1; px++) {
      const i = row + px
      if (mask[i] !== from) continue
      mask[i] = to
      record(acc, i, from, px, py)
    }
  }
  if (op.categoryForId && from < op.categoryForId.length) {
    op.categoryForId[from] = 0
  }
  return finalize(acc)
}

// ── split ────────────────────────────────────────────────────────────────────────────────────

/** A straight cut line (infinite line through two points) for manual splitting. */
export interface CutLine {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** A watershed marker: a seed pixel `(x, y)` carrying the label its catchment basin receives. */
export interface SplitSeed {
  readonly x: number
  readonly y: number
  readonly id: number
}

/** Manual split: cell pixels on the positive side of `cutLine` receive a fresh id. */
export interface SplitCutOp {
  readonly cellId: number
  readonly cutLine: CutLine
  /** The fresh id for the cut-off side; defaults to `nextLabelId(mask)`. */
  readonly newId?: number
  readonly bbox?: DirtyRect
}

/** Seeded split: a marker-controlled watershed repartitions the cell among the seeds' ids. */
export interface SplitSeedOp {
  readonly cellId: number
  readonly seeds: readonly SplitSeed[]
  readonly bbox?: DirtyRect
}

export type SplitOp = SplitCutOp | SplitSeedOp

/** Split result: the standard `EditResult` plus the id(s) introduced (≠ `cellId`). */
export interface SplitResult extends EditResult {
  readonly newIds: number[]
}

function isSeedOp(op: SplitOp): op is SplitSeedOp {
  return (op as SplitSeedOp).seeds !== undefined
}

/** The largest representable Uint32 label id; +1 would wrap to 0 (= background). */
const MAX_LABEL_ID = 0xffffffff

/**
 * The next unused label id. Normally `max id in the raster + 1` (O(pixels); pass `newId` to avoid
 * it). If the raster already uses the maximum Uint32 id, `max + 1` would wrap to 0 (background),
 * silently corrupting the raster — so instead scan for the smallest unused POSITIVE id (never 0),
 * and throw only if the entire 2^32-1 id space is saturated (not physically reachable).
 */
export function nextLabelId(mask: LabelRaster): number {
  let max = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] > max) max = mask[i]
  if (max < MAX_LABEL_ID) return max + 1
  // Saturated top id: find the smallest free positive id rather than wrapping to 0.
  const used = new Set<number>()
  for (let i = 0; i < mask.length; i++) used.add(mask[i])
  for (let id = 1; id < MAX_LABEL_ID; id++) if (!used.has(id)) return id
  throw new Error('nextLabelId: label id space exhausted (all 2^32-1 ids in use)')
}

/** Tight inclusive bbox of pixels equal to `id` within a search region (EMPTY if none). */
export function bboxOfId(
  mask: LabelRaster,
  w: number,
  h: number,
  id: number,
  search?: DirtyRect,
): DirtyRect {
  const [sx0, sy0, sx1, sy1] = clampRect(search, w, h)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let py = sy0; py <= sy1; py++) {
    const row = py * w
    for (let px = sx0; px <= sx1; px++) {
      if (mask[row + px] !== id) continue
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  }
  if (maxX < minX) return [...EMPTY_RECT] as DirtyRect
  return [minX, minY, maxX, maxY]
}

/**
 * Split label `cellId` into two (or more) regions within `bbox(cellId)`, assigning a fresh id.
 *
 * Default (`cutLine`): every cell pixel strictly on the POSITIVE side of the directed line
 * (cross product > 0) receives `newId` (defaults to `nextLabelId(mask)`); pixels on the line or
 * the negative side stay `cellId`. A straight line through the cell yields two regions joined by
 * one new boundary seam.
 *
 * Optional (`seeds`): a marker-controlled watershed on the cell's distance transform — each seed
 * floods its catchment basin (Meyer immersion on the INVERTED within-cell distance transform, so
 * basins fill from the deepest interior and the dam forms at the neck between touching lobes),
 * and each cell pixel takes its basin's seed id.
 *
 * Cost is O(bbox(cellId)); `dirtyRect` tightly bounds the changed pixels. `undoAtom` restores the
 * raster byte-for-byte (all touched pixels were `cellId`).
 */
export function applySplit(mask: LabelRaster, w: number, h: number, op: SplitOp): SplitResult {
  const cellId = op.cellId >>> 0
  const box = bboxOfId(mask, w, h, cellId, op.bbox)
  if (isEmptyRect(box)) {
    return { ...finalize(newAccum()), newIds: [] }
  }
  return isSeedOp(op)
    ? splitBySeeds(mask, w, box, cellId, op.seeds)
    : splitByCut(mask, w, box, cellId, op)
}

/** Manual cut-line split (see `applySplit`). */
function splitByCut(
  mask: LabelRaster,
  w: number,
  box: DirtyRect,
  cellId: number,
  op: SplitCutOp,
): SplitResult {
  const newId = (op.newId ?? nextLabelId(mask)) >>> 0
  const { x0, y0, x1, y1 } = op.cutLine
  const ex = x1 - x0
  const ey = y1 - y0
  const acc = newAccum()
  let assigned = false
  for (let py = box[1]; py <= box[3]; py++) {
    const row = py * w
    for (let px = box[0]; px <= box[2]; px++) {
      const i = row + px
      if (mask[i] !== cellId) continue
      // Cross product of the line direction with (pixel - lineStart): sign = side.
      const cross = ex * (py - y0) - ey * (px - x0)
      if (cross > 0 && newId !== cellId) {
        mask[i] = newId
        record(acc, i, cellId, px, py)
        assigned = true
      }
    }
  }
  return { ...finalize(acc), newIds: assigned ? [newId] : [] }
}

/** Seeded marker-controlled watershed split on the within-cell distance transform (see `applySplit`). */
function splitBySeeds(
  mask: LabelRaster,
  w: number,
  box: DirtyRect,
  cellId: number,
  seeds: readonly SplitSeed[],
): SplitResult {
  const bx0 = box[0]
  const by0 = box[1]
  const bw = box[2] - box[0] + 1
  const bh = box[3] - box[1] + 1
  // Expand the local grid by a 1px background frame so cell pixels on the bbox edge measure their
  // true distance to the outside (which is guaranteed non-cell — the bbox is tight).
  const gw = bw + 2
  const gh = bh + 2
  const cell = new Uint8Array(gw * gh) // 1 = cell interior, 0 = background/frame
  for (let ly = 0; ly < bh; ly++) {
    const gy = ly + 1
    const srcRow = (ly + by0) * w
    for (let lx = 0; lx < bw; lx++) {
      if (mask[srcRow + lx + bx0] === cellId) cell[gy * gw + lx + 1] = 1
    }
  }

  // City-block distance transform: BFS from every background pixel (dist 0) inward over cell pixels.
  const dt = new Int32Array(gw * gh).fill(-1)
  let queue = new Int32Array(gw * gh)
  let qn = 0
  for (let g = 0; g < cell.length; g++) {
    if (cell[g] === 0) {
      dt[g] = 0
      queue[qn++] = g
    }
  }
  let head = 0
  let maxDt = 0
  while (head < qn) {
    const g = queue[head++]
    const gx = g % gw
    const gy = (g / gw) | 0
    const d1 = dt[g] + 1
    const nbrs = [
      gx > 0 ? g - 1 : -1,
      gx < gw - 1 ? g + 1 : -1,
      gy > 0 ? g - gw : -1,
      gy < gh - 1 ? g + gw : -1,
    ]
    for (const ng of nbrs) {
      if (ng < 0 || cell[ng] === 0 || dt[ng] !== -1) continue
      dt[ng] = d1
      if (d1 > maxDt) maxDt = d1
      queue[qn++] = ng
    }
  }

  // Meyer immersion on the INVERTED DT: priority = maxDt - dt, so deepest interior floods first
  // and the dam meets at the neck. `basin[g]` = seed index+1 (0 = unlabeled, -1 = non-cell).
  const basin = new Int32Array(gw * gh).fill(-1)
  for (let g = 0; g < cell.length; g++) if (cell[g] === 1) basin[g] = 0
  const heap = new MinHeap()
  let counter = 0
  const pushNbrs = (g: number): void => {
    const gx = g % gw
    const gy = (g / gw) | 0
    const nbrs = [
      gx > 0 ? g - 1 : -1,
      gx < gw - 1 ? g + 1 : -1,
      gy > 0 ? g - gw : -1,
      gy < gh - 1 ? g + gw : -1,
    ]
    for (const ng of nbrs) {
      if (ng < 0 || basin[ng] !== 0) continue
      heap.push(maxDt - dt[ng], counter++, ng)
    }
  }
  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s]
    const gx = seed.x - bx0 + 1
    const gy = seed.y - by0 + 1
    if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) continue
    const g = gy * gw + gx
    if (cell[g] !== 1) continue
    basin[g] = s + 1
    pushNbrs(g)
  }
  while (heap.size > 0) {
    const g = heap.pop()
    if (basin[g] !== 0) continue // already claimed
    const gx = g % gw
    const gy = (g / gw) | 0
    const nbrs = [
      gx > 0 ? g - 1 : -1,
      gx < gw - 1 ? g + 1 : -1,
      gy > 0 ? g - gw : -1,
      gy < gh - 1 ? g + gw : -1,
    ]
    // Adopt the label of a labeled neighbor; on conflict take the smallest basin index (the dam
    // between two floods falls deterministically along this contested frontier).
    let claim = 0
    for (const ng of nbrs) {
      if (ng < 0) continue
      const b = basin[ng]
      if (b > 0 && (claim === 0 || b < claim)) claim = b
    }
    if (claim === 0) continue // unreachable neighbor state; leave for a later pop
    basin[g] = claim
    pushNbrs(g)
  }

  // Any cell pixel a flood never reached (disconnected from all seeds) falls back to seed 0.
  // Write basin ids back into the raster, recording only genuine changes.
  const acc = newAccum()
  const newIdSet = new Set<number>()
  for (let ly = 0; ly < bh; ly++) {
    const gy = ly + 1
    const py = ly + by0
    const dstRow = py * w
    for (let lx = 0; lx < bw; lx++) {
      const g = (gy) * gw + (lx + 1)
      if (cell[g] !== 1) continue
      const bi = basin[g]
      const seedIdx = bi > 0 ? bi - 1 : 0
      const newVal = (seeds[seedIdx]?.id ?? cellId) >>> 0
      const px = lx + bx0
      const i = dstRow + px
      const old = mask[i]
      if (old === newVal) continue
      mask[i] = newVal
      record(acc, i, old, px, py)
      if (newVal !== cellId) newIdSet.add(newVal)
    }
  }
  return { ...finalize(acc), newIds: [...newIdSet] }
}

/** A tiny binary min-heap keyed by (priority, insertion-counter) for a deterministic flood order. */
class MinHeap {
  private pri: number[] = []
  private cnt: number[] = []
  private val: number[] = []

  get size(): number {
    return this.val.length
  }

  private less(a: number, b: number): boolean {
    return this.pri[a] < this.pri[b] || (this.pri[a] === this.pri[b] && this.cnt[a] < this.cnt[b])
  }

  private swap(a: number, b: number): void {
    ;[this.pri[a], this.pri[b]] = [this.pri[b], this.pri[a]]
    ;[this.cnt[a], this.cnt[b]] = [this.cnt[b], this.cnt[a]]
    ;[this.val[a], this.val[b]] = [this.val[b], this.val[a]]
  }

  push(pri: number, cnt: number, val: number): void {
    this.pri.push(pri)
    this.cnt.push(cnt)
    this.val.push(val)
    let i = this.val.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const n = this.val.length
    const top = this.val[0]
    const lastPri = this.pri.pop() as number
    const lastCnt = this.cnt.pop() as number
    const lastVal = this.val.pop() as number
    if (n > 1) {
      this.pri[0] = lastPri
      this.cnt[0] = lastCnt
      this.val[0] = lastVal
      let i = 0
      const m = this.val.length
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let s = i
        if (l < m && this.less(l, s)) s = l
        if (r < m && this.less(r, s)) s = r
        if (s === i) break
        this.swap(i, s)
        i = s
      }
    }
    return top
  }
}

/** Re-export the read-only mask element type so callers can bridge to `labelMaskColor` helpers. */
export type { LabelMask }

// ── hierarchy-aware corrections (ITEM-10) ──────────────────────────────────────────────────────
//
// These wrap the pure pixel ops with a CONTAINMENT-PRESERVING tree delta so a mask correction is
// atomic over BOTH the pixels AND the object hierarchy (INV-10 / DEC-11). The base ops above are
// unchanged — a caller that passes no hierarchy context gets byte-identical behavior (TEST-A6).
// Mask objects are keyed by their (stringified) label id; each carries a ROI shape derived from a
// bbox (+ optional centroid) via `shapeOfMaskObject`.

/** The current mask-object hierarchy a correction operates over (label objects + their parents). */
export interface MaskHierarchyContext {
  /** the mask objects as hierarchy nodes (id = `String(labelId)`), with ROI shapes. */
  readonly objects: readonly HierObject[]
}

/** A pixel EditResult (or SplitResult) plus the atomic hierarchy delta it produced. */
export type EditResultWithHierarchy<T extends EditResult = EditResult> = T & {
  readonly hierarchyDelta: HierarchyDelta
}

/**
 * Split `cellId` (pixels) AND redistribute its children between the two halves by containment: a
 * child stays under `cellId` unless the fresh half's ROI clearly contains it (a straddler stays).
 * Returns the pixel `SplitResult` + the invertible hierarchy delta; undo restores both (apply the
 * pixel undoAtom AND `invertHierarchyDelta(parentMap, hierarchyDelta)`).
 */
export function applySplitWithHierarchy(
  mask: LabelRaster,
  w: number,
  h: number,
  op: SplitOp,
  ctx: MaskHierarchyContext,
): EditResultWithHierarchy<SplitResult> {
  const res = applySplit(mask, w, h, op)
  if (res.newIds.length === 0) return { ...res, hierarchyDelta: EMPTY_HIERARCHY_DELTA }
  const originalKey = String(op.cellId >>> 0)
  const newKey = String(res.newIds[0] >>> 0)
  // Post-split ROIs of the two halves, derived from the freshly-repartitioned raster.
  const origBox = bboxOfId(mask, w, h, op.cellId >>> 0)
  const newBox = bboxOfId(mask, w, h, res.newIds[0] >>> 0)
  const origShape = shapeOfMaskObject(isEmptyRect(origBox) ? [0, 0, -1, -1] : origBox)
  const newShape = shapeOfMaskObject(isEmptyRect(newBox) ? [0, 0, -1, -1] : newBox)
  const hierarchyDelta = splitPreserveChildren(ctx.objects, originalKey, newKey, origShape, newShape)
  return { ...res, hierarchyDelta }
}

/**
 * Merge `from`→`to` (pixels) AND union `from`'s children under the survivor `to`. Returns the pixel
 * EditResult + the invertible hierarchy delta (undo restores both).
 */
export function applyMergeWithHierarchy(
  mask: LabelRaster,
  w: number,
  h: number,
  op: MergeOp,
  ctx: MaskHierarchyContext,
): EditResultWithHierarchy {
  const res = applyMerge(mask, w, h, op)
  const hierarchyDelta = mergePreserveChildren(ctx.objects, String(op.from >>> 0), String(op.to >>> 0))
  return { ...res, hierarchyDelta }
}

/**
 * Relabel `id` (LUT, no pixels) AND re-resolve the parentage of ONLY the affected object (a class /
 * level change can move an object under a different containing parent). Returns the LUT EditResult +
 * the invertible hierarchy delta.
 */
export function applyRelabelWithHierarchy(
  categoryForId: Uint16Array,
  id: number,
  newCategory: number,
  ctx: MaskHierarchyContext,
): EditResultWithHierarchy {
  const res = applyRelabel(categoryForId, id, newCategory)
  const hierarchyDelta = reresolveParentage(ctx.objects, [String(id >>> 0)])
  return { ...res, hierarchyDelta }
}
