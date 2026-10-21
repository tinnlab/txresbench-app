// candlestick.test.ts — node unit tests for the PURE parts of the candlestick extension
// (geometry, fixture validity, model resolution) + the registration contract (`use(...)` adds
// the `candlestick` type to the shared registry). Asserts REAL numbers so a stub would fail.
//
// The registry is module-global; vitest isolates module state per test FILE, so nothing here
// touches the `subpathExports.test.ts` `chartTypes().toHaveLength(10)` contract — this file
// never imports the built-ins, and `candlestick` registers only when THIS file `use(...)`s it.

import { describe, it, expect } from 'vitest'
import {
  isUp,
  candleColor,
  bodyRing,
  wickSegment,
  ohlcValueDomain,
  barsFromColumns,
  barsInXRange,
  CANDLE_UP,
  CANDLE_DOWN,
  HALF_BODY,
  type OhlcBar,
} from './geometry'
import { generateOhlc, OhlcFixtureSource } from './ohlcFixture'
import { candlestickModel, candlestickDescriptor, CandlestickChart, CANDLESTICK_SCHEMA } from './candlestick'
import { use } from '../../viz-core/extension'
import { getChartType, hasChartType } from '../../viz-core/registry/registry'
import type { GridCell } from '../../viz-core/grid/gridModel'
import type { ModelContext } from '../../viz-core/registry/types'
import type { DatasetCatalog } from '../../viz-core/data/wire'

describe('candlestick geometry (pure)', () => {
  it('classifies up vs down by close ≥ open (doji counts up)', () => {
    expect(isUp(10, 14)).toBe(true)
    expect(isUp(14, 10)).toBe(false)
    expect(isUp(12, 12)).toBe(true) // doji
    expect(candleColor(10, 14)).toEqual(CANDLE_UP)
    expect(candleColor(14, 10)).toEqual(CANDLE_DOWN)
  })

  it('builds the OPEN↔CLOSE body rect independent of direction', () => {
    const up = bodyRing(3, 10, 14) // open<close
    const down = bodyRing(3, 14, 10) // open>close — SAME rect
    // y spans [min,max] = [10,14]; x spans [3±HALF_BODY]
    expect(up).toEqual([
      [3 - HALF_BODY, 10],
      [3 + HALF_BODY, 10],
      [3 + HALF_BODY, 14],
      [3 - HALF_BODY, 14],
    ])
    expect(down).toEqual(up)
    // A doji is a zero-height ring at the shared price.
    const doji = bodyRing(2, 20, 20)
    expect(doji[0][1]).toBe(20)
    expect(doji[2][1]).toBe(20)
  })

  it('builds the HIGH→LOW wick segment at the bar center', () => {
    expect(wickSegment(3, 8, 20)).toEqual({ source: [3, 8], target: [3, 20] })
  })

  it('computes the value domain from the min low / max high with padding', () => {
    const bars: OhlcBar[] = [
      { i: 0, x: 0, open: 10, high: 20, low: 8, close: 15 },
      { i: 1, x: 1, open: 15, high: 25, low: 12, close: 22 },
    ]
    const dom = ohlcValueDomain(bars)!
    expect(dom).not.toBeNull()
    // core span = [8, 25]; pad = 0.04 * 17 = 0.68
    expect(dom[0]).toBeCloseTo(8 - 0.68, 6)
    expect(dom[1]).toBeCloseTo(25 + 0.68, 6)
    expect(ohlcValueDomain([])).toBeNull()
  })

  it('zips columns into bars (x from the index column) and hit-tests an x-range', () => {
    const bars = barsFromColumns([100, 101, 102], [1, 2, 3], [5, 6, 7], [0, 1, 2], [4, 5, 6])
    expect(bars).toHaveLength(3)
    expect(bars[1]).toEqual({ i: 1, x: 101, open: 2, high: 6, low: 1, close: 5 })
    // barsInXRange returns the ORDINALS (bar.i) of bars whose x ∈ [a,b].
    expect(Array.from(barsInXRange(bars, 100.5, 102))).toEqual([1, 2])
    expect(Array.from(barsInXRange(bars, 200, 300))).toEqual([])
    // ordering-insensitive
    expect(Array.from(barsInXRange(bars, 102, 100.5))).toEqual([1, 2])
  })
})

describe('OHLC fixture (valid candles)', () => {
  it('generates candles that satisfy low ≤ min(o,c) ≤ max(o,c) ≤ high for every bar', () => {
    const fx = generateOhlc({ seed: 7, bars: 120 })
    expect(fx.open).toHaveLength(120)
    expect(fx.close).toHaveLength(120)
    for (let i = 0; i < 120; i++) {
      const o = fx.open[i]
      const c = fx.close[i]
      const h = fx.high[i]
      const l = fx.low[i]
      expect(l).toBeLessThanOrEqual(Math.min(o, c))
      expect(h).toBeGreaterThanOrEqual(Math.max(o, c))
      expect(h).toBeGreaterThanOrEqual(l)
      expect(l).toBeGreaterThan(0) // priced positive
      expect(Number.isFinite(o + c + h + l)).toBe(true)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = generateOhlc({ seed: 42, bars: 30 })
    const b = generateOhlc({ seed: 42, bars: 30 })
    expect(Array.from(a.close)).toEqual(Array.from(b.close))
    const c = generateOhlc({ seed: 43, bars: 30 })
    expect(Array.from(a.close)).not.toEqual(Array.from(c.close))
  })

  it('exposes exactly the OHLC continuous columns through the DataSource', async () => {
    const src = new OhlcFixtureSource({ seed: 7, bars: 64 })
    const cat = await src.catalog()
    expect(cat.continuousColumns.map(c => c.id)).toEqual(['index', 'open', 'high', 'low', 'close'])
    expect(cat.pointCount).toBe(64)
    const close = await src.continuous('close')
    expect(close.value).toHaveLength(64)
    const index = await src.continuous('index')
    expect(Array.from(index.value.slice(0, 3))).toEqual([0, 1, 2])
    await expect(src.continuous('nope')).rejects.toThrow(/no continuous column/)
  })
})

describe('candlestick descriptor + model', () => {
  const cell: GridCell = { id: 'c1', kind: 'candlestick', layoutId: 'primary' }
  const catalog: DatasetCatalog = {
    datasetId: 'ohlc',
    pointCount: 10,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [
      { id: 'index', kind: 'continuous', label: 'Bar' },
      { id: 'open', kind: 'continuous', label: 'Open' },
      { id: 'high', kind: 'continuous', label: 'High' },
      { id: 'low', kind: 'continuous', label: 'Low' },
      { id: 'close', kind: 'continuous', label: 'Close' },
    ],
    hasImage: false,
  }
  const ctx: ModelContext = { catalog }

  it('declares 4 value channels + an index channel, all continuous', () => {
    expect(CANDLESTICK_SCHEMA.map(c => c.id)).toEqual(['index', 'open', 'high', 'low', 'close'])
    expect(CANDLESTICK_SCHEMA.every(c => c.source === 'continuous')).toBe(true)
  })

  it('resolves each channel to its DISTINCT like-named continuous column', () => {
    const model = candlestickModel(cell, ctx)
    expect(model.bindings).toEqual({
      index: 'index',
      open: 'open',
      high: 'high',
      low: 'low',
      close: 'close',
    })
    // the four price channels are DISTINCT (the shared makeChartModel now resolves each
    // same-source channel to its own column — id-match then ordinal — so no bespoke model)
    const priceCols = ['open', 'high', 'low', 'close'].map(id => model.bindings[id])
    expect(new Set(priceCols).size).toBe(4)
  })

  it('declares consume + produce + an x+y dataZoom capability', () => {
    expect(candlestickDescriptor.coordinateSystem).toBe('chart2d')
    expect(candlestickDescriptor.capabilities).toEqual({
      consumesSelection: true,
      producesSelection: true,
      dataZoomAxes: ['x', 'y'],
    })
  })
})

describe('registration through the shared registry seam', () => {
  it('use(CandlestickChart) registers ONLY the candlestick type (zero core edits)', () => {
    // Nothing registered this type until we `use` it (module-isolated registry).
    expect(hasChartType('candlestick')).toBe(false)
    use(CandlestickChart)
    expect(hasChartType('candlestick')).toBe(true)
    const desc = getChartType('candlestick')!
    expect(desc).toBeDefined()
    expect(desc.type).toBe('candlestick')
    expect(desc.coordinateSystem).toBe('chart2d')
    expect(desc.capabilities?.producesSelection).toBe(true)
    // it did NOT pull in the built-ins (opt-in proof)
    expect(hasChartType('candlestick2')).toBe(false)
    expect(getChartType('scatter')).toBeUndefined()
  })
})
