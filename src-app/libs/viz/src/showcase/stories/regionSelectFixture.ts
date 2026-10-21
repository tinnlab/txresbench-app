// regionSelectFixture.ts — a synthetic `DataSource` for the region-select linked demo. The SAME
// points carry TWO layouts — a PHYSICAL `spatial` layout (points scattered into spatial DOMAINS
// over a tissue image) and a UMAP-like `primary` embedding (well-separated blobs per group) —
// plus a `group` categorical and a small tissue raster whose regions are TINTED per domain (so a
// lassoed tissue region is predominantly one point type, and the linked embedding blob lights up).
//
// Deterministic (seeded). GENERIC wire names (DEC-28); readable demo labels are fine in fixtures.

import type {
  DataSource,
  DatasetCatalog,
  Positions,
  SparseColumn,
  CategoricalColumn,
  ContinuousColumn,
  ImageUnderlay,
  DataTable,
  GraphData,
  CatalogEntry,
} from '../../viz-core/data/wire'
import { IDENTITY_AFFINE } from '../../viz-core/data/image'
import { CATEGORICAL_PALETTE } from '../../viz-core/data/color'

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

export interface RegionSelectFixtureOptions {
  seed?: number
  pointCount?: number
  groupCount?: number
  /** tissue image side in px (also the physical-coordinate extent). */
  imageSize?: number
}

interface Generated {
  catalog: DatasetCatalog
  spatial: Float32Array
  embedding: Float32Array
  groupCodes: Uint16Array
  categories: string[]
  signal: Float32Array
  underlay: ImageUnderlay
}

/** Group centroids on a 3-wide grid over the tissue → spatial DOMAINS. */
function domainCentroid(k: number, size: number): [number, number] {
  const cols = 3
  const rows = 2
  const col = k % cols
  const row = Math.floor(k / cols) % rows
  return [((col + 0.5) * size) / cols, ((row + 0.5) * size) / rows]
}

function generate(opts: RegionSelectFixtureOptions): Generated {
  const seed = opts.seed ?? 7
  const N = opts.pointCount ?? 8000
  const K = opts.groupCount ?? 6
  const SIZE = opts.imageSize ?? 360
  const rng = mulberry32(seed)
  const normal = makeNormal(rng)

  const spatialSigma = SIZE / 14
  const embRadius = 9

  const spatial = new Float32Array(N * 2)
  const embedding = new Float32Array(N * 2)
  const groupCodes = new Uint16Array(N)
  const signal = new Float32Array(N)

  const domains: [number, number][] = []
  const embCentroids: [number, number][] = []
  for (let k = 0; k < K; k++) {
    domains.push(domainCentroid(k, SIZE))
    const angle = (2 * Math.PI * k) / K
    embCentroids.push([Math.cos(angle) * embRadius, Math.sin(angle) * embRadius])
  }

  for (let i = 0; i < N; i++) {
    const k = Math.min(K - 1, (rng() * K) | 0)
    groupCodes[i] = k
    // physical spatial coords, clamped into the tissue extent.
    const [dx, dy] = domains[k]
    spatial[i * 2] = Math.max(0, Math.min(SIZE, dx + normal() * spatialSigma))
    spatial[i * 2 + 1] = Math.max(0, Math.min(SIZE, dy + normal() * spatialSigma))
    // UMAP-like embedding: a tight blob per group.
    const [ex, ey] = embCentroids[k]
    embedding[i * 2] = ex + normal() * 1.1
    embedding[i * 2 + 1] = ey + normal() * 1.1
    // a synthetic continuous "signal": a per-group mean + noise (a continuous color-by option).
    signal[i] = k / (K - 1) + rng() * 0.15
  }

  const underlay = makeTissue(SIZE, SIZE, domains, rng)

  const categories = Array.from({ length: K }, (_, k) => `Domain ${k + 1}`)
  const layouts: CatalogEntry[] = [
    { id: 'spatial', kind: 'image', label: 'Tissue (physical)' },
    { id: 'primary', kind: 'layout', label: 'Embedding (UMAP)' },
  ]
  const catalog: DatasetCatalog = {
    datasetId: `region-select-${seed}`,
    pointCount: N,
    layouts,
    valueColumns: ['signal'],
    categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Domain', categories }],
    continuousColumns: [{ id: 'signal', kind: 'continuous', label: 'Signal' }],
    hasImage: true,
  }

  return { catalog, spatial, embedding, groupCodes, categories, signal, underlay }
}

/** A faint tissue raster tinted per spatial DOMAIN (nearest-centroid), so regions read visibly. */
function makeTissue(
  width: number,
  height: number,
  domains: readonly [number, number][],
  rng: () => number,
): ImageUnderlay {
  const data = new Uint8Array(width * height * 4)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      // nearest domain centroid → its palette tint, lightened toward white.
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < domains.length; k++) {
        const dx = px - domains[k][0]
        const dy = py - domains[k][1]
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      const [r, g, b] = CATEGORICAL_PALETTE[best % CATEGORICAL_PALETTE.length]
      const n = rng() * 8
      const o = (py * width + px) * 4
      // 82% white + 18% tint → a soft tissue-domain wash.
      data[o] = Math.round(255 * 0.82 + r * 0.18) - n
      data[o + 1] = Math.round(255 * 0.82 + g * 0.18) - n
      data[o + 2] = Math.round(255 * 0.82 + b * 0.18) - n
      data[o + 3] = 255
    }
  }
  return { data, width, height, channels: 4, affine: IDENTITY_AFFINE }
}

/** A `DataSource` with two layouts (physical `spatial` + UMAP `primary`) over the same points. */
export class RegionSelectFixtureSource implements DataSource {
  private readonly g: Generated

  constructor(opts: RegionSelectFixtureOptions = {}) {
    this.g = generate(opts)
  }

  async catalog(): Promise<DatasetCatalog> {
    return this.g.catalog
  }

  async positions(layoutId: string): Promise<Positions> {
    const p = layoutId === 'spatial' ? this.g.spatial : this.g.embedding
    return { positions: p, length: p.length / 2 }
  }

  async valueColumn(_key: string): Promise<SparseColumn> {
    // the synthetic signal as a sparse CSC column (all points present here).
    const value = this.g.signal
    const row = new Uint32Array(value.length)
    for (let i = 0; i < value.length; i++) row[i] = i
    return { row, value, length: value.length }
  }

  async categorical(_key: string): Promise<CategoricalColumn> {
    return { codes: this.g.groupCodes, categories: this.g.categories, length: this.g.groupCodes.length }
  }

  async continuous(_key: string): Promise<ContinuousColumn> {
    return { value: this.g.signal, length: this.g.signal.length }
  }

  async imageUnderlay(): Promise<ImageUnderlay> {
    return this.g.underlay
  }

  async table(_name?: string): Promise<DataTable> {
    return { rowLabels: ['signal'], columns: {} }
  }

  async graph(_id?: string): Promise<GraphData> {
    return { nodeKey: 'group', paths: [] }
  }
}
