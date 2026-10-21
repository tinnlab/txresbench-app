// freehand.test.ts (TEST-6) — correctness proof for the freehand + brush geometry:
// RDP reduces a dense path's vertex count and is idempotent within tolerance; a hand-rolled
// marching-squares trace of a stamped disk returns a boundary ring approximating that disk
// (± tolerance); and a freehand ring fed to `selectRegion` selects exactly the enclosed cells.
// Node vitest, mirroring `regionSelect.test.ts`.

import { describe, it, expect } from 'vitest'
import { freehandToPolygon, rdpSimplify, ringToVec2s, type Vec2 } from './freehand'
import {
  brushPathToPolygon,
  createScratchRaster,
  marchingSquares,
  stampDisk,
  stampPath,
  strokeBBox,
} from './brushRaster'
import { selectRegion } from '../spatial/regionSelect'
import { buildPointIndex } from '../spatial/pointIndex'
import type { PolygonGeometry } from './annotateModel'

describe('rdpSimplify', () => {
  it('collapses a run of near-collinear points to the endpoints', () => {
    const line: Vec2[] = [[0, 0], [1, 0.01], [2, -0.02], [3, 0.03], [4, 0]]
    expect(rdpSimplify(line, 0.5)).toEqual([[0, 0], [4, 0]])
  })

  it('keeps a vertex that deviates beyond the tolerance', () => {
    const spike: Vec2[] = [[0, 0], [1, 0], [2, 5], [3, 0], [4, 0]]
    const out = rdpSimplify(spike, 1)
    expect(out).toContainEqual([2, 5]) // the spike survives
    expect(out.length).toBeLessThan(spike.length) // and the flat run is thinned
  })

  it('is idempotent within the same tolerance', () => {
    const path: Vec2[] = [
      [0, 0], [1, 0.4], [2, 0.1], [3, 2.5], [4, 2.6], [5, 0.2], [6, 0.1], [7, 3], [8, 0],
    ]
    const once = rdpSimplify(path, 0.5)
    const twice = rdpSimplify(once, 0.5)
    expect(twice).toEqual(once)
  })

  it('reduces the vertex count of a dense capture', () => {
    const dense: Vec2[] = []
    for (let i = 0; i <= 200; i++) dense.push([i * 0.1, Math.sin(i * 0.1) * 0.05])
    const out = rdpSimplify(dense, 0.5)
    expect(out.length).toBeLessThan(dense.length)
  })
})

describe('marchingSquares (disk boundary)', () => {
  it('traces the boundary of a stamped disk as a ring at ~radius from the centre', () => {
    const raster = createScratchRaster(40, 40)
    const cx = 20
    const cy = 20
    const r = 12
    stampDisk(raster, cx, cy, r)
    const ring = marchingSquares(raster)

    expect(ring.length).toBeGreaterThan(20) // a non-trivial closed staircase
    // every boundary node sits within a few pixels of the true circle radius
    for (const [x, y] of ring) {
      const d = Math.hypot(x - cx, y - cy)
      expect(d).toBeGreaterThanOrEqual(r - 3)
      expect(d).toBeLessThanOrEqual(r + 3)
    }
    // the mean radius is close to r (the staircase averages out)
    const mean = ring.reduce((s, [x, y]) => s + Math.hypot(x - cx, y - cy), 0) / ring.length
    expect(mean).toBeGreaterThan(r - 2)
    expect(mean).toBeLessThan(r + 2)
  })

  it('returns an empty ring for an empty raster', () => {
    expect(marchingSquares(createScratchRaster(10, 10))).toEqual([])
  })

  it('brushPathToPolygon simplifies a stamped stroke into a valid polygon ring', () => {
    const geom = brushPathToPolygon(40, 40, [[20, 20]], 12, 1.5)
    expect(geom).not.toBeNull()
    expect(geom?.kind).toBe('polygon')
    expect((geom as PolygonGeometry).rings[0].length).toBeGreaterThanOrEqual(6) // ≥3 verts
  })
})

describe('freehand ring → selectRegion', () => {
  // a cluster of points inside a [0..10]² box, plus outliers well outside it.
  const POSITIONS = new Float32Array([
    2, 2, 5, 5, 8, 3, 3, 8, // inside (indices 0..3)
    50, 50, 50, 2, 2, 50, // outside (indices 4..6)
  ])
  const N = POSITIONS.length / 2

  it('a freehand square ring selects exactly the enclosed cells', () => {
    // a hand-drawn loop with jitter (many vertices) around the cluster
    const path: Vec2[] = [
      [-1, -1], [3, -0.9], [7, -1.1], [11, -1], [11, 4], [10.9, 8], [11, 11],
      [6, 11.1], [1, 11], [-1, 10.9], [-0.9, 5], [-1, -1],
    ]
    const geom = freehandToPolygon(path, 0.5)
    expect(geom).not.toBeNull()
    const ring = ringToVec2s((geom as PolygonGeometry).rings[0])

    const index = buildPointIndex(POSITIONS)
    const selected = Array.from(selectRegion(ring, POSITIONS, N, index)).sort((a, b) => a - b)
    expect(selected).toEqual([0, 1, 2, 3]) // only the enclosed cluster
  })

  it('discards a degenerate freehand capture (<3 vertices)', () => {
    expect(freehandToPolygon([[0, 0], [1, 1]], 0.5)).toBeNull()
  })

  it('rejects a zero-area / collinear ring even when tolerance <= 0 bypasses RDP (finding 4)', () => {
    // tolerance <= 0 short-circuits RDP, so all 3+ collinear points survive the vertex count —
    // but they enclose no area, so it is NOT a polygon and must return null.
    expect(freehandToPolygon([[0, 0], [1, 0], [2, 0]], 0)).toBeNull()
    expect(freehandToPolygon([[0, 0], [1, 0], [2, 0], [3, 0]], -1)).toBeNull()
    // vertical collinear too
    expect(freehandToPolygon([[5, 0], [5, 1], [5, 2]], 0)).toBeNull()
    // a real (non-degenerate) triangle still succeeds under the same tolerance<=0 path
    const tri = freehandToPolygon([[0, 0], [4, 0], [2, 3]], 0)
    expect(tri).not.toBeNull()
    expect((tri as PolygonGeometry).rings[0].length).toBe(6) // 3 verts × 2
  })
})

describe('brushRaster bbox-bounded allocation (finding 5)', () => {
  it('strokeBBox is a tight, canvas-clamped stroke bbox — not the full canvas', () => {
    // a tiny stroke on a huge canvas
    const bbox = strokeBBox(1_000_000, 1_000_000, [[500_000, 500_000]], 12)
    expect(bbox).not.toBeNull()
    const b = bbox!
    // width/height of the allocated region are O(radius), not O(canvas)
    expect(b.x1 - b.x0 + 1).toBeLessThanOrEqual(2 * 12 + 2)
    expect(b.y1 - b.y0 + 1).toBeLessThanOrEqual(2 * 12 + 2)
    // and it is centred on the stroke
    expect(b.x0).toBeLessThanOrEqual(500_000)
    expect(b.x1).toBeGreaterThanOrEqual(500_000)
    // empty / off-canvas strokes ⇒ null
    expect(strokeBBox(100, 100, [], 5)).toBeNull()
    expect(strokeBBox(100, 100, [[-1000, -1000]], 5)).toBeNull()
  })

  it('does NOT allocate the full raster — a tiny stroke on a gigapixel canvas succeeds', () => {
    // A full width×height Uint8Array here would be 1e10 bytes (~10 GB) and throw RangeError.
    // Success proves the allocation tracks the brush bbox, not the image (INV-6 gigapixel-safety).
    const geom = brushPathToPolygon(100_000, 100_000, [[50_000, 50_000]], 12, 1.5)
    expect(geom).not.toBeNull()
    expect((geom as PolygonGeometry).rings[0].length).toBeGreaterThanOrEqual(6)
    // the returned ring is in FULL-RES coords (offset back), around the stroke centre
    const ring = ringToVec2s((geom as PolygonGeometry).rings[0])
    for (const [x, y] of ring) {
      expect(Math.hypot(x - 50_000, y - 50_000)).toBeLessThanOrEqual(12 + 3)
    }
  })

  it('bbox-local march yields the SAME boundary as a full-canvas march (offset back)', () => {
    // Prove the bbox optimisation is behaviour-preserving: a full-canvas stamp+march and a
    // bbox-local stamp+march (with the local ring offset back to full-res) trace the identical ring.
    const w = 40
    const h = 40
    const r = 12
    const path: Vec2[] = [[20, 20]]

    const full = createScratchRaster(w, h)
    stampPath(full, path, r)
    const fullRing = marchingSquares(full)
    expect(fullRing.length).toBeGreaterThan(20)

    const bbox = strokeBBox(w, h, path, r)!
    const bw = bbox.x1 - bbox.x0 + 1
    const bh = bbox.y1 - bbox.y0 + 1
    // the local raster is strictly smaller than the full canvas
    expect(bw * bh).toBeLessThan(w * h)
    const local = createScratchRaster(bw, bh)
    stampPath(local, path.map(([x, y]) => [x - bbox.x0, y - bbox.y0] as Vec2), r)
    const localRing = marchingSquares(local).map(([x, y]) => [x + bbox.x0, y + bbox.y0] as Vec2)

    expect(localRing).toEqual(fullRing) // byte-for-byte identical ring
  })
})
