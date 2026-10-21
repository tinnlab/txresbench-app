// chunking.ts — pure, testable 10M+ chunk-planning + GPU-memory-budget math (ITEM-62).
//
// Rendering 10M+ points as ONE deck.gl ScatterplotLayer means uploading ONE huge
// interleaved buffer (positions f32×2 + colors u8×4 ≈ 12 B/point → ~120 MB at 10M),
// which risks GPU max-buffer-size limits and stalls the main thread during upload. The
// multi-chunk path (ChunkedScatter) instead splits the dataset into N layers, each fed a
// zero-copy `.subarray` VIEW of the shared big typed arrays — so per-layer VRAM is capped
// and uploads are incremental. This module is the pure planning core: it decides the chunk
// boundaries under a per-layer byte budget, offers zero-copy views, and — when even
// chunking can't fit the dataset in the aggregate VRAM budget — recommends an LOD stride.
//
// No deck.gl / DOM / React dependency: plain math over counts, so it unit-tests in node.
// Generic naming (no domain terms) — this is framework/domain-agnostic scale infra.

const F32_BYTES = 4
const U8_BYTES = 1

/** Attributes a point contributes to per-layer VRAM. Defaults model the ChunkedScatter
 *  layout: interleaved xy (2×f32) + RGBA (4×u8) = 12 B/point. */
export interface BytesPerPointOpts {
  /** include the interleaved position attribute (2×f32 = 8 B). default true */
  position?: boolean
  /** include the RGBA color attribute (4×u8 = 4 B). default true */
  color?: boolean
  /** number of EXTRA per-point value attributes, each a f32 (4 B). default 0 */
  valueAttrs?: number
}

/** Bytes a single point occupies on the GPU for the given attribute set. */
export function bytesPerPoint(opts: BytesPerPointOpts = {}): number {
  const position = opts.position ?? true
  const color = opts.color ?? true
  const valueAttrs = Math.max(0, Math.floor(opts.valueAttrs ?? 0))
  let bytes = 0
  if (position) bytes += 2 * F32_BYTES // 8
  if (color) bytes += 4 * U8_BYTES // 4
  bytes += valueAttrs * F32_BYTES
  return bytes
}

/** Estimated VRAM bytes for a layer of `count` points with the given attribute set. */
export function estimateLayerBytes(count: number, opts: BytesPerPointOpts = {}): number {
  return Math.max(0, Math.floor(count)) * bytesPerPoint(opts)
}

/** A single planned chunk = a contiguous half-open point range [start, start+count). */
export interface Chunk {
  /** 0-based chunk ordinal. */
  readonly index: number
  /** first point index (inclusive). */
  readonly start: number
  /** number of points in this chunk. */
  readonly count: number
  /** byte offset of this chunk's first point into a tightly-packed buffer
   *  (`start * bytesPerPoint`) — for callers packing all attrs into one ArrayBuffer. */
  readonly byteStart: number
}

export interface PlanChunksOptions {
  /** hard per-layer point cap (avoids a single over-large attribute upload). */
  maxPointsPerChunk: number
  /** per-layer (per-chunk) VRAM byte budget — caps each chunk's resident size. */
  gpuByteBudget: number
  /** bytes each point occupies (from `bytesPerPoint`). */
  bytesPerPoint: number
  /** max simultaneous layers/chunks the renderer keeps resident. The AGGREGATE VRAM
   *  budget is `maxChunks × gpuByteBudget`; exceeding it → over-budget + an LOD stride.
   *  default 256. */
  maxChunks?: number
}

export type ChunkVerdict = 'ok' | 'over-budget'

export interface ChunkPlan {
  /** total points the plan covers. */
  readonly total: number
  /** the contiguous, gap-free, non-overlapping chunks covering [0, total). */
  readonly chunks: readonly Chunk[]
  readonly chunkCount: number
  /** effective per-chunk point cap actually used = min(maxPointsPerChunk, budget cap). */
  readonly pointsPerChunk: number
  readonly bytesPerPoint: number
  /** VRAM bytes for ALL `total` points (`total × bytesPerPoint`). */
  readonly bytesEstimate: number
  /** the per-layer byte budget the plan honoured. */
  readonly perChunkByteBudget: number
  /** points that fit in one layer under `gpuByteBudget`. */
  readonly budgetPointsPerChunk: number
  readonly maxChunks: number
  readonly verdict: ChunkVerdict
  /** 1 when the whole dataset fits; when `over-budget`, the downsample stride that brings
   *  the visible count within the aggregate capacity (`maxChunks × pointsPerChunk`). */
  readonly lodStride: number
}

const DEFAULT_MAX_CHUNKS = 256

/**
 * Hard ceiling on a SINGLE per-layer attribute allocation (PERFORMANCE_PLAN.md Phase 2). Chrome/
 * V8 reject a single `ArrayBuffer`/GPU buffer far below its address space; ~1 GiB is the safe
 * per-buffer bound below which a `ScatterplotLayer`'s interleaved upload never trips the
 * single-alloc limit. `planChunks` clamps every chunk's byte budget under this so no ONE chunk
 * asks for a >1 GiB buffer — the thing that stalls 10M+ load. At 12 B/point that is ~89.5M points
 * per chunk, so a 10M dataset stays a single, comfortably-under-cap chunk.
 */
export const MAX_SINGLE_LAYER_BYTES = 1024 * 1024 * 1024

/**
 * Plan how to split `total` points into chunks, each ≤ `maxPointsPerChunk` AND ≤ the
 * per-layer `gpuByteBudget`. The effective per-chunk cap is the smaller of the two, so a
 * tight budget FORCES more (smaller) chunks. When the dataset can't fit in the aggregate
 * VRAM budget (`maxChunks × pointsPerChunk` points), the verdict is `over-budget` and
 * `lodStride` recommends a downsample factor for an LOD overview.
 */
export function planChunks(total: number, opts: PlanChunksOptions): ChunkPlan {
  const bpp = Math.max(1, Math.floor(opts.bytesPerPoint))
  const totalPts = Math.max(0, Math.floor(total))
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks ?? DEFAULT_MAX_CHUNKS))
  // Clamp the per-layer byte budget under the single-alloc cap so no ONE chunk ever asks for a
  // >1 GiB buffer (the 10M+ load stall). A caller passing a larger `gpuByteBudget` is silently
  // held to the cap.
  const effectiveByteBudget = Math.min(opts.gpuByteBudget, MAX_SINGLE_LAYER_BYTES)
  const budgetPointsPerChunk = Math.max(1, Math.floor(effectiveByteBudget / bpp))
  // Hard point cap that guarantees a chunk's bytes stay under the single-alloc ceiling.
  const singleAllocPointCap = Math.max(1, Math.floor(MAX_SINGLE_LAYER_BYTES / bpp))
  const requestedMax = Math.max(1, Math.floor(opts.maxPointsPerChunk))
  const pointsPerChunk = Math.max(
    1,
    Math.min(requestedMax, budgetPointsPerChunk, singleAllocPointCap),
  )

  const chunks: Chunk[] = []
  let index = 0
  for (let start = 0; start < totalPts; start += pointsPerChunk) {
    const count = Math.min(pointsPerChunk, totalPts - start)
    chunks.push({ index, start, count, byteStart: start * bpp })
    index++
  }

  // Aggregate capacity: how many points fit given at most `maxChunks` layers, each holding
  // up to `pointsPerChunk`. If the dataset exceeds that, even chunking can't render it all
  // → recommend an LOD stride that downsamples to within the capacity.
  const aggregateCapacityPts = maxChunks * pointsPerChunk
  const overBudget = totalPts > aggregateCapacityPts

  return {
    total: totalPts,
    chunks,
    chunkCount: chunks.length,
    pointsPerChunk,
    bytesPerPoint: bpp,
    bytesEstimate: totalPts * bpp,
    perChunkByteBudget: effectiveByteBudget,
    budgetPointsPerChunk,
    maxChunks,
    verdict: overBudget ? 'over-budget' : 'ok',
    lodStride: overBudget ? lodStride(totalPts, aggregateCapacityPts) : 1,
  }
}

/**
 * Integer downsample stride to reduce `total` points to at most `targetVisible`: take
 * every Nth point. Returns 1 when the data already fits (no downsampling). Used both for
 * the over-budget LOD recommendation in `planChunks` and directly by callers building a
 * downsampled overview.
 */
export function lodStride(total: number, targetVisible: number): number {
  const t = Math.max(0, Math.floor(total))
  const target = Math.max(1, Math.floor(targetVisible))
  if (t <= target) return 1
  return Math.ceil(t / target)
}

/**
 * Zero-copy VIEW of a chunk's slice of a packed typed array — the crux of the 10M path:
 * `.subarray` shares the SAME underlying `ArrayBuffer` (no allocation, no copy), so N
 * per-chunk layers reference regions of ONE big positions/colors buffer. `stride` is the
 * elements-per-point for that attribute (2 for interleaved xy, 4 for RGBA).
 */
export function subarrayView<
  T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array,
>(buf: T, chunk: Chunk, stride: number): T {
  const s = Math.max(1, Math.floor(stride))
  const begin = chunk.start * s
  const end = begin + chunk.count * s
  return buf.subarray(begin, end) as T
}

/**
 * Downsample a packed per-point buffer by keeping every `stride`-th point (0-based): a NEW,
 * contiguous typed array holding points 0, stride, 2·stride, … with all `elemsPerPoint`
 * interleaved elements of each kept point copied verbatim. This is the LOD-overview
 * companion to the over-budget verdict from `planChunks`: unlike `subarrayView` it CANNOT be
 * zero-copy (a strided pick isn't a contiguous slice), so it allocates once — call it a
 * single time to build the reduced overview, then chunk THAT (which now fits the budget).
 *
 * Kept-point count = `ceil(totalPoints / stride)`. `stride ≤ 1` returns the input unchanged
 * (no allocation) — the full-detail path. Preserves the input's typed-array subtype.
 */
export function strideSample<
  T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array,
>(buf: T, stride: number, elemsPerPoint: number): T {
  const s = Math.max(1, Math.floor(stride))
  const epp = Math.max(1, Math.floor(elemsPerPoint))
  if (s <= 1) return buf
  const totalPoints = Math.floor(buf.length / epp)
  const keptCount = Math.ceil(totalPoints / s)
  const Ctor = buf.constructor as { new (length: number): T }
  const out = new Ctor(keptCount * epp)
  for (let k = 0; k < keptCount; k++) {
    const srcBase = k * s * epp
    const dstBase = k * epp
    for (let e = 0; e < epp; e++) out[dstBase + e] = buf[srcBase + e]
  }
  return out
}
