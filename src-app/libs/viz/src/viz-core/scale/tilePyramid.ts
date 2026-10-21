// tilePyramid.ts — pure, testable CLIENT-side quadtree tiling + viewport-LOD selection
// (PERFORMANCE_PLAN.md Phase 3 / PERF_SCALING_PLAN.md B1). This is the GPU-path complement to
// the CPU raster mode: instead of uploading/drawing all N points every frame, we build a spatial
// index over the resident interleaved xy ONCE, then per frame draw ONLY the points whose tiles
// intersect the viewport, at a zoom-matched budget — so per-frame GPU cost decouples from total N.
//
// No deck.gl / DOM / React dependency — plain math over typed arrays, so it unit-tests in node.
// Generic naming (tiles / levels / viewport — no domain terms): framework/domain-agnostic scale
// infra, sitting beside chunking.ts (VRAM budget) and adaptiveSample.ts (fixed-budget sampler).
//
// ── The model (a documented design decision — see PERFORMANCE_PLAN Phase 3 up-front decisions) ──
//
// A single LEAF grid of `2^maxDepth × 2^maxDepth` tiles over the data bounds. Points are REORDERED
// ONCE (a permutation `order`) so every leaf tile owns a CONTIGUOUS half-open range `[start, start
// + count)` into that order — exactly the chunking.ts pattern (a tile is a "chunk" keyed by space
// instead of ordinal), so a tile's buffers are zero-copy `.subarray` VIEWS of one reordered array.
//
// Within each leaf tile the points are ordered by a stable per-point PRIORITY (a hash), so a PREFIX
// of a tile's range is a representative (stratified-random) SUBSET of that tile — which is what
// makes the LOD budget zero-copy: drawing "the first k points of a tile" is `subarray(start,
// start+k)`, a contiguous slice, never a strided gather.
//
// VIEWPORT LOD is a per-tile budget driven by zoom: `selectTiles` keeps only the tiles intersecting
// the viewport and caps each to `perTileBudget = clamp(round(target / visibleTiles), 1, cap)`. Far
// zoom ⇒ many tiles visible ⇒ small per-tile budget ⇒ a coarse but representative overview; near
// zoom ⇒ few tiles visible ⇒ the budget exceeds each tile's count ⇒ full fidelity. The total drawn
// count is therefore ≈ `target` REGARDLESS of N — a constant per-frame cost (the Potree budget idea,
// spatially distributed). Selection is O(visible tiles), never O(N): no per-point work per frame.
//
// The `level` returned by `selectTiles` is the derived quadtree DEPTH the current zoom corresponds
// to (0 = whole data fits the viewport; +1 per zoom doubling), reported for observability and to
// match "the level whose on-screen point density is ≈ target" — it is informational; the leaf grid
// + per-tile budget is what actually bounds the draw.

import { pointPriority, DEFAULT_SAMPLE_SEED } from './adaptiveSample'
import { boundsForPositions, type DensityBounds } from '../density/densityBin'

/** Default quadtree depth: a `2^8 = 256`-per-axis leaf grid (65 536 leaf cells). Deep enough that
 *  each leaf is ~a screen tile at high zoom, shallow enough that the tile table stays small. */
export const DEFAULT_MAX_DEPTH = 8

/** Default per-tile draw budget cap — the most points drawn from any ONE tile in a selection. */
export const DEFAULT_TILE_POINT_CAP = 4096

/** Default target for the TOTAL drawn count across all selected tiles (the constant frame cost). */
export const DEFAULT_TILE_TARGET_POINTS = 800_000

export interface BuildTilePyramidOptions {
  /** world-space extent to tile over. Defaults to the data's own bounds (`boundsForPositions`). */
  bounds?: DensityBounds
  /** quadtree depth → `2^maxDepth` leaf tiles per axis (default {@link DEFAULT_MAX_DEPTH}). */
  maxDepth?: number
  /** per-tile draw-budget cap surfaced on the pyramid (default {@link DEFAULT_TILE_POINT_CAP}). */
  tilePointCap?: number
  /** priority-hash seed for the stable within-tile order (default {@link DEFAULT_SAMPLE_SEED}). */
  seed?: number
}

/** One leaf tile = a contiguous point range in the reordered `order`, at grid cell (tileX, tileY). */
export interface PyramidTile {
  /** column in the `[0, gridSide)` leaf grid. */
  readonly tileX: number
  /** row in the `[0, gridSide)` leaf grid. */
  readonly tileY: number
  /** first index into `order` (inclusive). */
  readonly start: number
  /** number of points in this tile. */
  readonly count: number
  /** the tile's world-space rectangle (a `1/gridSide` slice of `bounds` on each axis). */
  readonly bounds: DensityBounds
}

/** The built spatial index: the reorder permutation + the non-empty leaf tiles + grid metadata. */
export interface TilePyramid {
  /** a permutation of `[0, total)` grouping points by leaf tile (priority-ordered within a tile).
   *  Gather the resident buffers through this ONCE to get per-tile-contiguous reordered arrays. */
  readonly order: Uint32Array
  /** the non-empty leaf tiles, each a contiguous `[start, start+count)` range into `order`. */
  readonly tiles: readonly PyramidTile[]
  /** `2^maxDepth` — leaf tiles per axis. */
  readonly gridSide: number
  readonly maxDepth: number
  readonly tilePointCap: number
  /** the world extent the grid tiles over. */
  readonly bounds: DensityBounds
  /** total points indexed (= `order.length`). */
  readonly total: number
}

/** One selected tile to draw: its reordered range prefix `[start, start+drawCount)` + provenance. */
export interface SelectedTile {
  readonly tileX: number
  readonly tileY: number
  /** first index into `pyramid.order` (inclusive) — same as the tile's `start`. */
  readonly start: number
  /** points to DRAW from this tile = `min(tile.count, perTileBudget)` (a zero-copy prefix). */
  readonly drawCount: number
  /** the tile's FULL point count (`drawCount ≤ fullCount`). */
  readonly fullCount: number
  readonly bounds: DensityBounds
}

/** The result of a viewport-LOD selection — what a tiled render draws this frame. */
export interface TileSelection {
  /** the visible tiles (viewport-intersecting), each with its zero-copy draw prefix. */
  readonly tiles: readonly SelectedTile[]
  /** derived quadtree level the zoom corresponds to (observability; see the module header). */
  readonly level: number
  /** per-tile draw budget applied this selection. */
  readonly perTileBudget: number
  /** number of visible (viewport-intersecting, non-empty) tiles. */
  readonly visibleTileCount: number
  /** total points drawn across all selected tiles (Σ drawCount) — decoupled from `total`. */
  readonly drawnPoints: number
}

export interface SelectTilesOptions {
  /** target TOTAL drawn count (default {@link DEFAULT_TILE_TARGET_POINTS}); sets the per-tile budget. */
  targetPoints?: number
  /** hard cap on the number of tiles returned (safety bound for a fully-zoomed-out viewport). */
  maxTiles?: number
}

/** Column of a world x within a `[0, gridSide)` grid over `bounds` (clamped; degenerate axis → 0). */
function colFor(x: number, bounds: DensityBounds, gridSide: number): number {
  const span = bounds.maxX - bounds.minX
  if (!(span > 0)) return 0
  const c = Math.floor(((x - bounds.minX) / span) * gridSide)
  return c < 0 ? 0 : c >= gridSide ? gridSide - 1 : c
}

/** Row of a world y within a `[0, gridSide)` grid over `bounds` (clamped; degenerate axis → 0). */
function rowFor(y: number, bounds: DensityBounds, gridSide: number): number {
  const span = bounds.maxY - bounds.minY
  if (!(span > 0)) return 0
  const r = Math.floor(((y - bounds.minY) / span) * gridSide)
  return r < 0 ? 0 : r >= gridSide ? gridSide - 1 : r
}

/** World rectangle of leaf cell (tileX, tileY) — a `1/gridSide` slice of `bounds` per axis. */
function tileBounds(
  tileX: number,
  tileY: number,
  bounds: DensityBounds,
  gridSide: number,
): DensityBounds {
  const spanX = (bounds.maxX - bounds.minX) / gridSide
  const spanY = (bounds.maxY - bounds.minY) / gridSide
  return {
    minX: bounds.minX + tileX * spanX,
    minY: bounds.minY + tileY * spanY,
    maxX: bounds.minX + (tileX + 1) * spanX,
    maxY: bounds.minY + (tileY + 1) * spanY,
  }
}

/**
 * Build the client quadtree over interleaved xy `positions` (length N*2). Single O(N) tile
 * assignment + an O(N log N) reorder (a counting group by leaf tile, then priority-ordered within
 * each tile). Returns a {@link TilePyramid}: a reorder permutation grouping points by leaf tile,
 * the non-empty tiles as contiguous `[start, count)` ranges, and grid metadata. Non-finite points
 * are dropped (never assigned to a tile). An empty / all-non-finite input yields an empty pyramid.
 *
 * The reorder is the ONE materialization (like ChunkedScatter's over-budget copy) — after it, every
 * tile's buffers are zero-copy `.subarray` views and every per-frame `selectTiles` is O(visible).
 */
export function buildTilePyramid(
  positions: Float32Array,
  opts: BuildTilePyramidOptions = {},
): TilePyramid {
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth ?? DEFAULT_MAX_DEPTH))
  const gridSide = 2 ** maxDepth
  const tilePointCap = Math.max(1, Math.floor(opts.tilePointCap ?? DEFAULT_TILE_POINT_CAP))
  const seed = opts.seed ?? DEFAULT_SAMPLE_SEED
  const bounds = opts.bounds ?? boundsForPositions(positions)
  const n = positions.length >> 1

  // Pass 1 — leaf-tile index per point (row-major `row*gridSide+col`), −1 for non-finite (dropped).
  const cellOf = new Int32Array(n)
  const cellCounts = new Map<number, number>()
  let kept = 0
  for (let i = 0; i < n; i++) {
    const x = positions[2 * i]
    const y = positions[2 * i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      cellOf[i] = -1
      continue
    }
    const col = colFor(x, bounds, gridSide)
    const row = rowFor(y, bounds, gridSide)
    const cell = row * gridSide + col
    cellOf[i] = cell
    cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1)
    kept++
  }

  // Sort the non-empty leaf cells so tiles list in a stable (row-major) order, and lay their
  // ranges out contiguously in `order`. `starts` maps a cell → its base offset in `order`.
  const sortedCells = Array.from(cellCounts.keys()).sort((a, b) => a - b)
  const starts = new Map<number, number>()
  let running = 0
  for (const cell of sortedCells) {
    starts.set(cell, running)
    running += cellCounts.get(cell)!
  }

  // Pass 2 — scatter each kept point into its cell's block; `fill[cell]` is the intra-cell cursor.
  const order = new Uint32Array(kept)
  const fill = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const cell = cellOf[i]
    if (cell < 0) continue
    const base = starts.get(cell)!
    const off = fill.get(cell) ?? 0
    order[base + off] = i
    fill.set(cell, off + 1)
  }

  // Pass 3 — priority-order WITHIN each cell so a prefix of the tile range is a representative
  // (stratified-random) subset. Sorting each block is O(count log count) per tile; Σ = O(N log·).
  const tiles: PyramidTile[] = []
  for (const cell of sortedCells) {
    const start = starts.get(cell)!
    const count = cellCounts.get(cell)!
    const block = order.subarray(start, start + count)
    // Stable in-place sort of the block by per-point priority (ties by index → total order).
    const arr = Array.from(block)
    arr.sort((a, b) => {
      const pa = pointPriority(a, seed)
      const pb = pointPriority(b, seed)
      return pa < pb ? -1 : pa > pb ? 1 : a - b
    })
    block.set(arr)
    const tileX = cell % gridSide
    const tileY = Math.floor(cell / gridSide)
    tiles.push({ tileX, tileY, start, count, bounds: tileBounds(tileX, tileY, bounds, gridSide) })
  }

  return { order, tiles, gridSide, maxDepth, tilePointCap, bounds, total: kept }
}

/** Do two world rectangles overlap (touching edges DON'T count — a strict, non-empty overlap)? */
function intersects(a: DensityBounds, b: DensityBounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

/**
 * The derived quadtree LEVEL for a zoom over a pyramid: 0 when the whole data extent fits the
 * viewport (the viewport world-span ≥ the data span), +1 per halving of the visible world span,
 * clamped to `[0, maxDepth]`. Higher zoom ⇒ higher level ⇒ finer on-screen detail. Pure + exported
 * so the "correct level for a given zoom" property is testable without a render.
 */
export function levelForZoom(pyramid: TilePyramid, viewport: DensityBounds): number {
  const dataSpan = Math.max(pyramid.bounds.maxX - pyramid.bounds.minX, pyramid.bounds.maxY - pyramid.bounds.minY)
  const viewSpan = Math.max(viewport.maxX - viewport.minX, viewport.maxY - viewport.minY)
  if (!(dataSpan > 0) || !(viewSpan > 0)) return 0
  // ratio = how many times the data span is bigger than what's on screen → log2 = zoom-in depth.
  const ratio = dataSpan / viewSpan
  const level = Math.floor(Math.log2(Math.max(1, ratio)))
  return level < 0 ? 0 : level > pyramid.maxDepth ? pyramid.maxDepth : level
}

/**
 * Select the tiles to draw for a viewport at a zoom — the per-frame, O(visible-tiles) viewport-LOD
 * step. Keeps ONLY the tiles intersecting `viewport`, caps each to a zoom-matched `perTileBudget`
 * (so the total drawn ≈ `targetPoints` regardless of N — a constant frame cost), and returns each
 * selected tile's zero-copy draw prefix `[start, start+drawCount)` into `pyramid.order`.
 *
 * `zoom` is accepted for API symmetry with the deck OrthographicView pose; the actual budget is
 * derived from the number of VISIBLE tiles (which itself tracks zoom via the `viewport` world span),
 * so a caller may pass any zoom. An empty viewport (no tile overlaps) → an empty selection.
 */
export function selectTiles(
  pyramid: TilePyramid,
  viewport: DensityBounds,
  zoom: number,
  opts: SelectTilesOptions = {},
): TileSelection {
  void zoom // budget derives from visible-tile count; `zoom` kept for call-site symmetry.
  const target = Math.max(1, Math.floor(opts.targetPoints ?? DEFAULT_TILE_TARGET_POINTS))
  const level = levelForZoom(pyramid, viewport)

  // Pass 1 — which non-empty tiles intersect the viewport (O(nonEmptyTiles), bounded by gridSide²,
  // independent of N). A degenerate/zero-area viewport yields no strict overlap → empty selection.
  const visible: PyramidTile[] = []
  for (const t of pyramid.tiles) {
    if (intersects(t.bounds, viewport)) visible.push(t)
  }
  const visibleTileCount = visible.length
  if (visibleTileCount === 0) {
    return { tiles: [], level, perTileBudget: 0, visibleTileCount: 0, drawnPoints: 0 }
  }

  // Zoom-matched per-tile budget: spread the total target across the visible tiles, clamped to the
  // pyramid's per-tile cap. Many visible tiles (far zoom) → small budget → coarse; few (near zoom)
  // → budget exceeds each tile's count → full fidelity.
  const perTileBudget = Math.min(
    pyramid.tilePointCap,
    Math.max(1, Math.round(target / visibleTileCount)),
  )

  // Optional hard tile cap (safety for a fully-zoomed-out viewport): keep the tiles with the MOST
  // points (they dominate the picture) so the draw stays bounded without a spatial bias.
  let chosen = visible
  const maxTiles = opts.maxTiles != null ? Math.max(1, Math.floor(opts.maxTiles)) : undefined
  if (maxTiles != null && visible.length > maxTiles) {
    chosen = [...visible].sort((a, b) => b.count - a.count).slice(0, maxTiles)
  }

  let drawnPoints = 0
  const tiles: SelectedTile[] = chosen.map(t => {
    const drawCount = Math.min(t.count, perTileBudget)
    drawnPoints += drawCount
    return {
      tileX: t.tileX,
      tileY: t.tileY,
      start: t.start,
      drawCount,
      fullCount: t.count,
      bounds: t.bounds,
    }
  })

  return { tiles, level, perTileBudget, visibleTileCount, drawnPoints }
}

/**
 * Gather the resident buffers through `pyramid.order` ONCE into a reordered copy so every tile's
 * range is CONTIGUOUS (and thus its draw prefix is a zero-copy `.subarray`). This is the tiling
 * twin of ChunkedScatter's one-time LOD copy: called a single time per (dataset / pyramid), never
 * per frame. `elemsPerPoint` is 2 for interleaved xy, 1 for a per-point code/value column.
 * A nullish `src` passes through unchanged (no allocation).
 */
export function reorderByPyramid<
  T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array,
>(src: T | null | undefined, pyramid: TilePyramid, elemsPerPoint: number): T | null | undefined {
  if (!src) return src
  const epp = Math.max(1, Math.floor(elemsPerPoint))
  const order = pyramid.order
  const Ctor = src.constructor as { new (length: number): T }
  const out = new Ctor(order.length * epp)
  for (let k = 0; k < order.length; k++) {
    const srcBase = order[k] * epp
    const dstBase = k * epp
    for (let e = 0; e < epp; e++) out[dstBase + e] = src[srcBase + e]
  }
  return out
}

/**
 * A zero-copy VIEW of a selected tile's draw prefix within a REORDERED buffer (one produced by
 * {@link reorderByPyramid}). Mirrors chunking.ts's `subarrayView`: `.subarray` shares the same
 * underlying `ArrayBuffer` — no allocation, no copy — so N per-tile layers reference regions of one
 * reordered array. `elemsPerPoint` is the elements-per-point for the attribute (2 for xy, 1 else).
 */
export function tileView<
  T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array,
>(reordered: T, tile: SelectedTile, elemsPerPoint: number): T {
  const epp = Math.max(1, Math.floor(elemsPerPoint))
  const begin = tile.start * epp
  const end = begin + tile.drawCount * epp
  return reordered.subarray(begin, end) as T
}
