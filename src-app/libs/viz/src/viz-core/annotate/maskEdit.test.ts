// maskEdit.test.ts — TEST-A6 (correction acceptance) + TEST-11 (dirty-rect tightness) for the
// PURE mask-correction core. Oracle-style, mirroring `labelMaskColor.test.ts`: exercise brush /
// relabel / merge / split against synthetic rasters and the shared blob fixture, and assert the
// two load-bearing invariants on EVERY op — (1) `dirtyRect` tightly bounds the changed pixels and
// nothing outside it moved (the gigapixel-safety invariant), and (2) `undoAtom` restores the
// raster byte-for-byte.

import { describe, it, expect } from 'vitest'
import {
  applyBrush,
  applyRelabel,
  applyMerge,
  applySplit,
  applyUndoAtom,
  bboxOfId,
  nextLabelId,
  isEmptyRect,
  type DirtyRect,
  type LabelRaster,
} from './maskEdit'
import { boundaryMask } from '../spatial/labelMaskColor'
import { makeLabelMaskFixture } from '../spatial/labelMaskFixture'

// ── oracle helpers ─────────────────────────────────────────────────────────────────────────

/** The actual tight bbox of pixels that differ between two rasters (EMPTY if identical). */
function diffBBox(before: LabelRaster, after: LabelRaster, w: number, h: number): DirtyRect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (before[i] === after[i]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX) return [0, 0, -1, -1]
  return [minX, minY, maxX, maxY]
}

/**
 * The core dirty-rect contract: the op's reported `dirtyRect` equals the ACTUAL bbox of changed
 * pixels (tight, TEST-11) AND no pixel outside `dirtyRect` changed (the sub-upload safety net).
 */
function expectDirtyRectTight(
  before: LabelRaster,
  after: LabelRaster,
  w: number,
  h: number,
  dirtyRect: DirtyRect,
): void {
  const actual = diffBBox(before, after, w, h)
  expect(dirtyRect).toEqual(actual)
  // Belt-and-braces: explicitly assert every out-of-rect pixel is byte-identical.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= dirtyRect[0] && x <= dirtyRect[2] && y >= dirtyRect[1] && y <= dirtyRect[3]
      if (inside) continue
      const i = y * w + x
      expect(after[i]).toBe(before[i])
    }
  }
}

/** A solid rectangular cell of `id` on a background raster. */
function solidCell(
  w: number,
  h: number,
  id: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
): LabelRaster {
  const m = new Uint32Array(w * h)
  for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) m[y * w + x] = id
  return m
}

// ── applyBrush ───────────────────────────────────────────────────────────────────────────────

describe('applyBrush — paint a filled disk (TEST-A6 brush-fix + TEST-11 dirty-rect)', () => {
  const w = 24
  const h = 24
  const cx = 12
  const cy = 12
  const r = 5
  const id = 7

  it('every pixel inside the disk == id; every pixel outside dirtyRect is byte-identical', () => {
    const before = new Uint32Array(w * h) // all background
    const mask = before.slice()
    const res = applyBrush(mask, w, h, { x: cx, y: cy, r, id })

    // Disk pixels are all painted; pixels just outside the radius are untouched.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inDisk = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
        expect(mask[y * w + x]).toBe(inDisk ? id : 0)
      }
    }
    expectDirtyRectTight(before, mask, w, h, res.dirtyRect)
  })

  it('undoAtom restores the raster byte-for-byte', () => {
    // Paint over a non-trivial existing raster so undo has real old values to restore.
    const before = solidCell(w, h, 3, 8, 8, 15, 15)
    const mask = before.slice()
    const res = applyBrush(mask, w, h, { x: cx, y: cy, r, id })
    expect(isEmptyRect(res.dirtyRect)).toBe(false)
    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
  })

  it('painting the same id over existing pixels changes nothing (EMPTY dirtyRect)', () => {
    const before = solidCell(w, h, id, 8, 8, 16, 16)
    const mask = before.slice()
    const res = applyBrush(mask, w, h, { x: cx, y: cy, r: 2, id }) // fully inside the solid cell
    expect(isEmptyRect(res.dirtyRect)).toBe(true)
    expect(res.undoAtom.indices.length).toBe(0)
    expect(mask).toEqual(before)
  })
})

// ── applyRelabel ───────────────────────────────────────────────────────────────────────────

describe('applyRelabel — id→category LUT edit, no pixels (TEST-A6 relabel)', () => {
  it('changes only categoryForId[id]; dirtyRect empty; undo restores the category', () => {
    const categoryForId = Uint16Array.from([0, 1, 2, 3, 4])
    const before = categoryForId.slice()
    const res = applyRelabel(categoryForId, 3, 0)

    expect(categoryForId[3]).toBe(0)
    expect(isEmptyRect(res.dirtyRect)).toBe(true) // no pixel touched
    // Every OTHER category is untouched.
    for (let id = 0; id < categoryForId.length; id++) {
      if (id !== 3) expect(categoryForId[id]).toBe(before[id])
    }
    // The undo atom targets the categoryForId array (generic applyUndoAtom).
    applyUndoAtom(categoryForId, res.undoAtom)
    expect(categoryForId).toEqual(before)
  })
})

// ── applyMerge ─────────────────────────────────────────────────────────────────────────────

describe('applyMerge — rewrite B→A over bbox(B) (TEST-A6 merge + TEST-11 dirty-rect)', () => {
  it('no B pixels remain over bbox(B) (all == A); B is cleared from categoryForId', () => {
    const fx = makeLabelMaskFixture({ seed: 11, width: 96, height: 96, labelCount: 24 })
    const w = fx.width
    const h = fx.height
    const before = Uint32Array.from(fx.labelMask)
    const mask = before.slice()
    const categoryForId = fx.categoryForId.slice()

    const A = 1
    const B = 2
    const boxB = bboxOfId(before, w, h, B)
    expect(isEmptyRect(boxB)).toBe(false) // both blobs exist in this fixture

    const res = applyMerge(mask, w, h, { from: B, to: A, categoryForId, bbox: boxB })

    // Not a single B pixel survives anywhere; every former-B pixel is now A.
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i]).not.toBe(B)
      if (before[i] === B) expect(mask[i]).toBe(A)
    }
    // B no longer labels any pixel → its category slot is cleared.
    expect(categoryForId[B]).toBe(0)
    // dirtyRect is exactly bbox(B) (every B pixel changed) and tightly bounds the diff.
    expect(res.dirtyRect).toEqual(boxB)
    expectDirtyRectTight(before, mask, w, h, res.dirtyRect)
  })

  it('undoAtom restores the raster byte-for-byte', () => {
    const fx = makeLabelMaskFixture({ seed: 3, width: 80, height: 80, labelCount: 20 })
    const w = fx.width
    const h = fx.height
    const before = Uint32Array.from(fx.labelMask)
    const mask = before.slice()
    const res = applyMerge(mask, w, h, { from: 4, to: 1 })
    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
  })

  it('merging an id into ITSELF (from === to) is a true no-op — EMPTY rect + EMPTY undo', () => {
    const w = 16
    const h = 16
    const before = solidCell(w, h, 5, 3, 3, 10, 10)
    const mask = before.slice()
    const categoryForId = Uint16Array.from([0, 0, 0, 0, 0, 9]) // categoryForId[5] = 9
    const res = applyMerge(mask, w, h, { from: 5, to: 5, categoryForId })

    // Nothing changed anywhere.
    expect(isEmptyRect(res.dirtyRect)).toBe(true)
    expect(res.undoAtom.indices.length).toBe(0)
    expect(res.undoAtom.oldValues.length).toBe(0)
    expect(mask).toEqual(before)
    // The category MUST NOT be cleared — the id still labels its pixels.
    expect(categoryForId[5]).toBe(9)
  })
})

// ── nextLabelId / split overflow guard (2^32 wrap) ─────────────────────────────────────────────

describe('nextLabelId — never wraps to 0 at the Uint32 ceiling (audit finding 3)', () => {
  const MAX = 0xffffffff

  it('normal case returns max id + 1', () => {
    const mask = Uint32Array.of(0, 3, 7, 2)
    expect(nextLabelId(mask)).toBe(8)
  })

  it('a raster already using the max Uint32 id returns a safe fresh id, NOT 0', () => {
    const mask = Uint32Array.of(0, MAX, 0, 2) // ids in use: {0, 2, MAX}
    const id = nextLabelId(mask)
    expect(id).not.toBe(0) // background must never be handed out as a fresh label
    expect(id).toBe(1) // smallest unused positive id
  })

  it('applySplit picks a non-background fresh id when the cell uses the max id', () => {
    const w = 8
    const h = 8
    const cellId = MAX
    const before = solidCell(w, h, cellId, 1, 1, 6, 6)
    const mask = before.slice()
    // default newId would be nextLabelId(mask) — must not wrap to 0.
    const res = applySplit(mask, w, h, { cellId, cutLine: { x0: 1, y0: 3, x1: 6, y1: 3 } })
    expect(res.newIds.length).toBe(1)
    expect(res.newIds[0]).not.toBe(0)
    expect(res.newIds[0]).not.toBe(cellId)
    // The cut half really carries that fresh id (no background erasure).
    const ids = new Set<number>()
    for (const v of mask) if (v !== 0) ids.add(v)
    expect(ids).toEqual(new Set([cellId, res.newIds[0]]))
    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
  })
})

// ── applySplit ─────────────────────────────────────────────────────────────────────────────

describe('applySplit — a fresh id + a new boundary seam (TEST-A6 split + TEST-11 dirty-rect)', () => {
  it('cutLine: two distinct ids, a boundary seam appears, undo restores, dirtyRect tight', () => {
    const w = 20
    const h = 20
    const cellId = 5
    const before = solidCell(w, h, cellId, 4, 4, 15, 15) // a 12×12 solid cell
    const mask = before.slice()

    // Horizontal cut through the vertical middle (rows > 11 get the new id).
    const newId = nextLabelId(before) // 6 (max id 5 + 1)
    const res = applySplit(mask, w, h, {
      cellId,
      cutLine: { x0: 4, y0: 11, x1: 15, y1: 11 },
    })

    expect(res.newIds).toEqual([newId])

    // Two distinct non-background ids now partition the former cell.
    const ids = new Set<number>()
    for (const v of mask) if (v !== 0) ids.add(v)
    expect(ids).toEqual(new Set([cellId, newId]))

    // A brand-new internal seam exists: some cellId pixel is 4-adjacent to a newId pixel, and
    // `boundaryMask` (the shared shader oracle) marks that contested frontier.
    const bm = boundaryMask(mask, w, h)
    let seamFound = false
    for (let y = 0; y < h && !seamFound; y++) {
      for (let x = 0; x < w && !seamFound; x++) {
        const i = y * w + x
        if (mask[i] !== cellId) continue
        const nbrs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
        if (nbrs.some(n => n >= 0 && mask[n] === newId)) {
          expect(bm[i]).toBe(1) // the seam pixel is flagged a boundary
          seamFound = true
        }
      }
    }
    expect(seamFound).toBe(true)

    expectDirtyRectTight(before, mask, w, h, res.dirtyRect)

    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
  })

  it('seeds: marker-controlled watershed splits a dumbbell at its neck', () => {
    // A dumbbell cell: two 5×5 lobes joined by a 1px neck. The DT-watershed dam should form at
    // the neck, so each lobe becomes its own seed's id.
    const w = 24
    const h = 12
    const cellId = 9
    const mask = new Uint32Array(w * h)
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = cellId
    }
    fill(3, 3, 7, 7) // left lobe (center 5,5)
    fill(15, 3, 19, 7) // right lobe (center 17,5)
    mask[5 * w + 11] = cellId // neck row
    for (let x = 8; x <= 14; x++) mask[5 * w + x] = cellId // 1px neck bridging the lobes
    const before = mask.slice()

    const newId = 10
    const res = applySplit(mask, w, h, {
      cellId,
      seeds: [
        { x: 5, y: 5, id: cellId }, // left lobe keeps cellId
        { x: 17, y: 5, id: newId }, // right lobe → newId
      ],
    })

    expect(res.newIds).toEqual([newId])
    // Each seed pixel carries its own id; both ids partition the cell.
    expect(mask[5 * w + 5]).toBe(cellId)
    expect(mask[5 * w + 17]).toBe(newId)
    const ids = new Set<number>()
    for (const v of mask) if (v !== 0) ids.add(v)
    expect(ids).toEqual(new Set([cellId, newId]))
    // The left lobe interior stays cellId; the right lobe interior is newId (dam at the neck).
    expect(mask[5 * w + 4]).toBe(cellId)
    expect(mask[5 * w + 18]).toBe(newId)

    // A new seam appears between the two basins, and undo is byte-exact; dirtyRect stays tight.
    const bm = boundaryMask(mask, w, h)
    expect(bm.some(v => v === 1)).toBe(true)
    expectDirtyRectTight(before, mask, w, h, res.dirtyRect)
    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
  })

  it('splitting a non-existent cell is a no-op (EMPTY dirtyRect, no new ids)', () => {
    const w = 10
    const h = 10
    const before = new Uint32Array(w * h)
    const mask = before.slice()
    const res = applySplit(mask, w, h, { cellId: 99, cutLine: { x0: 0, y0: 5, x1: 9, y1: 5 } })
    expect(res.newIds).toEqual([])
    expect(isEmptyRect(res.dirtyRect)).toBe(true)
    expect(mask).toEqual(before)
  })
})

// ── ITEM-10: hierarchy-aware corrections (TEST-12) + back-compat (TEST-A6 extension) ──────────
import {
  applySplitWithHierarchy,
  applyMergeWithHierarchy,
  applyRelabelWithHierarchy,
} from './maskEdit'
import { shapeOfMaskObject, invertHierarchyDelta, type HierObject, type HierId } from './hierarchy'

describe('maskEdit — containment-preserving corrections (TEST-12)', () => {
  it('applySplitWithHierarchy redistributes children to the containing half; undo restores BOTH', () => {
    // 20×10 raster, cell id 5 fills the left 0..9 columns; a vertical cut at x=5 splits off a new id.
    const w = 20, h = 10
    const mask = new Uint32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) mask[y * w + x] = 5
    const before = mask.slice()
    // children of cell 5: "leftChild" near x=2 (stays), "rightChild" near x=8 (moves to new half)
    const objects: HierObject[] = [
      { id: '5', parentId: null, shape: shapeOfMaskObject([0, 0, 9, 9]) },
      { id: 'leftChild', parentId: '5', shape: shapeOfMaskObject([1, 1, 3, 3]) },
      { id: 'rightChild', parentId: '5', shape: shapeOfMaskObject([6, 6, 8, 8]) },
    ]
    // vertical cut at x=5 (downward dir): the LEFT columns (0..4) get the fresh id; right stays 5.
    const res = applySplitWithHierarchy(mask, w, h, { cellId: 5, cutLine: { x0: 5, y0: 0, x1: 5, y1: 10 }, newId: 9 }, { objects })
    expect(res.newIds).toEqual([9])
    // leftChild is in the new (left) half → reassigned; rightChild stays under 5.
    expect(res.hierarchyDelta.changes).toEqual([{ id: 'leftChild', oldParent: '5', newParent: '9' }])
    // atomic undo: pixels revert AND the tree delta inverts
    applyUndoAtom(mask, res.undoAtom)
    expect(mask).toEqual(before)
    // forward the tree delta, then invert — parentage restores to the pre-split state:
    const parentMap = new Map<HierId, HierId | null>(objects.map(o => [o.id, o.parentId]))
    parentMap.set('leftChild', '9')
    invertHierarchyDelta(parentMap, res.hierarchyDelta)
    expect(parentMap.get('leftChild')).toBe('5')
  })

  it('applyMergeWithHierarchy unions children of `from` under the survivor `to`', () => {
    const w = 12, h = 4
    const mask = new Uint32Array(w * h)
    for (let i = 0; i < w * h; i++) mask[i] = i % 12 < 6 ? 2 : 3
    const objects: HierObject[] = [
      { id: '2', parentId: null, shape: shapeOfMaskObject([0, 0, 5, 3]) },
      { id: '3', parentId: null, shape: shapeOfMaskObject([6, 0, 11, 3]) },
      { id: 'child3', parentId: '3', shape: shapeOfMaskObject([7, 1, 8, 2]) },
    ]
    const res = applyMergeWithHierarchy(mask, w, h, { from: 3, to: 2 }, { objects })
    expect(res.hierarchyDelta.changes).toEqual([{ id: 'child3', oldParent: '3', newParent: '2' }])
  })

  it('applyRelabelWithHierarchy re-resolves ONLY the affected object', () => {
    const cat = new Uint16Array(16)
    const objects: HierObject[] = [
      { id: '7', parentId: null, shape: shapeOfMaskObject([0, 0, 4, 4]) },
    ]
    const res = applyRelabelWithHierarchy(cat, 7, 3, { objects })
    expect(cat[7]).toBe(3)
    expect(res.hierarchyDelta.changes).toEqual([]) // no containing parent → no parentage change
  })

  it('base applySplit is byte-identical when no hierarchy context is passed (TEST-A6 back-compat)', () => {
    const w = 20, h = 4
    const mask = new Uint32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) mask[y * w + x] = 5
    const a = mask.slice()
    const b = mask.slice()
    const plain = applySplit(a, w, h, { cellId: 5, cutLine: { x0: 5, y0: 0, x1: 5, y1: 4 }, newId: 9 })
    const withH = applySplitWithHierarchy(b, w, h, { cellId: 5, cutLine: { x0: 5, y0: 0, x1: 5, y1: 4 }, newId: 9 }, { objects: [] })
    expect(a).toEqual(b) // same pixels
    expect(withH.dirtyRect).toEqual(plain.dirtyRect)
    expect(withH.newIds).toEqual(plain.newIds)
    expect('hierarchyDelta' in plain).toBe(false) // base op adds no hierarchy field
  })
})
