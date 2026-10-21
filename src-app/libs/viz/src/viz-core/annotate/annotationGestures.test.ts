// annotationGestures.test.ts (TEST-4) — correctness proof for the pure vector-edit core:
// per-vertex insert/move/delete produce the expected rings, topmost-feature hit-testing honors
// z-order, snap-to-vertex snaps only within threshold, and a <3-vertex draft is discarded.
// Node vitest, mirroring `regionSelect.test.ts`.

import { describe, it, expect } from 'vitest'
import {
  deleteVertex,
  finishPolygon,
  hitTestTopmostAnnotation,
  insertVertex,
  moveVertex,
  ringToPairs,
  snapToVertex,
  translateAnnotation,
  rubberBandPath,
  isPolygonCloseHit,
  isPolygonClosable,
  type Vec2,
} from './annotationGestures'
import { TOOL_VOCABULARY } from '../tools/vocabulary'
import { toolsForSurface } from '../tools/registry'
import type { Annotation, PolygonGeometry } from './annotateModel'
import { buildPointIndex } from '../spatial/pointIndex'

// A unit square exterior ring (4 vertices, CCW): (0,0)(10,0)(10,10)(0,10).
const SQUARE = (): PolygonGeometry => ({
  kind: 'polygon',
  rings: [new Float64Array([0, 0, 10, 0, 10, 10, 0, 10])],
})

const poly = (id: string, geom: PolygonGeometry): Annotation => ({
  id,
  geometry: geom,
  classId: null,
  label: null,
})

describe('per-vertex reshape', () => {
  it('moveVertex relocates exactly one vertex, leaving the rest byte-identical', () => {
    const out = moveVertex(SQUARE(), 0, 2, 99, 88)
    expect(Array.from(out.rings[0])).toEqual([0, 0, 10, 0, 99, 88, 0, 10])
  })

  it('moveVertex is a no-op for an out-of-range vertex or ring', () => {
    const g = SQUARE()
    expect(Array.from(moveVertex(g, 0, 9, 1, 1).rings[0])).toEqual(Array.from(g.rings[0]))
    expect(moveVertex(g, 5, 0, 1, 1)).toBe(g)
  })

  it('insertVertex splits the given edge, growing the ring by one vertex', () => {
    // insert at edge 0 (between v0 and v1) → new vertex lands at index 1
    const out = insertVertex(SQUARE(), 0, 0, 5, 0)
    expect(Array.from(out.rings[0])).toEqual([0, 0, 5, 0, 10, 0, 10, 10, 0, 10])
    expect(out.rings[0].length).toBe(10)
  })

  it('deleteVertex removes exactly one vertex when the ring stays valid (≥3)', () => {
    const out = deleteVertex(SQUARE(), 0, 1)
    expect(Array.from(out.rings[0])).toEqual([0, 0, 10, 10, 0, 10])
  })

  it('deleteVertex refuses to drop a ring below 3 vertices (would be degenerate)', () => {
    const tri: PolygonGeometry = { kind: 'polygon', rings: [new Float64Array([0, 0, 10, 0, 5, 8])] }
    expect(deleteVertex(tri, 0, 0)).toBe(tri)
  })

  it('an insert then a matching delete round-trips the ring', () => {
    const g = SQUARE()
    const grown = insertVertex(g, 0, 0, 5, 0)
    const back = deleteVertex(grown, 0, 1)
    expect(Array.from(back.rings[0])).toEqual(Array.from(g.rings[0]))
  })
})

describe('translateAnnotation', () => {
  it('shifts every vertex of a polygon by the delta', () => {
    const out = translateAnnotation(poly('a', SQUARE()), 3, -2)
    const g = out.geometry as PolygonGeometry
    expect(Array.from(g.rings[0])).toEqual([3, -2, 13, -2, 13, 8, 3, 8])
  })

  it('shifts a point geometry', () => {
    const p: Annotation = { id: 'p', geometry: { kind: 'point', xy: [4, 4] }, classId: null, label: null }
    const out = translateAnnotation(p, 1, 1)
    expect((out.geometry as { xy: readonly [number, number] }).xy).toEqual([5, 5])
  })
})

describe('hitTestTopmostAnnotation', () => {
  // two overlapping squares: A = [0..10]², B = [5..15]² (drawn later → on top).
  const A = poly('A', SQUARE())
  const B = poly('B', {
    kind: 'polygon',
    rings: [new Float64Array([5, 5, 15, 5, 15, 15, 5, 15])],
  })
  const list = [A, B]

  it('returns the topmost (last-drawn) feature in the overlap region', () => {
    expect(hitTestTopmostAnnotation(list, [7, 7])).toBe(1) // in both → B (index 1) wins
  })

  it('returns the only containing feature outside the overlap', () => {
    expect(hitTestTopmostAnnotation(list, [1, 1])).toBe(0) // only A
    expect(hitTestTopmostAnnotation(list, [14, 14])).toBe(1) // only B
  })

  it('returns -1 when no feature contains the point', () => {
    expect(hitTestTopmostAnnotation(list, [100, 100])).toBe(-1)
  })

  it('excludes points inside a hole', () => {
    const withHole = poly('H', {
      kind: 'polygon',
      rings: [
        new Float64Array([0, 0, 20, 0, 20, 20, 0, 20]), // exterior
        new Float64Array([8, 8, 12, 8, 12, 12, 8, 12]), // hole
      ],
    })
    expect(hitTestTopmostAnnotation([withHole], [10, 10])).toBe(-1) // inside the hole
    expect(hitTestTopmostAnnotation([withHole], [2, 2])).toBe(0) // in the solid part
  })
})

describe('snapToVertex', () => {
  // existing vertices: the four corners of the square.
  const VERTS = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10])
  const index = buildPointIndex(VERTS)

  it('snaps a near point onto the closest existing vertex', () => {
    expect(snapToVertex([0.3, -0.2] as Vec2, VERTS, index, 1)).toEqual([0, 0])
  })

  it('leaves a far point unchanged (outside the snap threshold)', () => {
    expect(snapToVertex([5, 5] as Vec2, VERTS, index, 1)).toEqual([5, 5])
  })
})

describe('finishPolygon (draft discard rule)', () => {
  it('discards a <3-vertex draft (returns null)', () => {
    expect(finishPolygon([])).toBeNull()
    expect(finishPolygon([[0, 0]])).toBeNull()
    expect(finishPolygon([[0, 0], [1, 1]])).toBeNull()
  })

  it('commits a ≥3-vertex draft into a flat exterior ring', () => {
    const geom = finishPolygon([[0, 0], [4, 0], [4, 4]])
    expect(geom).not.toBeNull()
    expect(geom?.kind).toBe('polygon')
    expect(Array.from((geom as PolygonGeometry).rings[0])).toEqual([0, 0, 4, 0, 4, 4])
    expect(ringToPairs((geom as PolygonGeometry).rings[0])).toEqual([[0, 0], [4, 0], [4, 4]])
  })
})

// ── ITEM-14/15 · the in-progress polygon (INV-15) ───────────────────────────────────────────
//
// Both helpers are shared by the editor (which decides what a press DOES) and the overlay
// builder (which decides what the user SEES). Testing them here is what keeps the affordance
// and the behaviour from drifting apart: the enlarged first-vertex target and the close
// hit-test are literally the same predicate.

describe('TEST-16 — rubber band + close affordance', () => {
  const draft: Vec2[] = [[0, 0], [10, 0], [10, 10]]

  it('rubberBandPath appends the live cursor as a trailing segment', () => {
    const path = rubberBandPath(draft, [4, 7])
    expect(path.length).toBe(draft.length + 1)
    expect(path[path.length - 1]).toEqual([4, 7])
    // the dropped vertices are untouched (the band is a trailing segment, not a re-anchor)
    expect(path.slice(0, 3)).toEqual(draft)
  })

  it('rubberBandPath returns the draft unchanged with no cursor, and never fabricates one', () => {
    expect(rubberBandPath(draft, null)).toBe(draft)
    expect(rubberBandPath(draft, undefined)).toBe(draft)
    // an empty draft never gains a phantom vertex from a hovering pointer
    expect(rubberBandPath([], [3, 3])).toEqual([])
  })

  it('the rubber band runs from the LAST dropped vertex to the cursor', () => {
    const path = rubberBandPath(draft, [99, 99])
    expect(path[path.length - 2]).toEqual([10, 10]) // last committed vertex
    expect(path[path.length - 1]).toEqual([99, 99]) // cursor
  })

  it('isPolygonCloseHit closes only near the FIRST vertex, and only when closable', () => {
    // within radius of the first vertex, with 3 vertices down ⇒ close
    expect(isPolygonCloseHit(draft, [1, 1], 6)).toBe(true)
    // far from the first vertex ⇒ drop another vertex instead
    expect(isPolygonCloseHit(draft, [50, 50], 6)).toBe(false)
    // near the LAST vertex is not a close (only the first vertex closes a ring)
    expect(isPolygonCloseHit(draft, [10, 10], 6)).toBe(false)
    // too few vertices ⇒ never closes, however near the press lands
    expect(isPolygonCloseHit([[0, 0], [10, 0]], [0, 0], 6)).toBe(false)
    expect(isPolygonCloseHit([], [0, 0], 6)).toBe(false)
  })

  it('isPolygonClosable matches finishPolygon’s minimum, so the ring shown is a ring that commits', () => {
    expect(isPolygonClosable([[0, 0], [1, 1]])).toBe(false)
    expect(isPolygonClosable(draft)).toBe(true)
    // the affordance never promises a commit that finishPolygon would discard
    expect(finishPolygon([[0, 0], [1, 1]])).toBeNull()
    expect(finishPolygon(draft)).not.toBeNull()
  })
})

describe('TEST-20 — reshape folded into select (DEC-18)', () => {
  it('vertex editing survives the fold: moveVertex still applies to a selected polygon', () => {
    const geom = finishPolygon([[0, 0], [10, 0], [10, 10]])!
    const moved = moveVertex(geom, 0, 1, 42, 43)
    expect(Array.from(moved.rings[0].slice(2, 4))).toEqual([42, 43])
    // the untouched vertices are preserved
    expect(Array.from(moved.rings[0].slice(0, 2))).toEqual([0, 0])
  })

  it("'reshape' is no longer part of the annotate tool vocabulary", () => {
    // NB: the id union no longer contains 'annotate.reshape' at all — tsc rejects a direct
    // comparison, which is itself the strongest form of this assertion. Widen to string so the
    // RUNTIME check still runs (a vocabulary regression would reintroduce the entry as data).
    const ids: string[] = TOOL_VOCABULARY.map(t => t.id)
    expect(ids).not.toContain('annotate.reshape')
    expect(toolsForSurface('annotate').map(t => t.key)).toEqual([
      'select',
      'point',
      'polygon',
      'brush',
    ])
  })
})
