// resolveHierarchy.test.ts — ITEM-9 dual-containment resolve (TEST-11).
import { describe, it, expect } from 'vitest'
import type { Annotation } from './annotateModel'
import { resolveHierarchy, shapeOfAnnotation, type HierId } from './hierarchy'

function poly(id: string, x0: number, y0: number, x1: number, y1: number): Annotation {
  return { id, geometry: { kind: 'polygon', rings: [Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1)] }, classId: null, label: null }
}
function point(id: string, x: number, y: number): Annotation {
  return { id, geometry: { kind: 'point', xy: [x, y] }, classId: null, label: null }
}
const objs = (anns: Annotation[]) => anns.map(a => ({ id: a.id, parentId: null as HierId | null, shape: shapeOfAnnotation(a) }))

describe('resolveHierarchy — QuPath dual containment (TEST-11)', () => {
  it('nested regions produce the expected multi-level tree (smallest fully-containing parent)', () => {
    const r = resolveHierarchy(objs([
      poly('L0', 0, 0, 100, 100),
      poly('L1', 5, 5, 80, 80),
      poly('L2', 10, 10, 40, 40),
      poly('L3', 12, 12, 20, 20),
    ]))
    expect(r.get('L0')).toBeNull()
    expect(r.get('L1')).toBe('L0')
    expect(r.get('L2')).toBe('L1')
    expect(r.get('L3')).toBe('L2')
  })

  it('a point parents by CENTROID containment', () => {
    const r = resolveHierarchy(objs([
      poly('big', 0, 0, 100, 100),
      poly('small', 10, 10, 30, 30),
      point('p', 20, 20), // inside small
      point('q', 50, 50), // inside big only
    ]))
    expect(r.get('p')).toBe('small')
    expect(r.get('q')).toBe('big')
  })

  it('an object contained by none → root', () => {
    const r = resolveHierarchy(objs([poly('a', 0, 0, 10, 10), poly('b', 90, 90, 100, 100)]))
    expect(r.get('a')).toBeNull()
    expect(r.get('b')).toBeNull()
  })

  it('is deterministic + idempotent (running twice reproduces the same map)', () => {
    const source = objs([poly('big', 0, 0, 100, 100), poly('mid', 10, 10, 60, 60), poly('sm', 20, 20, 30, 30)])
    const r1 = resolveHierarchy(source)
    const r2 = resolveHierarchy(source.map(o => ({ ...o, parentId: r1.get(o.id) ?? null })))
    expect([...r2.entries()].sort()).toEqual([...r1.entries()].sort())
  })

  it('a partially-overlapping (not fully-contained) ROI is NOT parented', () => {
    // "half" straddles big's edge — its top-left corner is outside big.
    const r = resolveHierarchy(objs([poly('big', 20, 20, 100, 100), poly('half', 0, 0, 40, 40)]))
    expect(r.get('half')).toBeNull()
  })
})
