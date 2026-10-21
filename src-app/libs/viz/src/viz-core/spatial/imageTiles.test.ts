import { describe, it, expect } from 'vitest'
import {
  selectImageTiles,
  levelForImageZoom,
  levelDownsample,
  levelPixelSize,
  levelTileGrid,
  tileWorldBounds,
  type ImageTilePyramid,
} from './imageTiles'
import type { DensityBounds } from '../density/densityBin'

// A 1024×1024 full-res image, 256px tiles, 3 levels. Placed 1:1 into world space over the
// unit-per-pixel rect [0,1024]×[0,1024] with the image's TOP row at world y=0 (pixel-oriented,
// unflipped). So level 2 = full-res (1024px, 4×4 tiles), level 1 = 512px (2×2), level 0 =
// 256px (1×1 tile).
function makePyramid(overrides: Partial<ImageTilePyramid> = {}): ImageTilePyramid {
  return {
    width: 1024,
    height: 1024,
    tileSize: 256,
    levels: 3,
    imageBounds: { left: 0, top: 0, right: 1024, bottom: 1024 },
    ...overrides,
  }
}

const rect = (minX: number, minY: number, maxX: number, maxY: number): DensityBounds => ({
  minX,
  minY,
  maxX,
  maxY,
})

describe('pyramid geometry (level ↔ pixels ↔ tiles)', () => {
  it('downsamples with level 0 coarsest and levels-1 full-res', () => {
    const p = makePyramid()
    expect(levelDownsample(p, 2)).toBe(1) // full res
    expect(levelDownsample(p, 1)).toBe(2)
    expect(levelDownsample(p, 0)).toBe(4) // coarsest
  })

  it('derives per-level pixel size and tile grid', () => {
    const p = makePyramid()
    expect(levelPixelSize(p, 2)).toEqual({ width: 1024, height: 1024 })
    expect(levelPixelSize(p, 0)).toEqual({ width: 256, height: 256 })
    expect(levelTileGrid(p, 2)).toEqual({ tilesX: 4, tilesY: 4 })
    expect(levelTileGrid(p, 1)).toEqual({ tilesX: 2, tilesY: 2 })
    expect(levelTileGrid(p, 0)).toEqual({ tilesX: 1, tilesY: 1 })
  })

  it('maps a full-res tile to its world rectangle [left,bottom,right,top]', () => {
    const p = makePyramid()
    // level 2, tile (0,0) = pixels [0,256]×[0,256] → world x [0,256], y top=0 bottom=256.
    expect(tileWorldBounds(p, 2, 0, 0)).toEqual([0, 256, 256, 0])
    // level 2, tile (3,3) = pixels [768,1024]² → [768,1024,1024,768].
    expect(tileWorldBounds(p, 2, 3, 3)).toEqual([768, 1024, 1024, 768])
    // level 0, the single tile covers the whole image.
    expect(tileWorldBounds(p, 0, 0, 0)).toEqual([0, 1024, 1024, 0])
  })
})

describe('levelForImageZoom (one level-pixel ≈ one screen-pixel)', () => {
  // world spans 1024 units over 1024 px ⇒ imagePxPerWorld = 1. screenPxPerWorld = 2^zoom.
  // idealDownsample = 1 / 2^zoom → level = top - round(-zoom) = top + round(zoom).
  it('picks full-res (top level) at zoom 0 (1 screen px per world unit)', () => {
    expect(levelForImageZoom(makePyramid(), 0)).toBe(2)
  })
  it('picks a coarser level as we zoom OUT (negative zoom)', () => {
    expect(levelForImageZoom(makePyramid(), -1)).toBe(1)
    expect(levelForImageZoom(makePyramid(), -2)).toBe(0)
  })
  it('clamps below level 0 when zoomed out past the coarsest level', () => {
    expect(levelForImageZoom(makePyramid(), -10)).toBe(0)
  })
  it('clamps at the finest level when zoomed in past full resolution', () => {
    expect(levelForImageZoom(makePyramid(), 8)).toBe(2)
  })
  it('is coarsest (0) for a degenerate image extent or non-finite zoom', () => {
    const flat = makePyramid({ imageBounds: { left: 5, top: 0, right: 5, bottom: 1024 } })
    expect(levelForImageZoom(flat, 0)).toBe(0)
    expect(levelForImageZoom(makePyramid(), Number.NaN)).toBe(2) // NaN→zoom 0 path → top
  })
})

describe('selectImageTiles — viewport cull', () => {
  it('returns only viewport-intersecting tiles (full-res level)', () => {
    const p = makePyramid()
    // viewport over the top-left quadrant, at zoom 0 → level 2 (4×4 grid, 256px tiles).
    // Covers world [0,300]×[0,300] → tiles (0,0),(1,0),(0,1),(1,1) intersect (tile 1 spans
    // 256..512, and 300 > 256 so it partially overlaps).
    const tiles = selectImageTiles(rect(0, 0, 300, 300), 0, p)
    const coords = tiles.map(t => `${t.x},${t.y}`).sort()
    expect(tiles.every(t => t.level === 2)).toBe(true)
    expect(coords).toEqual(['0,0', '0,1', '1,0', '1,1'])
  })

  it('a tiny viewport in one tile selects exactly that tile', () => {
    const p = makePyramid()
    // world [520,540]×[520,540] falls inside full-res tile (2,2) (pixels 512..768).
    const tiles = selectImageTiles(rect(520, 540, 530, 550), 0, p)
    expect(tiles.map(t => `${t.level}:${t.x},${t.y}`)).toEqual(['2:2,2'])
  })

  it('picks the zoom-matched (coarse) level when zoomed out', () => {
    const p = makePyramid()
    // zoom -2 → level 0 (single 1×1 tile covering the whole image).
    const tiles = selectImageTiles(rect(-100, -100, 2000, 2000), -2, p)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ level: 0, x: 0, y: 0 })
    expect(tiles[0].worldBounds).toEqual([0, 1024, 1024, 0])
  })

  it('emits NO tile outside imageBounds — a viewport fully off-image is empty', () => {
    const p = makePyramid()
    // viewport entirely to the right of the image (x > 1024).
    expect(selectImageTiles(rect(2000, 0, 3000, 1024), 0, p)).toEqual([])
    // viewport entirely above the image (y < 0).
    expect(selectImageTiles(rect(0, -500, 1024, -10), 0, p)).toEqual([])
  })

  it('never returns a tile index beyond the level grid (viewport larger than image)', () => {
    const p = makePyramid()
    const tiles = selectImageTiles(rect(-500, -500, 2500, 2500), 0, p)
    // full-res level → 4×4 = 16 tiles, all in-bounds, none with x or y ≥ 4.
    expect(tiles).toHaveLength(16)
    expect(tiles.every(t => t.x >= 0 && t.x < 4 && t.y >= 0 && t.y < 4)).toBe(true)
  })

  it('an empty (zero-area) viewport yields no tiles', () => {
    const p = makePyramid()
    expect(selectImageTiles(rect(100, 100, 100, 100), 0, p)).toEqual([]) // zero width+height
    expect(selectImageTiles(rect(100, 100, 100, 300), 0, p)).toEqual([]) // zero width
    expect(selectImageTiles(rect(100, 300, 300, 300), 0, p)).toEqual([]) // zero height
  })

  it('an edge-touching viewport (no positive overlap) yields no tiles', () => {
    const p = makePyramid()
    // viewport exactly to the left, its right edge touching x=0.
    expect(selectImageTiles(rect(-50, 0, 0, 1024), 0, p)).toEqual([])
  })

  it('handles a y-flipped image placement (bottom < top) without off-image tiles', () => {
    // image bottom row at world y=0, top row at y=1024 (flipY-style placement).
    const p = makePyramid({ imageBounds: { left: 0, top: 1024, right: 1024, bottom: 0 } })
    const tiles = selectImageTiles(rect(0, 0, 1024, 1024), 0, p)
    expect(tiles).toHaveLength(16)
    // every tile's normalized rect stays within [0,1024]².
    for (const t of tiles) {
      const [l, b, r, tp] = t.worldBounds
      expect(Math.min(l, r)).toBeGreaterThanOrEqual(0)
      expect(Math.max(l, r)).toBeLessThanOrEqual(1024)
      expect(Math.min(b, tp)).toBeGreaterThanOrEqual(0)
      expect(Math.max(b, tp)).toBeLessThanOrEqual(1024)
    }
  })

  it('a single-level pyramid always selects level 0 tiles', () => {
    const p = makePyramid({ levels: 1 })
    expect(levelTileGrid(p, 0)).toEqual({ tilesX: 4, tilesY: 4 }) // full res IS level 0 here
    const tiles = selectImageTiles(rect(0, 0, 1024, 1024), 3, p)
    expect(tiles.every(t => t.level === 0)).toBe(true)
    expect(tiles).toHaveLength(16)
  })
})
