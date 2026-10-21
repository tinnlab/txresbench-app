// fixtures.ts — the synthetic fixture generator + `FixtureSource` (ITEM-2). The
// results-streaming backend doesn't exist yet, so the viz is proven end-to-end on
// generated data that is byte-faithful to the WIRE CONTRACT (wire.ts): real
// `ArrayBuffer`s in the exact octet framings, and a `FixtureSource` implementing
// `DataSource` over them — so the whole `ArrayBuffer → TypedArray → deck.gl attribute`
// path runs for real; only the numbers are synthetic. Deterministic (seeded).
//
// GENERIC names in the API; the fixture may use readable demo labels (DEC-28).

import {
  type DataSource,
  type DatasetCatalog,
  type Positions,
  type SparseColumn,
  type CategoricalColumn,
  type ContinuousColumn,
  type ImageUnderlay,
  type DataTable,
  type GraphData,
  type CatalogEntry,
  decodePositions,
  decodeSparseColumn,
  decodeCategorical,
  decodeContinuous,
} from './wire'
import { scaleAffine } from './image'

// ── seeded RNG (mulberry32) + a Box–Muller normal ────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function makeNormal(rng: () => number): () => number {
  return () => {
    let u = 0
    let v = 0
    while (u === 0) u = rng()
    while (v === 0) v = rng()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

export interface FixtureOptions {
  seed?: number
  pointCount?: number
  groupCount?: number
  /** value-column keys (readable demo labels are fine here) */
  valueColumns?: string[]
  batchCount?: number
  /**
   * MULTI-DATASOURCE (ITEM-15): a canonical id ("barcode") per local row. When set, the source
   * exposes `pointIds()` so two fixtures sharing barcodes AUTO-LINK selection. Omit ⇒ no `pointIds`
   * method (the dataset is an ISOLATED identity space — never falsely linked on raw indices).
   */
  pointIds?: Uint32Array
}

const DEFAULT_VALUE_COLUMNS = [
  'Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E', 'Feature F',
  'Feature G', 'Feature H', 'Feature I', 'Feature J', 'Feature K', 'Feature L',
]

// ── binary encoders (produce the exact wire framings wire.ts decodes) ─────────
function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength)
  new Uint8Array(out).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  return out
}
function encodeFloat32(values: Float32Array): ArrayBuffer {
  return toArrayBuffer(values)
}
function encodeSparse(row: Uint32Array, value: Float32Array): ArrayBuffer {
  const n = row.length
  const buf = new ArrayBuffer(4 + n * 4 + n * 4)
  const dv = new DataView(buf)
  dv.setUint32(0, n, true)
  new Uint32Array(buf, 4, n).set(row)
  new Float32Array(buf, 4 + n * 4, n).set(value)
  return buf
}
function encodeCodes(codes: Uint16Array): ArrayBuffer {
  return toArrayBuffer(codes)
}

interface GeneratedFixture {
  catalog: DatasetCatalog
  layoutBuf: ArrayBuffer
  imageLayoutBuf: ArrayBuffer
  imageUnderlay: ImageUnderlay
  valueBufs: Map<string, ArrayBuffer>
  categoricalBufs: Map<string, { buf: ArrayBuffer; categories: string[] }>
  continuousBufs: Map<string, ArrayBuffer>
  table: DataTable
  graph: GraphData
}

/** Generate a complete synthetic dataset as raw wire buffers. */
export function generateFixture(opts: FixtureOptions = {}): GeneratedFixture {
  const seed = opts.seed ?? 42
  const N = opts.pointCount ?? 250_000
  // ≥2 groups: `pseudo[i] = k/(K-1)` divides by zero for K=1, and K=0 → k=-1 → `centroids[-1]` throws.
  const K = Math.max(2, opts.groupCount ?? 8)
  const values = opts.valueColumns ?? DEFAULT_VALUE_COLUMNS
  const batchCount = opts.batchCount ?? 3
  const rng = mulberry32(seed)
  const normal = makeNormal(rng)

  // group centroids on a rough circle in layout space.
  const centroids: [number, number][] = []
  for (let k = 0; k < K; k++) {
    const angle = (2 * Math.PI * k) / K
    centroids.push([Math.cos(angle) * 10, Math.sin(angle) * 10])
  }

  const layout = new Float32Array(N * 2)
  const groupCodes = new Uint16Array(N)
  const typeCodes = new Uint16Array(N)
  const batchCodes = new Uint16Array(N)
  const qcA = new Float32Array(N)
  const qcB = new Float32Array(N)
  const pseudo = new Float32Array(N)
  const valueDense: Float32Array[] = values.map(() => new Float32Array(N))

  for (let i = 0; i < N; i++) {
    const k = Math.min(K - 1, (rng() * K) | 0)
    groupCodes[i] = k
    typeCodes[i] = k % Math.min(K, 8)
    batchCodes[i] = (rng() * batchCount) | 0
    const cx = centroids[k][0]
    const cy = centroids[k][1]
    layout[i * 2] = cx + normal() * 1.4
    layout[i * 2 + 1] = cy + normal() * 1.4
    qcA[i] = 2000 + rng() * 8000
    qcB[i] = rng() * 0.15
    pseudo[i] = k / (K - 1) + normal() * 0.03
    for (let g = 0; g < values.length; g++) {
      if (g % K === k) valueDense[g][i] = 2 + rng() * 4
      else if (rng() < 0.05) valueDense[g][i] = rng() * 1.5
    }
  }

  // encode value columns sparsely (non-zero points only).
  const valueBufs = new Map<string, ArrayBuffer>()
  for (let g = 0; g < values.length; g++) {
    const dense = valueDense[g]
    let nnz = 0
    for (let i = 0; i < N; i++) if (dense[i] !== 0) nnz++
    const row = new Uint32Array(nnz)
    const val = new Float32Array(nnz)
    let j = 0
    for (let i = 0; i < N; i++) {
      if (dense[i] !== 0) {
        row[j] = i
        val[j] = dense[i]
        j++
      }
    }
    valueBufs.set(values[g], encodeSparse(row, val))
  }

  // image layout: place points on a raster grid.
  const IMG = 512
  const imageLayout = new Float32Array(N * 2)
  for (let i = 0; i < N; i++) {
    const k = groupCodes[i]
    const gx = ((k % 4) + 0.5) * (IMG / 4)
    const gy = ((k >> 2) + 0.5) * (IMG / 2)
    imageLayout[i * 2] = Math.max(0, Math.min(IMG, gx + normal() * 30))
    imageLayout[i * 2 + 1] = Math.max(0, Math.min(IMG, gy + normal() * 30))
  }
  const imageUnderlay = makeRaster(IMG, IMG, rng)

  // a bulk stat table (volcano/heatmap source): value columns × {effect, signif}.
  const effect = new Float32Array(values.length)
  const signif = new Float32Array(values.length)
  for (let g = 0; g < values.length; g++) {
    effect[g] = normal() * 2.5
    signif[g] = Math.abs(normal()) * 4 + Math.abs(effect[g])
  }
  const table: DataTable = {
    rowLabels: [...values],
    columns: { effect, signif },
  }

  // graph: a single path walking the groups in order.
  const graph: GraphData = {
    nodeKey: 'group',
    paths: [Array.from({ length: K }, (_, k) => k)],
  }

  const layouts: CatalogEntry[] = [
    { id: 'primary', kind: 'layout', label: 'Primary layout' },
    { id: 'image', kind: 'image', label: 'Image view' },
  ]
  const groupCats = Array.from({ length: K }, (_, k) => `Group ${k + 1}`)
  const typeCats = Array.from({ length: Math.min(K, 8) }, (_, k) => `Type ${k + 1}`)
  const batchCats = Array.from({ length: batchCount }, (_, b) => `Batch ${b + 1}`)

  const categoricalColumns: CatalogEntry[] = [
    { id: 'group', kind: 'categorical', label: 'Group', categories: groupCats },
    { id: 'type', kind: 'categorical', label: 'Type', categories: typeCats },
    { id: 'batch', kind: 'categorical', label: 'Batch', categories: batchCats },
  ]
  const continuousColumns: CatalogEntry[] = [
    { id: 'qcA', kind: 'continuous', label: 'QC A' },
    { id: 'qcB', kind: 'continuous', label: 'QC B' },
    { id: 'pseudo', kind: 'continuous', label: 'Pseudo-order' },
  ]

  const catalog: DatasetCatalog = {
    datasetId: `fixture-${seed}`,
    pointCount: N,
    layouts,
    valueColumns: [...values],
    categoricalColumns,
    continuousColumns,
    hasImage: true,
  }

  const categoricalBufs = new Map<string, { buf: ArrayBuffer; categories: string[] }>([
    ['group', { buf: encodeCodes(groupCodes), categories: groupCats }],
    ['type', { buf: encodeCodes(typeCodes), categories: typeCats }],
    ['batch', { buf: encodeCodes(batchCodes), categories: batchCats }],
  ])
  const continuousBufs = new Map<string, ArrayBuffer>([
    ['qcA', encodeFloat32(qcA)],
    ['qcB', encodeFloat32(qcB)],
    ['pseudo', encodeFloat32(pseudo)],
  ])

  return {
    catalog,
    layoutBuf: encodeFloat32(layout),
    imageLayoutBuf: encodeFloat32(imageLayout),
    imageUnderlay,
    valueBufs,
    categoricalBufs,
    continuousBufs,
    table,
    graph,
  }
}

/** A synthetic soft-blob raster (RGBA) so the underlay reads as a real background. */
function makeRaster(width: number, height: number, rng: () => number): ImageUnderlay {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const n = rng() * 20
    data[o] = 235 - n
    data[o + 1] = 205 - n
    data[o + 2] = 220 - n
    data[o + 3] = 255
  }
  return { data, width, height, channels: 4, affine: scaleAffine(1) }
}

/** A `DataSource` backed by a generated fixture — the round-1 data plane. */
export class FixtureSource implements DataSource {
  private readonly fx: GeneratedFixture
  /** MULTI-DATASOURCE (ITEM-15): present ONLY when `opts.pointIds` was supplied — a bare fixture has
   *  NO canonical namespace (isolated), so unrelated fixtures never auto-link on raw indices. */
  pointIds?: (layoutId?: string) => Promise<Uint32Array>

  constructor(opts: FixtureOptions = {}) {
    this.fx = generateFixture(opts)
    if (opts.pointIds) {
      const ids = opts.pointIds
      this.pointIds = async () => ids
    }
  }

  async catalog(): Promise<DatasetCatalog> {
    return this.fx.catalog
  }

  async positions(layoutId: string): Promise<Positions> {
    if (layoutId === 'image') return decodePositions(this.fx.imageLayoutBuf)
    return decodePositions(this.fx.layoutBuf)
  }

  async valueColumn(key: string): Promise<SparseColumn> {
    const buf = this.fx.valueBufs.get(key)
    if (!buf) throw new Error(`fixture has no value column "${key}"`)
    return decodeSparseColumn(buf, this.fx.catalog.pointCount)
  }

  async categorical(key: string): Promise<CategoricalColumn> {
    const entry = this.fx.categoricalBufs.get(key)
    if (!entry) throw new Error(`fixture has no categorical "${key}"`)
    return decodeCategorical(entry.buf, entry.categories)
  }

  async continuous(key: string): Promise<ContinuousColumn> {
    const buf = this.fx.continuousBufs.get(key)
    if (!buf) throw new Error(`fixture has no continuous "${key}"`)
    return decodeContinuous(buf)
  }

  async imageUnderlay(): Promise<ImageUnderlay> {
    return this.fx.imageUnderlay
  }

  async table(_name?: string): Promise<DataTable> {
    return this.fx.table
  }

  async graph(_id?: string): Promise<GraphData> {
    return this.fx.graph
  }
}
