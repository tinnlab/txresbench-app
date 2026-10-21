// pointIndex.ts — a flat, static, typed-array 2D KD-tree over interleaved xy
// positions (the kdbush algorithm, https://github.com/mourner/kdbush, IMPLEMENTED
// HERE rather than depended on so viz-core stays dependency-free and extractable).
//
// Purpose (research item #2): the O(log n) spatial foundation for hover pick
// (`nearest` / `within`), lasso prefilter (`range` + `polygonCandidates`), and
// density-adaptive LOD. It REPLACES the O(N) coordinate scan in the
// candidate-narrowing path of `data/selection.ts` (`bboxCandidates` /
// `selectInPolygon`): a lasso hit-test narrows via the tree instead of scanning
// all N points.
//
// Design notes:
//   • Zero-copy: the tree never copies coordinates. It holds a reference to the
//     caller's interleaved `positions` Float32Array (length N*2, [x0,y0,x1,y1,…])
//     and an `ids` index array (Uint32Array) that is partitioned IN PLACE by the
//     KD sort. Every read is `positions[2*id]` / `positions[2*id+1]`. No per-point
//     objects are ever allocated.
//   • Static: build once (O(N log N) Floyd–Rivest quickselect partitioning),
//     query many. There is no insert/remove — rebuild on data change.
//   • NaN handling: a point with a non-finite x or y is PARKED — excluded from the
//     `ids` set at build time, so it can never appear in any query result.
//   • Allocation-light queries: `range`/`within` reuse a scratch traversal stack
//     and a scratch result buffer, materialising only the returned compact
//     Uint32Array. `nearest` is a recursive branch-and-bound that allocates nothing.

/** The point indices reported are dense indices into the ORIGINAL positions array. */
export interface PointIndex {
  /** Number of INDEXED points (finite points only; parked NaN points excluded). */
  readonly size: number
  /**
   * All point indices whose position falls inside the inclusive axis-aligned bbox
   * `[minX,minY]‥[maxX,maxY]`. O(log N + k). Order is unspecified.
   */
  range(minX: number, minY: number, maxX: number, maxY: number): Uint32Array
  /** All point indices within Euclidean distance `r` of `(x,y)` (inclusive). O(log N + k). */
  within(x: number, y: number, r: number): Uint32Array
  /** The single nearest point index to `(x,y)`, or -1 if the index is empty. */
  nearest(x: number, y: number): number
}

/**
 * Build a static KD-tree over interleaved xy `positions` (length N*2). `nodeSize`
 * is the leaf-bucket size (kdbush default 64 — larger buckets = faster build +
 * smaller tree, marginally slower point tests). O(N log N).
 */
export function buildPointIndex(positions: Float32Array, nodeSize = 64): PointIndex {
  return new KDPointIndex(positions, nodeSize)
}

/**
 * A build-once cache of `PointIndex` keyed by the positions buffer IDENTITY (MD-11). A grid's
 * lasso/rect commit over a multi-dataset cell would otherwise rebuild the O(N log N) KD-tree on
 * EVERY commit; this returns the SAME index for a stable buffer. Keyed by a `WeakMap`, so when a
 * dataset's positions buffer is replaced (new gen) or the dataset is evicted, the old index is
 * garbage-collected with its buffer — no manual eviction, no leak.
 */
export interface PointIndexCache {
  /** The cached index for `positions` (built + cached on first ask, reused thereafter). */
  get(positions: Float32Array): PointIndex
}

export function makePointIndexCache(build: typeof buildPointIndex = buildPointIndex): PointIndexCache {
  const cache = new WeakMap<Float32Array, PointIndex>()
  return {
    get(positions) {
      let idx = cache.get(positions)
      if (!idx) {
        idx = build(positions)
        cache.set(positions, idx)
      }
      return idx
    },
  }
}

class KDPointIndex implements PointIndex {
  readonly size: number
  private readonly positions: Float32Array
  private readonly ids: Uint32Array
  private readonly nodeSize: number

  // Reusable query scratch (single-threaded JS, queries never re-enter): an
  // explicit traversal stack of {left,right,axis} triples + a result buffer.
  private readonly _stack: number[] = []
  private readonly _result: number[] = []

  // Recursive-nearest branch-and-bound state (instance fields → zero per-query alloc).
  private _qx = 0
  private _qy = 0
  private _bestId = -1
  private _bestD2 = Infinity

  constructor(positions: Float32Array, nodeSize: number) {
    this.positions = positions
    this.nodeSize = Math.max(1, nodeSize | 0)

    const n = positions.length >>> 1
    // Park non-finite points: count the finite ones, then fill `ids` with only them.
    let finite = 0
    for (let i = 0; i < n; i++) {
      const x = positions[2 * i]
      const y = positions[2 * i + 1]
      if (x === x && y === y && x !== Infinity && x !== -Infinity && y !== Infinity && y !== -Infinity) {
        finite++
      }
    }
    const ids = new Uint32Array(finite)
    let j = 0
    for (let i = 0; i < n; i++) {
      const x = positions[2 * i]
      const y = positions[2 * i + 1]
      if (x === x && y === y && x !== Infinity && x !== -Infinity && y !== Infinity && y !== -Infinity) {
        ids[j++] = i
      }
    }
    this.ids = ids
    this.size = finite

    if (finite > 1) {
      this.sortKD(0, finite - 1, 0)
    }
  }

  // ── build: recursive KD partition via Floyd–Rivest quickselect ────────────

  private sortKD(left: number, right: number, axis: number): void {
    if (right - left <= this.nodeSize) return
    const m = (left + right) >> 1
    this.select(m, left, right, axis)
    this.sortKD(left, m - 1, 1 - axis)
    this.sortKD(m + 1, right, 1 - axis)
  }

  /** Coordinate of the point referenced by ids[k] on `axis` (0=x, 1=y). */
  private coordAt(k: number, axis: number): number {
    const id = this.ids[k]
    return this.positions[2 * id + axis]
  }

  private swap(i: number, k: number): void {
    const ids = this.ids
    const t = ids[i]
    ids[i] = ids[k]
    ids[k] = t
  }

  /**
   * Partition `ids[left..right]` so that `ids[k]` is the k-th smallest by `axis`
   * coordinate and everything left/right of it is smaller/larger. Floyd–Rivest
   * quickselect, ported from kdbush.
   */
  private select(k: number, left: number, right: number, axis: number): void {
    while (right > left) {
      if (right - left > 600) {
        const n = right - left + 1
        const m = k - left + 1
        const z = Math.log(n)
        const s = 0.5 * Math.exp((2 * z) / 3)
        const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (m - n / 2 < 0 ? -1 : 1)
        const newLeft = Math.max(left, Math.floor(k - (m * s) / n + sd))
        const newRight = Math.min(right, Math.floor(k + ((n - m) * s) / n + sd))
        this.select(k, newLeft, newRight, axis)
      }

      const t = this.coordAt(k, axis)
      let i = left
      let j = right

      this.swap(left, k)
      if (this.coordAt(right, axis) > t) this.swap(left, right)

      while (i < j) {
        this.swap(i, j)
        i++
        j--
        while (this.coordAt(i, axis) < t) i++
        while (this.coordAt(j, axis) > t) j--
      }

      if (this.coordAt(left, axis) === t) {
        this.swap(left, j)
      } else {
        j++
        this.swap(j, right)
      }

      if (j <= k) left = j + 1
      if (k <= j) right = j - 1
    }
  }

  // ── queries ───────────────────────────────────────────────────────────────

  range(minX: number, minY: number, maxX: number, maxY: number): Uint32Array {
    const { ids, positions, nodeSize } = this
    const stack = this._stack
    const result = this._result
    stack.length = 0
    result.length = 0
    if (ids.length === 0) return new Uint32Array(0)

    stack.push(0, ids.length - 1, 0)
    while (stack.length) {
      const axis = stack.pop() as number
      const right = stack.pop() as number
      const left = stack.pop() as number

      if (right - left <= nodeSize) {
        for (let i = left; i <= right; i++) {
          const id = ids[i]
          const x = positions[2 * id]
          const y = positions[2 * id + 1]
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(id)
        }
        continue
      }

      const m = (left + right) >> 1
      const id = ids[m]
      const x = positions[2 * id]
      const y = positions[2 * id + 1]
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(id)

      const nextAxis = 1 - axis
      if (axis === 0 ? minX <= x : minY <= y) stack.push(left, m - 1, nextAxis)
      if (axis === 0 ? maxX >= x : maxY >= y) stack.push(m + 1, right, nextAxis)
    }
    return Uint32Array.from(result)
  }

  within(x: number, y: number, r: number): Uint32Array {
    const { ids, positions, nodeSize } = this
    const stack = this._stack
    const result = this._result
    stack.length = 0
    result.length = 0
    if (ids.length === 0 || !(r >= 0)) return new Uint32Array(0)

    const r2 = r * r
    stack.push(0, ids.length - 1, 0)
    while (stack.length) {
      const axis = stack.pop() as number
      const right = stack.pop() as number
      const left = stack.pop() as number

      if (right - left <= nodeSize) {
        for (let i = left; i <= right; i++) {
          const id = ids[i]
          const dx = positions[2 * id] - x
          const dy = positions[2 * id + 1] - y
          if (dx * dx + dy * dy <= r2) result.push(id)
        }
        continue
      }

      const m = (left + right) >> 1
      const id = ids[m]
      const px = positions[2 * id]
      const py = positions[2 * id + 1]
      const dx = px - x
      const dy = py - y
      if (dx * dx + dy * dy <= r2) result.push(id)

      const nextAxis = 1 - axis
      if (axis === 0 ? x - r <= px : y - r <= py) stack.push(left, m - 1, nextAxis)
      if (axis === 0 ? x + r >= px : y + r >= py) stack.push(m + 1, right, nextAxis)
    }
    return Uint32Array.from(result)
  }

  nearest(x: number, y: number): number {
    if (this.ids.length === 0) return -1
    this._qx = x
    this._qy = y
    this._bestId = -1
    this._bestD2 = Infinity
    this.searchNearest(0, this.ids.length - 1, 0)
    return this._bestId
  }

  /** Branch-and-bound NN: descend the near child fully, then prune the far child. */
  private searchNearest(left: number, right: number, axis: number): void {
    const { ids, positions, nodeSize } = this
    const qx = this._qx
    const qy = this._qy

    if (right - left <= nodeSize) {
      for (let i = left; i <= right; i++) {
        const id = ids[i]
        const dx = positions[2 * id] - qx
        const dy = positions[2 * id + 1] - qy
        const d2 = dx * dx + dy * dy
        if (d2 < this._bestD2) {
          this._bestD2 = d2
          this._bestId = id
        }
      }
      return
    }

    const m = (left + right) >> 1
    const id = ids[m]
    const px = positions[2 * id]
    const py = positions[2 * id + 1]
    const dx = px - qx
    const dy = py - qy
    const d2 = dx * dx + dy * dy
    if (d2 < this._bestD2) {
      this._bestD2 = d2
      this._bestId = id
    }

    const diff = axis === 0 ? qx - px : qy - py
    const nextAxis = 1 - axis
    if (diff <= 0) {
      this.searchNearest(left, m - 1, nextAxis)
      if (diff * diff < this._bestD2) this.searchNearest(m + 1, right, nextAxis)
    } else {
      this.searchNearest(m + 1, right, nextAxis)
      if (diff * diff < this._bestD2) this.searchNearest(left, m - 1, nextAxis)
    }
  }
}

/**
 * Narrow a polygon (lasso) hit-test to a candidate set via the KD-tree: compute the
 * polygon's axis-aligned bounding box, then `index.range(...)` it. A point OUTSIDE the
 * bbox can never be inside the polygon, so the returned set is a SUPERSET of the true
 * polygon selection — feed it as `candidates` to `selectInPolygon` (data/selection.ts)
 * and the costly point-in-polygon test runs on O(candidates) instead of O(N). Returns
 * an empty set for a degenerate (<3 vertex) ring.
 */
export function polygonCandidates(
  index: PointIndex,
  polygon: readonly (readonly [number, number])[],
): Uint32Array {
  if (polygon.length < 3) return new Uint32Array(0)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of polygon) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return index.range(minX, minY, maxX, maxY)
}
