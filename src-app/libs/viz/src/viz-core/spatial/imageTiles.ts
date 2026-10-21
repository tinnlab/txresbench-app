// imageTiles.ts — PURE, testable viewport-culled selection over an IMAGE TILE PYRAMID
// (STREAMING_PROGRESSIVE_PLAN.md item 15). A big spatial image (tissue image, segmentation
// mask, …) is NEVER accumulated as points — it renders as a lazy tile pyramid composited
// UNDER the scatter/raster. This file is the selection MATH: given a pyramid descriptor,
// the visible world rectangle, and the deck zoom, it returns the tiles to fetch+draw at the
// zoom-matched level — the deck.gl-free complement to `ImageTileLayer.tsx`.
//
// No deck.gl / DOM / React dependency — plain arithmetic, so it unit-tests in node. It
// reuses the same `DensityBounds` viewport rect the scale/tilePyramid selection uses, so an
// OrthographicView's `viewportWorldBounds` (scale/lod.ts) or `viewport.getBounds()` feeds it
// directly. Generic naming (image / tile / level / viewport — no gene/cell vocab), matching
// the framework-agnostic viz-core convention (DEC-28).
//
// ── The model ─────────────────────────────────────────────────────────────────────────────
//
// A classic image pyramid (DeepZoom / OME / slippy-map convention, matching deck.gl's own
// `TileLayer` z-semantics): `levels` resolution levels where LEVEL 0 IS THE COARSEST (most
// zoomed-out, fewest tiles) and LEVEL `levels-1` IS FULL RESOLUTION. A level's downsample
// factor vs full-res is `2^((levels-1) - level)`, so level 0 is downsampled by
// `2^(levels-1)` and the finest level by `1`. Each level is cut into `tileSize`-pixel square
// tiles; the last row/column tile is partial (clamped to the level's pixel extent). The FULL
// image occupies the world rectangle `imageBounds` (an affine-free linear pixel→world map),
// so a tile's world rect is its full-resolution pixel span carried through that map.
//
// `selectImageTiles` picks the zoom-matched level (one level-pixel ≈ one screen-pixel) and
// keeps ONLY the tiles of that level whose world rect intersects the viewport — so a render
// fetches a bounded, viewport-sized set of tiles regardless of the image's gigapixel size
// (lazy). Selection is O(tiles at the chosen level ∩ viewport), never O(image pixels).

import type { DensityBounds } from '../density/densityBin'

/**
 * The world rectangle the FULL image occupies, as the world coordinates of the image's pixel
 * corners. `left`/`right` are the world x at pixel x=0 / x=width; `top`/`bottom` the world y
 * at pixel y=0 / y=height. This corner form (not min/max) is orientation-general: a flipped
 * axis is expressed by `right < left` or `bottom < top`, so it composes with a deck
 * `OrthographicView({ flipY })` without the math needing to know the flip.
 */
export interface ImageWorldBounds {
  /** world x at pixel x = 0. */
  readonly left: number
  /** world y at pixel y = 0 (the image's TOP row). */
  readonly top: number
  /** world x at pixel x = width (the image's RIGHT edge). */
  readonly right: number
  /** world y at pixel y = height (the image's BOTTOM row). */
  readonly bottom: number
}

/**
 * A tiled image pyramid descriptor. `width`/`height` are the FULL-RESOLUTION pixel
 * dimensions; `tileSize` the square tile edge in pixels; `levels` the number of resolution
 * levels (level 0 = coarsest, `levels-1` = full-res — see the file header). `imageBounds`
 * places the full image into world space.
 */
export interface ImageTilePyramid {
  readonly width: number
  readonly height: number
  readonly tileSize: number
  readonly levels: number
  readonly imageBounds: ImageWorldBounds
}

/** One tile to fetch + draw: its pyramid coordinate + its world rectangle. */
export interface VisibleTile {
  /** pyramid level (0 = coarsest, `pyramid.levels-1` = full-res). */
  readonly level: number
  /** tile column at this level (`[0, tilesX)`). */
  readonly x: number
  /** tile row at this level (`[0, tilesY)`). */
  readonly y: number
  /**
   * the tile's world rectangle as a deck.gl `BitmapLayer` `bounds` tuple —
   * `[left, bottom, right, top]`. Feed straight to `new BitmapLayer({ bounds })`.
   */
  readonly worldBounds: readonly [number, number, number, number]
}

/** Clamp `v` into the inclusive integer range `[lo, hi]`. */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  const r = Math.round(v)
  return r < lo ? lo : r > hi ? hi : r
}

/** Highest level index (full resolution). A single-level pyramid ⇒ 0. */
function maxLevel(pyramid: ImageTilePyramid): number {
  return Math.max(0, Math.floor(pyramid.levels) - 1)
}

/** Downsample factor of `level` vs full resolution: `2^((levels-1) - level)`. */
export function levelDownsample(pyramid: ImageTilePyramid, level: number): number {
  return 2 ** (maxLevel(pyramid) - level)
}

/** Pixel dimensions of `level`: full-res dims divided by the level's downsample (ceil). */
export function levelPixelSize(
  pyramid: ImageTilePyramid,
  level: number,
): { width: number; height: number } {
  const d = levelDownsample(pyramid, level)
  return {
    width: Math.max(1, Math.ceil(pyramid.width / d)),
    height: Math.max(1, Math.ceil(pyramid.height / d)),
  }
}

/** Tile-grid dimensions of `level`: `ceil(levelPixels / tileSize)` per axis (≥ 1). */
export function levelTileGrid(
  pyramid: ImageTilePyramid,
  level: number,
): { tilesX: number; tilesY: number } {
  const { width, height } = levelPixelSize(pyramid, level)
  const ts = Math.max(1, Math.floor(pyramid.tileSize))
  return {
    tilesX: Math.max(1, Math.ceil(width / ts)),
    tilesY: Math.max(1, Math.ceil(height / ts)),
  }
}

/**
 * The zoom-matched pyramid level for a deck OrthographicView `zoom` — the level whose ONE
 * downsampled pixel is ≈ one screen pixel (so we fetch the least data that still looks sharp).
 *
 * deck's OrthographicView renders `2^zoom` device-pixels per world unit, and the full-res
 * image has `width / |imageWorldWidth|` image-pixels per world unit. The ideal downsample is
 * the ratio of the two (`imagePxPerWorld / screenPxPerWorld`); its `log₂` is how many levels
 * COARSER than full-res to go. Clamped to `[0, levels-1]`. A degenerate image extent or a
 * non-finite zoom ⇒ the coarsest level (0).
 */
export function levelForImageZoom(pyramid: ImageTilePyramid, zoom: number): number {
  const top = maxLevel(pyramid)
  const worldW = Math.abs(pyramid.imageBounds.right - pyramid.imageBounds.left)
  if (!(worldW > 0) || pyramid.width <= 0) return 0
  const screenPxPerWorld = 2 ** (Number.isFinite(zoom) ? zoom : 0)
  if (!(screenPxPerWorld > 0)) return 0
  const imagePxPerWorld = pyramid.width / worldW
  const idealDownsample = imagePxPerWorld / screenPxPerWorld
  // level = top - log2(idealDownsample): downsample 1 ⇒ full-res (top); larger ⇒ coarser.
  const level = top - Math.round(Math.log2(Math.max(1e-9, idealDownsample)))
  return clampInt(level, 0, top)
}

/** Linear pixel(x) → world-x on the image's horizontal axis. */
function worldX(pyramid: ImageTilePyramid, px: number): number {
  const { left, right } = pyramid.imageBounds
  return left + (right - left) * (px / pyramid.width)
}

/** Linear pixel(y) → world-y on the image's vertical axis. */
function worldY(pyramid: ImageTilePyramid, py: number): number {
  const { top, bottom } = pyramid.imageBounds
  return top + (bottom - top) * (py / pyramid.height)
}

/**
 * The world rectangle a `(level, x, y)` tile occupies, as a deck `BitmapLayer` bounds tuple
 * `[left, bottom, right, top]`. The tile's level-pixel span is scaled to full-resolution
 * pixels (clamped to the image extent so a partial edge tile never runs off-image), then each
 * corner is carried through the linear `imageBounds` map.
 */
export function tileWorldBounds(
  pyramid: ImageTilePyramid,
  level: number,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const d = levelDownsample(pyramid, level)
  const ts = Math.max(1, Math.floor(pyramid.tileSize))
  const fx0 = Math.min(x * ts * d, pyramid.width)
  const fx1 = Math.min((x + 1) * ts * d, pyramid.width)
  const fy0 = Math.min(y * ts * d, pyramid.height)
  const fy1 = Math.min((y + 1) * ts * d, pyramid.height)
  const wLeft = worldX(pyramid, fx0)
  const wRight = worldX(pyramid, fx1)
  const wTop = worldY(pyramid, fy0)
  const wBottom = worldY(pyramid, fy1)
  return [wLeft, wBottom, wRight, wTop]
}

/** Do two rectangles overlap with STRICTLY-positive area? (touching edges don't count.) */
function overlaps(
  aMinX: number,
  aMinY: number,
  aMaxX: number,
  aMaxY: number,
  b: DensityBounds,
): boolean {
  return aMinX < b.maxX && aMaxX > b.minX && aMinY < b.maxY && aMaxY > b.minY
}

/**
 * Select the image tiles to fetch + draw for `viewport` at `zoom` — the per-render, lazy
 * viewport-cull. Picks the zoom-matched level (`levelForImageZoom`), then keeps ONLY that
 * level's tiles whose world rectangle intersects the viewport (positive overlap area). Tile
 * indices are bounded to the level's grid, so no off-image tile is ever emitted; a
 * zero-area/degenerate viewport, or one entirely outside `imageBounds`, yields an empty
 * selection. Each returned tile carries its deck `BitmapLayer` `worldBounds`.
 *
 * Signature order `(viewport, zoom, pyramid)` per the item-15 plan.
 */
export function selectImageTiles(
  viewport: DensityBounds,
  zoom: number,
  pyramid: ImageTilePyramid,
): VisibleTile[] {
  const viewW = viewport.maxX - viewport.minX
  const viewH = viewport.maxY - viewport.minY
  if (!(viewW > 0) || !(viewH > 0)) return []
  if (!(pyramid.levels >= 1) || pyramid.width <= 0 || pyramid.height <= 0) return []

  const level = levelForImageZoom(pyramid, zoom)
  const { tilesX, tilesY } = levelTileGrid(pyramid, level)

  const out: VisibleTile[] = []
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const b = tileWorldBounds(pyramid, level, tx, ty)
      // b is [left, bottom, right, top]; normalize to min/max (imageBounds may be flipped).
      const minX = Math.min(b[0], b[2])
      const maxX = Math.max(b[0], b[2])
      const minY = Math.min(b[1], b[3])
      const maxY = Math.max(b[1], b[3])
      if (overlaps(minX, minY, maxX, maxY, viewport)) {
        out.push({ level, x: tx, y: ty, worldBounds: b })
      }
    }
  }
  return out
}
