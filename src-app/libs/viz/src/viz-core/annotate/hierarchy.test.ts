// hierarchy.test.ts — INV-10 acceptance + ITEM-8/10 unit (TEST-10, TEST-A10).
import { describe, it, expect } from 'vitest'
import type { Annotation, AnnotationCollection } from './annotateModel'
import {
  buildForest,
  childIdsOf,
  descendantsOf,
  isAncestorOrSelf,
  reparent,
  resolveHierarchy,
  resolveDelta,
  splitPreserveChildren,
  mergePreserveChildren,
  reresolveParentage,
  applyHierarchyDelta,
  invertHierarchyDelta,
  hierObjectsFromAnnotations,
  shapeOfAnnotation,
  shapeOfMaskObject,
  type HierObject,
  type HierId,
} from './hierarchy'
import { exportGeoJson, importGeoJson } from './geojson'

// A square polygon annotation covering [x0,y0]-[x1,y1] in full-res px.
function poly(id: string, x0: number, y0: number, x1: number, y1: number, parentId: HierId | null = null, level?: string): Annotation {
  return {
    id,
    geometry: { kind: 'polygon', rings: [Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1)] },
    classId: null,
    label: null,
    ...(level !== undefined ? { level } : {}),
    ...(parentId !== null ? { parentId } : {}),
  }
}
function point(id: string, x: number, y: number, parentId: HierId | null = null): Annotation {
  return { id, geometry: { kind: 'point', xy: [x, y] }, classId: null, label: null, ...(parentId !== null ? { parentId } : {}) }
}
function collectionOf(anns: Annotation[]): AnnotationCollection {
  const byId: Record<string, Annotation> = {}
  for (const a of anns) byId[a.id] = a
  return { byId, ids: anns.map(a => a.id) }
}

describe('hierarchy — tree algebra (TEST-10)', () => {
  it('buildForest derives childIds + roots and descendantsOf is complete + order-stable', () => {
    const order = ['tissue', 'region', 'cellA', 'cellB']
    const parentOf = new Map<HierId, HierId | null>([
      ['tissue', null], ['region', 'tissue'], ['cellA', 'region'], ['cellB', 'region'],
    ])
    const f = buildForest(order, parentOf)
    expect(f.roots).toEqual(['tissue'])
    expect(childIdsOf(f, 'tissue')).toEqual(['region'])
    expect(childIdsOf(f, 'region')).toEqual(['cellA', 'cellB'])
    expect(descendantsOf(f, 'tissue')).toEqual(['region', 'cellA', 'cellB'])
    expect(descendantsOf(f, 'cellA')).toEqual([])
  })

  it('reparent onto a descendant is rejected (no cycle); a valid reparent yields a delta', () => {
    const objs: HierObject[] = [
      { id: 'a', parentId: null, shape: shapeOfMaskObject([0, 0, 100, 100]) },
      { id: 'b', parentId: 'a', shape: shapeOfMaskObject([10, 10, 50, 50]) },
      { id: 'c', parentId: 'b', shape: shapeOfMaskObject([15, 15, 25, 25]) },
    ]
    expect(reparent(objs, 'a', 'c').changes).toEqual([]) // a under its own descendant → rejected
    const d = reparent(objs, 'c', 'a')
    expect(d.changes).toEqual([{ id: 'c', oldParent: 'b', newParent: 'a' }])
    // no-op reparent (same parent) → empty
    expect(reparent(objs, 'b', 'a').changes).toEqual([])
  })

  it('isAncestorOrSelf walks parent links and never loops on a malformed map', () => {
    const p = new Map<HierId, HierId | null>([['x', null], ['y', 'x'], ['z', 'y']])
    expect(isAncestorOrSelf(p, 'z', 'x')).toBe(true)
    expect(isAncestorOrSelf(p, 'z', 'z')).toBe(true)
    expect(isAncestorOrSelf(p, 'x', 'z')).toBe(false)
  })
})

describe('hierarchy — resolve keeps a single-parent forest (INV-10 fuzz, TEST-A10)', () => {
  it('a fuzz of nested random squares never produces a cycle or multi-parent', () => {
    let seed = 12345
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let trial = 0; trial < 40; trial++) {
      const anns: Annotation[] = []
      for (let i = 0; i < 25; i++) {
        const s = 4 + Math.floor(rand() * 90)
        const x = Math.floor(rand() * (100 - s))
        const y = Math.floor(rand() * (100 - s))
        anns.push(poly(`o${i}`, x, y, x + s, y + s))
      }
      const objs = anns.map(a => ({ id: a.id, parentId: null, shape: shapeOfAnnotation(a) }))
      const resolved = resolveHierarchy(objs)
      // every object has ≤1 parent (a Map guarantees it) and NO cycle:
      for (const o of objs) {
        const seen = new Set<HierId>()
        let cur: HierId | null = o.id
        while (cur != null) {
          expect(seen.has(cur)).toBe(false)
          seen.add(cur)
          cur = resolved.get(cur) ?? null
        }
      }
    }
  })
})

describe('hierarchy — QuPath dual containment (TEST-A10)', () => {
  it('an area ROI parents under the SMALLEST fully-containing object; a point by centroid', () => {
    const tissue = poly('tissue', 0, 0, 100, 100)
    const region = poly('region', 10, 10, 60, 60)
    const cell = poly('cell', 20, 20, 30, 30)
    const dot = point('dot', 25, 25)
    const resolved = resolveHierarchy(
      [tissue, region, cell, dot].map(a => ({ id: a.id, parentId: null, shape: shapeOfAnnotation(a) })),
    )
    expect(resolved.get('tissue')).toBeNull()
    expect(resolved.get('region')).toBe('tissue')
    expect(resolved.get('cell')).toBe('region') // smallest containing, not tissue
    expect(resolved.get('dot')).toBe('cell') // centroid inside the smallest
  })

  it('an object contained by none is a root; resolve is idempotent', () => {
    const a = poly('a', 0, 0, 10, 10)
    const b = poly('b', 50, 50, 60, 60)
    const objs = [a, b].map(x => ({ id: x.id, parentId: null, shape: shapeOfAnnotation(x) }))
    const r1 = resolveHierarchy(objs)
    expect(r1.get('a')).toBeNull()
    expect(r1.get('b')).toBeNull()
    // running again over the resolved parents reproduces the same map (idempotent)
    const objs2 = objs.map(o => ({ ...o, parentId: r1.get(o.id) ?? null }))
    const r2 = resolveHierarchy(objs2)
    expect([...r2.entries()]).toEqual([...r1.entries()])
  })
})

describe('hierarchy — containment-preserving split/merge as ONE undo atom (TEST-A10)', () => {
  it('split redistributes children to the containing half; a straddler stays; delta inverts', () => {
    // parent "cell" [0,0]-[20,20]; children: left [2,2]-[6,6], right [14,14]-[18,18].
    const objs: HierObject[] = [
      { id: 'cell', parentId: null, shape: shapeOfMaskObject([0, 0, 20, 20]) },
      { id: 'left', parentId: 'cell', shape: shapeOfMaskObject([2, 2, 6, 6]) },
      { id: 'right', parentId: 'cell', shape: shapeOfMaskObject([14, 14, 18, 18]) },
    ]
    const origHalf = shapeOfMaskObject([0, 0, 9, 20]) // left half keeps "cell"
    const newHalf = shapeOfMaskObject([10, 0, 20, 20]) // right half → "cellNew"
    const delta = splitPreserveChildren(objs, 'cell', 'cellNew', origHalf, newHalf)
    expect(delta.changes).toEqual([{ id: 'right', oldParent: 'cell', newParent: 'cellNew' }])
    // apply → invert restores
    const parentMap = new Map<HierId, HierId | null>(objs.map(o => [o.id, o.parentId]))
    applyHierarchyDelta(parentMap, delta)
    expect(parentMap.get('right')).toBe('cellNew')
    expect(parentMap.get('left')).toBe('cell')
    invertHierarchyDelta(parentMap, delta)
    expect(parentMap.get('right')).toBe('cell')
  })

  it('merge unions children under the survivor; relabel re-resolves only the affected object', () => {
    const objs: HierObject[] = [
      { id: 'A', parentId: null, shape: shapeOfMaskObject([0, 0, 50, 50]) },
      { id: 'B', parentId: null, shape: shapeOfMaskObject([60, 0, 100, 50]) },
      { id: 'a1', parentId: 'A', shape: shapeOfMaskObject([5, 5, 10, 10]) },
      { id: 'b1', parentId: 'B', shape: shapeOfMaskObject([65, 5, 70, 10]) },
    ]
    const merge = mergePreserveChildren(objs, 'B', 'A')
    expect(merge.changes).toEqual([{ id: 'b1', oldParent: 'B', newParent: 'A' }])
    // reresolve of an unaffected id → no change
    expect(reresolveParentage(objs, ['a1']).changes).toEqual([])
  })
})

describe('hierarchy — GeoJSON tree round-trip (TEST-A10 / INV-7+INV-10)', () => {
  it('a 3-level tree survives export→import with parent links + levels intact', () => {
    const anns = [
      poly('tissue', 0, 0, 100, 100, null, 'tissue'),
      poly('region', 10, 10, 60, 60, 'tissue', 'region'),
      poly('cell', 20, 20, 30, 30, 'region', 'cell'),
    ]
    const fc = exportGeoJson(anns, [])
    const back = importGeoJson(fc)
    const byId = new Map(back.annotations.map(a => [a.id, a]))
    expect(byId.get('region')?.parentId).toBe('tissue')
    expect(byId.get('cell')?.parentId).toBe('region')
    expect(byId.get('cell')?.level).toBe('cell')
    expect(byId.get('tissue')?.parentId ?? null).toBeNull()
  })
})

describe('hierarchy — collection bridge + resolveDelta', () => {
  it('resolveDelta reflects only the parents that change from the current collection', () => {
    const coll = collectionOf([
      poly('t', 0, 0, 100, 100),
      poly('r', 10, 10, 60, 60), // currently root; resolve → child of t
    ])
    const delta = resolveDelta(hierObjectsFromAnnotations(coll))
    expect(delta.changes).toEqual([{ id: 'r', oldParent: null, newParent: 't' }])
  })
})

describe('hierarchy — merge self-parent/cycle guard (blind-audit M3, INV-10)', () => {
  it('merging a parent INTO its own child does not emit a self-parent', () => {
    const objs: HierObject[] = [
      { id: 'P', parentId: null, shape: shapeOfMaskObject([0, 0, 100, 100]) },
      { id: 'C', parentId: 'P', shape: shapeOfMaskObject([10, 10, 40, 40]) },
    ]
    // dissolve P into survivor C: the old code emitted {id:'C', oldParent:'P', newParent:'C'} (self).
    const merge = mergePreserveChildren(objs, 'P', 'C')
    expect(merge.changes.find(c => c.id === c.newParent)).toBeUndefined() // no self-parent
    expect(merge.changes).toEqual([]) // C is the survivor; nothing legitimately re-parents
  })

  it('merging a grandparent into a grandchild does not create a cycle', () => {
    const objs: HierObject[] = [
      { id: 'P', parentId: null, shape: shapeOfMaskObject([0, 0, 100, 100]) },
      { id: 'M', parentId: 'P', shape: shapeOfMaskObject([5, 5, 80, 80]) },
      { id: 'C', parentId: 'M', shape: shapeOfMaskObject([10, 10, 40, 40]) },
    ]
    // dissolve P into survivor C: M (child of P) must NOT re-parent to C — C is under M ⇒ would cycle.
    const merge = mergePreserveChildren(objs, 'P', 'C')
    expect(merge.changes.some(c => c.id === 'M' && c.newParent === 'C')).toBe(false)
  })
})
