// ohlcFixture.ts — a small OHLC `DataSource` for the candlestick extension, modeled on
// `FixtureSource` (viz-core/data/fixtures.ts): a deterministic (seeded) random-walk generator
// that emits VALID candles, encoded to the exact continuous-column WIRE framing (Float32
// octets → `decodeContinuous`) so the whole ArrayBuffer → TypedArray → deck path runs for real.
//
// The four price series ride as CONTINUOUS columns (open/high/low/close) plus an `index`
// column (bar ordinals 0..N-1) — the vocabulary the candlestick descriptor's `bindingSchema`
// binds to. This lives in the extension (a NEW file); it does NOT touch the core fixture.

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
  decodeContinuous,
} from '../../viz-core/data/wire'

// ── seeded RNG (mulberry32) + a Box–Muller normal — local copies (the core generator's are
//    module-private). Generic math, no chart/fixture internal reached into. ──────────────
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

export interface OhlcFixtureOptions {
  seed?: number
  /** Number of candles (default 120). */
  bars?: number
  /** Opening price of the first bar (default 100). */
  start?: number
  /** Per-bar body volatility (stddev of the open→close step; default 1.6). */
  volatility?: number
  /** Wick-length scale (the |normal| overshoot beyond the body; default 1.1). */
  wick?: number
}

/** The four price columns + the index column, as raw Float32Arrays. */
export interface GeneratedOhlc {
  readonly index: Float32Array
  readonly open: Float32Array
  readonly high: Float32Array
  readonly low: Float32Array
  readonly close: Float32Array
}

/**
 * Generate `bars` VALID candles by a seeded random walk. Validity is BY CONSTRUCTION: each
 * bar's high = max(open,close) + |noise| (≥ max) and low = min(open,close) − |noise| (≤ min),
 * so `low ≤ min(open,close)` and `high ≥ max(open,close)` always hold. A small positive floor
 * keeps prices > 0. Deterministic for a given seed.
 */
export function generateOhlc(opts: OhlcFixtureOptions = {}): GeneratedOhlc {
  const N = Math.max(1, opts.bars ?? 120)
  const start = opts.start ?? 100
  const vol = opts.volatility ?? 1.6
  const wickScale = opts.wick ?? 1.1
  const rng = mulberry32(opts.seed ?? 7)
  const normal = makeNormal(rng)

  const index = new Float32Array(N)
  const open = new Float32Array(N)
  const high = new Float32Array(N)
  const low = new Float32Array(N)
  const close = new Float32Array(N)

  const FLOOR = 1
  let prevClose = start
  for (let i = 0; i < N; i++) {
    const o = Math.max(FLOOR, prevClose)
    const c = Math.max(FLOOR, o + normal() * vol)
    const bodyHi = Math.max(o, c)
    const bodyLo = Math.min(o, c)
    const hi = bodyHi + Math.abs(normal()) * wickScale
    const lo = Math.max(FLOOR * 0.5, bodyLo - Math.abs(normal()) * wickScale)
    index[i] = i
    open[i] = o
    high[i] = hi
    low[i] = lo
    close[i] = c
    prevClose = c
  }
  return { index, open, high, low, close }
}

// ── wire encode (Float32Array → ArrayBuffer) so the DataSource is byte-faithful to the octet
//    continuous framing `decodeContinuous` consumes (mirrors FixtureSource). ──────────────
function encodeFloat32(values: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(values.byteLength)
  new Uint8Array(out).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
  return out
}

const COLUMN_IDS = ['index', 'open', 'high', 'low', 'close'] as const
type ColumnId = (typeof COLUMN_IDS)[number]
const COLUMN_LABELS: Record<ColumnId, string> = {
  index: 'Bar',
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
}

/**
 * A `DataSource` exposing ONLY the OHLC continuous columns the candlestick reads. The other
 * data-plane methods (positions / value / categorical / image / table / graph) are not part of
 * a candlestick and REJECT with a clear message (mirrors `FixtureSource` rejecting an unknown
 * column) — the View never calls them.
 */
export class OhlcFixtureSource implements DataSource {
  private readonly cols: Record<ColumnId, ArrayBuffer>
  private readonly count: number

  constructor(opts: OhlcFixtureOptions = {}) {
    const fx = generateOhlc(opts)
    this.count = fx.index.length
    this.cols = {
      index: encodeFloat32(fx.index),
      open: encodeFloat32(fx.open),
      high: encodeFloat32(fx.high),
      low: encodeFloat32(fx.low),
      close: encodeFloat32(fx.close),
    }
  }

  async catalog(): Promise<DatasetCatalog> {
    const continuousColumns: CatalogEntry[] = COLUMN_IDS.map(id => ({
      id,
      kind: 'continuous',
      label: COLUMN_LABELS[id],
    }))
    return {
      datasetId: 'ohlc-fixture',
      pointCount: this.count,
      layouts: [],
      valueColumns: [],
      categoricalColumns: [],
      continuousColumns,
      hasImage: false,
    }
  }

  async continuous(key: string): Promise<ContinuousColumn> {
    const buf = this.cols[key as ColumnId]
    if (!buf) throw new Error(`ohlc fixture has no continuous column "${key}"`)
    return decodeContinuous(buf)
  }

  async positions(_layoutId: string): Promise<Positions> {
    throw new Error('ohlc fixture has no positions (candlestick is a value-axis chart)')
  }
  async valueColumn(_key: string): Promise<SparseColumn> {
    throw new Error('ohlc fixture has no sparse value columns')
  }
  async categorical(_key: string): Promise<CategoricalColumn> {
    throw new Error('ohlc fixture has no categorical columns')
  }
  async imageUnderlay(): Promise<ImageUnderlay> {
    throw new Error('ohlc fixture has no image underlay')
  }
  async table(_name?: string): Promise<DataTable> {
    throw new Error('ohlc fixture has no bulk table')
  }
  async graph(_id?: string): Promise<GraphData> {
    throw new Error('ohlc fixture has no graph')
  }
}
