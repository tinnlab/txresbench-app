// tilePyramid.test.ts — unit tests for the pure client quadtree tiling + viewport-LOD selection
// (PERFORMANCE_PLAN.md Phase 3 / B1). No deck.gl / DOM: pure math + typed-array views, node/vitest.

import { describe, it, expect } from 'vitest'
import {
  buildTilePyramid,
  selectTiles,
  levelForZoom,
  reorderByPyramid,
  tileView,
  DEFAULT_MAX_DEPTH,
  type TilePyramid,
} from './tilePyramid'
import type { DensityBounds } from '../density/densityBin'

// A deterministic grid of `side×side` points spread across the unit square, so tile membership is
// predictable. Point (col,row) sits at the CENTER of leaf cell (col,row) for a matching gridSide.
function gridPositions(side: number): Float32Array {
  const pos = new Float32Array(side * side * 2)
  let k = 0
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      pos[k++] = (c + 0.5) / side // x in (0,1)
      pos[k++] = (r + 0.5) / side // y in (0,1)
    }
  }
  return pos
}

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

describe('buildTilePyramid — assignment + contiguous ranges', () => {
  it('assigns every finite point to exactly one tile; ranges are contiguous, gap-free, cover total', () => {
    const side = 8
    const pos = gridPositions(side) // 64 points, one per cell at depth-3 grid
    const p = buildTilePyramid(pos, { maxDepth: 3 }) // gridSide 8 → one point per leaf
    expect(p.gridSide).toBe(8)
    expect(p.total).toBe(64)
    expect(p.tiles.length).toBe(64) // every cell occupied exactly once

    // Ranges tile [0,total) with no gap/overlap when walked in tile order.
    let cursor = 0
    let sum = 0
    for (const t of p.tiles) {
      expect(t.start).toBe(cursor)
      expect(t.count).toBeGreaterThan(0)
      cursor += t.count
      sum += t.count
    }
    expect(cursor).toBe(64)
    expect(sum).toBe(64)

    // `order` is a permutation of [0,64): every index present once.
    const seen = new Set(Array.from(p.order))
    expect(seen.size).toBe(64)
    for (let i = 0; i < 64; i++) expect(seen.has(i)).toBe(true)
  })

  it('places each point in the tile whose world rect contains it', () => {
    const side = 4
    const pos = gridPositions(side)
    const p = buildTilePyramid(pos, { maxDepth: 2 }) // gridSide 4
    for (const t of p.tiles) {
      for (let k = t.start; k < t.start + t.count; k++) {
        const i = p.order[k]
        const x = pos[2 * i]
        const y = pos[2 * i + 1]
        expect(x).toBeGreaterThanOrEqual(t.bounds.minX)
        expect(x).toBeLessThanOrEqual(t.bounds.maxX)
        expect(y).toBeGreaterThanOrEqual(t.bounds.minY)
        expect(y).toBeLessThanOrEqual(t.bounds.maxY)
        // and its (tileX,tileY) matches the grid cell of the point
        expect(t.tileX).toBe(Math.min(side - 1, Math.floor(x * side)))
        expect(t.tileY).toBe(Math.min(side - 1, Math.floor(y * side)))
      }
    }
  })

  it('groups many points that share a cell into ONE contiguous tile range (cap not exceeded)', () => {
    // 1000 points all in the bottom-left → they must all land in tile (0,0) as one range.
    const n = 1000
    const pos = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      pos[2 * i] = 0.001 + (i % 10) * 1e-5
      pos[2 * i + 1] = 0.001
    }
    const p = buildTilePyramid(pos, { maxDepth: 4, tilePointCap: 128, bounds: UNIT })
    // one non-empty tile, holding all 1000 points contiguously
    expect(p.tiles.length).toBe(1)
    expect(p.tiles[0].tileX).toBe(0)
    expect(p.tiles[0].tileY).toBe(0)
    expect(p.tiles[0].start).toBe(0)
    expect(p.tiles[0].count).toBe(1000)
    // tilePointCap is a DRAW budget surfaced on the pyramid, not a build-time truncation.
    expect(p.tilePointCap).toBe(128)
    expect(p.total).toBe(1000)
  })

  it('drops non-finite points (never assigned to a tile)', () => {
    const pos = new Float32Array([0.1, 0.1, NaN, 0.2, 0.3, Infinity, 0.9, 0.9])
    const p = buildTilePyramid(pos, { maxDepth: 3, bounds: UNIT })
    expect(p.total).toBe(2) // only the two finite points
    let counted = 0
    for (const t of p.tiles) counted += t.count
    expect(counted).toBe(2)
  })

  it('empty / all-non-finite input → an empty pyramid', () => {
    expect(buildTilePyramid(new Float32Array(0)).total).toBe(0)
    const p = buildTilePyramid(new Float32Array([NaN, NaN, Infinity, 1]))
    expect(p.total).toBe(0)
    expect(p.tiles.length).toBe(0)
    expect(p.order.length).toBe(0)
  })

  it('defaults to a 2^DEFAULT_MAX_DEPTH grid over the data bounds', () => {
    const p = buildTilePyramid(gridPositions(4))
    expect(p.maxDepth).toBe(DEFAULT_MAX_DEPTH)
    expect(p.gridSide).toBe(2 ** DEFAULT_MAX_DEPTH)
    // data bounds derived from the points (unit-square-ish, centers so slightly inset)
    expect(p.bounds.minX).toBeGreaterThanOrEqual(0)
    expect(p.bounds.maxX).toBeLessThanOrEqual(1)
  })

  it('within-tile order is stable/deterministic across builds (same seed)', () => {
    const pos = gridPositions(6)
    const a = buildTilePyramid(pos, { maxDepth: 2, seed: 7 })
    const b = buildTilePyramid(pos, { maxDepth: 2, seed: 7 })
    expect(Array.from(a.order)).toEqual(Array.from(b.order))
  })
})

describe('selectTiles — viewport cull + zoom-matched budget', () => {
  // A dense 64×64 grid (4096 points) across the unit square, depth-4 (16×16 leaf grid).
  const pos = gridPositions(64)
  const pyr: TilePyramid = buildTilePyramid(pos, { maxDepth: 4 }) // gridSide 16

  it('returns ONLY tiles intersecting the viewport (cull correctness)', () => {
    // A viewport covering just the bottom-left quarter [0,0.25]² → tiles with tileX,tileY < 4.
    const view: DensityBounds = { minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }
    const sel = selectTiles(pyr, view, 2)
    expect(sel.tiles.length).toBeGreaterThan(0)
    for (const t of sel.tiles) {
      // every selected tile's rect strictly overlaps the viewport
      expect(t.bounds.minX).toBeLessThan(view.maxX)
      expect(t.bounds.maxX).toBeGreaterThan(view.minX)
      expect(t.bounds.minY).toBeLessThan(view.maxY)
      expect(t.bounds.maxY).toBeGreaterThan(view.minY)
    }
    // and NO tile outside the quarter leaked in
    const anyOutside = sel.tiles.some(t => t.tileX >= 5 || t.tileY >= 5)
    expect(anyOutside).toBe(false)
  })

  it('empty viewport (no overlap) → empty selection', () => {
    const away: DensityBounds = { minX: 5, minY: 5, maxX: 6, maxY: 6 }
    const sel = selectTiles(pyr, away, 3)
    expect(sel.tiles.length).toBe(0)
    expect(sel.drawnPoints).toBe(0)
    expect(sel.visibleTileCount).toBe(0)
  })

  it('zero-area viewport → empty selection (touching edges do not count)', () => {
    const degenerate: DensityBounds = { minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }
    expect(selectTiles(pyr, degenerate, 4).tiles.length).toBe(0)
  })

  it('drawnPoints is decoupled from N — far zoom caps total near the target', () => {
    // Whole data visible (far zoom): every non-empty tile is visible, but per-tile budget shrinks
    // so the TOTAL drawn stays near the target, not 4096.
    const sel = selectTiles(pyr, UNIT, 0, { targetPoints: 256 })
    expect(sel.visibleTileCount).toBe(pyr.tiles.length)
    // total drawn ≈ target (never the full 4096); bounded above by target + one-per-tile rounding
    expect(sel.drawnPoints).toBeLessThan(pyr.total)
    expect(sel.drawnPoints).toBeLessThanOrEqual(sel.visibleTileCount * sel.perTileBudget)
    expect(sel.perTileBudget).toBeGreaterThanOrEqual(1)
  })

  it('near zoom (few visible tiles) → full fidelity (draws every point of the visible tiles)', () => {
    // A tight viewport over one leaf cell: budget exceeds the cell's count → drawCount == fullCount.
    const cell = pyr.tiles[0]
    const sel = selectTiles(pyr, cell.bounds, 4, { targetPoints: pyr.total })
    for (const t of sel.tiles) {
      if (t.tileX === cell.tileX && t.tileY === cell.tileY) {
        expect(t.drawCount).toBe(t.fullCount)
      }
    }
  })

  it('per-tile budget never exceeds the pyramid cap or a tile fullCount', () => {
    const sel = selectTiles(pyr, UNIT, 0, { targetPoints: 10_000_000 })
    expect(sel.perTileBudget).toBeLessThanOrEqual(pyr.tilePointCap)
    for (const t of sel.tiles) expect(t.drawCount).toBeLessThanOrEqual(t.fullCount)
  })

  it('maxTiles bounds the returned tile count', () => {
    const sel = selectTiles(pyr, UNIT, 0, { targetPoints: 256, maxTiles: 5 })
    expect(sel.tiles.length).toBeLessThanOrEqual(5)
  })

  it('level increases with zoom-in (smaller viewport span → higher level)', () => {
    const far = levelForZoom(pyr, UNIT) // whole data → level 0
    const mid = levelForZoom(pyr, { minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }) // 4× zoom → ~2
    const near = levelForZoom(pyr, { minX: 0, minY: 0, maxX: 1 / 16, maxY: 1 / 16 }) // 16× → ~4
    expect(far).toBe(0)
    expect(mid).toBeGreaterThan(far)
    expect(near).toBeGreaterThan(mid)
    expect(near).toBeLessThanOrEqual(pyr.maxDepth)
  })
})

describe('reorderByPyramid + tileView — zero-copy contiguous views', () => {
  const pos = gridPositions(16) // 256 points
  const pyr = buildTilePyramid(pos, { maxDepth: 3 }) // gridSide 8

  it('reorderByPyramid gathers positions into per-tile-contiguous order (values preserved)', () => {
    const reordered = reorderByPyramid(pos, pyr, 2)!
    expect(reordered.length).toBe(pyr.total * 2)
    // each reordered slot equals the source point at order[k]
    for (let k = 0; k < pyr.order.length; k++) {
      const i = pyr.order[k]
      expect(reordered[2 * k]).toBe(pos[2 * i])
      expect(reordered[2 * k + 1]).toBe(pos[2 * i + 1])
    }
  })

  it('tileView is a zero-copy subarray SHARING the reordered ArrayBuffer', () => {
    const reordered = reorderByPyramid(pos, pyr, 2)!
    const sel = selectTiles(pyr, UNIT, 0, { targetPoints: pyr.total }) // full fidelity
    const t = sel.tiles[0]
    const view = tileView(reordered, t, 2)
    // shares the SAME buffer (no copy) and is contiguous at the tile's offset
    expect(view.buffer).toBe(reordered.buffer)
    expect(view.byteOffset).toBe(t.start * 2 * reordered.BYTES_PER_ELEMENT)
    expect(view.length).toBe(t.drawCount * 2)
    // the view's points are exactly the tile's points from the reordered array
    for (let j = 0; j < t.drawCount; j++) {
      expect(view[2 * j]).toBe(reordered[(t.start + j) * 2])
    }
  })

  it('tileView of a budget-capped tile is a PREFIX (contiguous) of the tile range', () => {
    const reordered = reorderByPyramid(pos, pyr, 2)!
    const sel = selectTiles(pyr, UNIT, 0, { targetPoints: 8 }) // tiny budget → capped prefixes
    for (const t of sel.tiles) {
      const view = tileView(reordered, t, 2)
      expect(view.byteOffset).toBe(t.start * 2 * reordered.BYTES_PER_ELEMENT)
      expect(view.length).toBe(t.drawCount * 2) // prefix length, contiguous from start
      expect(t.drawCount).toBeLessThanOrEqual(t.fullCount)
    }
  })

  it('reorderByPyramid passes a nullish source through unchanged', () => {
    expect(reorderByPyramid(null, pyr, 1)).toBeNull()
    expect(reorderByPyramid(undefined, pyr, 2)).toBeUndefined()
  })

  it('reorders a per-point code column consistently with positions', () => {
    const codes = new Uint16Array(pyr.total)
    for (let i = 0; i < codes.length; i++) codes[i] = i % 7
    const rc = reorderByPyramid(codes, pyr, 1)!
    for (let k = 0; k < pyr.order.length; k++) {
      expect(rc[k]).toBe(codes[pyr.order[k]])
    }
  })
})
