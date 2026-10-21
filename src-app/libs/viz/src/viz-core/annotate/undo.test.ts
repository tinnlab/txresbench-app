// undo.test.ts — TEST-8 (ITEM-6). Node env. Undo/redo over the per-cell store's Immer
// `produceWithPatches` history:
//   • create / reshape / delete / relabel each undo+redo correctly (deep-equal geometry;
//     delete restores object + class + selection),
//   • a drag of N moves then release = EXACTLY ONE undo entry (the store is untouched during
//     the move; the editor commits once — mimicked here with the pure translate op),
//   • the bounded stack drops the oldest entry and keeps the redo pointer.

import { describe, it, expect } from 'vitest'
import { createAnnotateStore, MAX_HISTORY } from './Annotate.store'
import { translateAnnotation } from './annotationGestures'
import type { PolygonGeometry } from './annotateModel'

function poly(x = 0, y = 0): PolygonGeometry {
  return { kind: 'polygon', rings: [Float64Array.from([x, y, x + 10, y, x + 10, y + 10, x, y + 10])] }
}

describe('undo/redo — per-op correctness', () => {
  it('create → undo removes, redo restores', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: poly() })
    expect(s.getState().ids).toEqual([id])
    expect(s.getState().canUndo).toBe(true)

    s.getState().undo()
    expect(s.getState().ids).toEqual([])
    expect(s.getState().byId[id]).toBeUndefined()
    expect(s.getState().canRedo).toBe(true)

    s.getState().redo()
    expect(s.getState().ids).toEqual([id])
    expect(s.getState().byId[id].geometry).toEqual(poly())
  })

  it('reshape → undo/redo round-trips geometry (deep-equal)', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: poly() })
    const g0 = s.getState().byId[id].geometry
    const g1 = poly(50, 50)

    s.getState().reshape(id, g1)
    expect(s.getState().byId[id].geometry).toEqual(g1)

    s.getState().undo()
    expect(s.getState().byId[id].geometry).toEqual(g0)

    s.getState().redo()
    expect(s.getState().byId[id].geometry).toEqual(g1)
  })

  it('delete → undo restores object + class + selection', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: poly(), classId: 'c1', label: 'lesion' })
    s.getState().select([id])
    expect(s.getState().selection.has(id)).toBe(true)

    s.getState().delete(id)
    expect(s.getState().byId[id]).toBeUndefined()
    expect(s.getState().selection.has(id)).toBe(false)

    s.getState().undo()
    expect(s.getState().byId[id]).toBeDefined()
    expect(s.getState().byId[id].classId).toBe('c1') // class restored
    expect(s.getState().byId[id].label).toBe('lesion')
    expect(s.getState().selection.has(id)).toBe(true) // selection restored

    s.getState().redo()
    expect(s.getState().byId[id]).toBeUndefined()
    expect(s.getState().selection.has(id)).toBe(false)
  })

  it('relabel → undo/redo round-trips class + label', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: poly(), label: 'a', classId: null })
    s.getState().relabel(id, { label: 'b', classId: 'c2' })
    expect(s.getState().byId[id].label).toBe('b')
    expect(s.getState().byId[id].classId).toBe('c2')

    s.getState().undo()
    expect(s.getState().byId[id].label).toBe('a')
    expect(s.getState().byId[id].classId).toBeNull()

    s.getState().redo()
    expect(s.getState().byId[id].label).toBe('b')
    expect(s.getState().byId[id].classId).toBe('c2')
  })
})

describe('undo/redo — drag coalescing (commit-once)', () => {
  it('N moves then release = exactly ONE undo entry; store untouched during the move', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: poly() })
    const depthAfterAdd = s.getState().undoStack.length // 1

    // Simulate a drag: compute N intermediate geometries locally (as the editor's useRef does)
    // WITHOUT writing to the store — the store must be untouched throughout the move.
    let moved = s.getState().byId[id]
    for (let i = 0; i < 10; i++) moved = translateAnnotation(moved, 1, 0)
    expect(s.getState().undoStack.length).toBe(depthAfterAdd) // no writes during the move

    // Commit ONCE on pointer-up.
    s.getState().reshape(id, moved.geometry)
    expect(s.getState().undoStack.length).toBe(depthAfterAdd + 1) // exactly one new entry

    // And that single entry reverts the whole drag.
    s.getState().undo()
    expect(s.getState().byId[id].geometry).toEqual(poly())
  })
})

describe('undo/redo — bounded history', () => {
  it('drops the oldest entry past the cap and keeps the redo pointer', () => {
    const s = createAnnotateStore()
    for (let i = 0; i < MAX_HISTORY + 5; i++) s.getState().add({ geometry: poly(i, i) })

    // capped (oldest dropped), while every annotation is still present
    expect(s.getState().undoStack.length).toBe(MAX_HISTORY)
    expect(s.getState().ids.length).toBe(MAX_HISTORY + 5)

    // undo keeps a live redo pointer
    s.getState().undo()
    expect(s.getState().redoStack.length).toBe(1)
    expect(s.getState().canRedo).toBe(true)
    s.getState().redo()
    expect(s.getState().redoStack.length).toBe(0)
    expect(s.getState().canRedo).toBe(false)
  })
})
