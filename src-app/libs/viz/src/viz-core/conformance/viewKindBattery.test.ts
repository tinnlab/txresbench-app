// viewKindBattery.test.ts — the PROPERTY-BASED CONFORMANCE BATTERY (ITEM-55/56).
//
// The last hardening item: a table-driven, property-based suite that exercises EVERY
// view-kind's pure builders / aggregations across RANDOMIZED inputs and asserts STRUCTURAL
// invariants (invariants.ts), plus a conformance check that every `CellKind` in the grid
// vocabulary maps to a known dispatch. It catches the classes of bug the per-feature tests
// miss — a matrix desyncing from its labels, a range leaking NaN, a facet dropping a point,
// a degenerate group emitting an unordered box — WITHOUT re-deriving any oracle (it runs the
// SAME pure functions the views run).
//
// Determinism: `fast-check` is driven with a FIXED seed + numRuns, and every fixture is
// built from a seeded mulberry32 — so the battery is reproducible, never flaky. The GPU
// variants are intentionally NOT exercised here (node has no compute device; the `*Gpu`
// parity is proven in the browser harness). This battery is the CPU / pure-math contract.
//
// Chart-type completeness is now enforced at RUNTIME against the REGISTRY (STEP 1 replaced
// the closed `CellKind` union + `Record<CellKind,…>` compile exhaustiveness): the battery
// iterates `chartTypes()` (`KINDS`) — every registered type must have a runner, no runner
// may be a stale/unregistered key, and the two must be the same size. So a newly-registered
// chart type without a battery row fails these runtime conformance tests.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import {
  assertAllFinite,
  assertNonNegative,
  assertFiniteRange,
  assertFiniteOrSentinel,
  assertMatrixShape,
  assertPartitionCoversAll,
  assertMonotoneTicks,
  assertByteQuad,
  assertMaskLength,
  assertQuartilesOrdered,
  assertCountsSumTo,
} from './invariants'

// ── the view-kind vocabulary + its pure builders / aggregations ───────────────
import { isDenseKind } from '../grid/gridModel'
import { resolveBindings } from '../registry/model'
import { getChartType } from '../registry/registry'
import { installBuiltins } from '../charts/installBuiltins'
import { chartTypes } from '../registry/registry'
import {
  dotplotMatrix,
  heatmapMatrix,
  violinByGroup,
  volcanoPoints,
} from '../charts/aggregate'
import { boxStatsFromColumn } from '../charts/BoxView'
import { barSeriesFromCategorical } from '../charts/BarView'
import { histogramFromColumn } from '../charts/HistogramView'
import {
  buildViolinProps,
  buildBoxProps,
  buildBarProps,
  buildDotplotProps,
  buildHeatmapProps,
  buildVolcanoProps,
  buildHistogramProps,
} from '../charts/chartLayers'
import { proportions } from '../data/statsKernels'
import { continuousColors, categoricalColors } from '../data/color'
import { selectInBox, IndexMask } from '../data/selection'
import { partitionByCategorical, facetGridLayout, sharedDomain } from '../timeline/faceting'
import { forEachFinitePoint } from '../data/missing'
import { quartiles } from '../data/statsKernels'
import { densify } from '../data/wire'
import { FixtureSource } from '../data/fixtures'
import type {
  CategoricalColumn,
  SparseColumn,
  DatasetCatalog,
  ImageUnderlay,
} from '../data/wire'

// Populate the chart-type registry before deriving the kind list / running the battery.
// Idempotent. This replaces the former hard-coded `CELL_KIND_OPTIONS` closed vocabulary
// with the REGISTRY as the single source of truth (EXTENSIBILITY_STUDY Part 6 STEP 1).
installBuiltins()

/** The registered chart types (the grid switcher's vocabulary), from the registry. */
const KINDS: string[] = chartTypes().map(d => d.type)

// ── determinism knobs ─────────────────────────────────────────────────────────
/** Randomized cases per view-kind property (also per cross-cutting property). */
const NUM_RUNS = 60
/** Fixed fast-check seed → the battery is reproducible, never flaky. */
const FC_SEED = 0xc0ffee

// ── seeded RNG (mulberry32, mirrors data/fixtures.ts) ─────────────────────────
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

// ── a unified, deterministic case the runners consume ─────────────────────────

/** The resolved inputs every view-kind runner reads (dense arrays + typed columns). */
interface VizCase {
  readonly n: number
  readonly k: number
  readonly nCols: number
  readonly categories: string[]
  readonly columnNames: string[]
  readonly codes: Uint16Array
  /** Primary dense value column (violin / box). */
  readonly value: Float32Array
  /** Dense value columns for the matrix charts (dotplot / heatmap). */
  readonly columns: Map<string, Float32Array>
  /** Sparse form of the primary column (box reads a SparseColumn). */
  readonly col: SparseColumn
  readonly cat: CategoricalColumn
  /** Continuous column (histogram). */
  readonly continuous: Float32Array
  /** Interleaved xy positions (selection / faceting). */
  readonly positions: Float32Array
  /** Volcano stat-table columns. */
  readonly log2fc: Float32Array
  readonly negLog10P: Float32Array
  readonly catalog: DatasetCatalog
  readonly image: ImageUnderlay
}

type Fill = 'random' | 'const' | 'zero'
type CodeMode = 'spread' | 'leaveLastEmpty' | 'withOutOfRange'

interface CaseParams {
  seed: number
  n: number
  k: number
  nCols: number
  fill?: Fill
  constVal?: number
  codeMode?: CodeMode
}

/** Build a fully-deterministic {@link VizCase} from `params`. Never throws. */
function buildCase(params: CaseParams): VizCase {
  const { seed, n, k, nCols } = params
  const fill: Fill = params.fill ?? 'random'
  const constVal = params.constVal ?? 3.5
  const codeMode: CodeMode = params.codeMode ?? 'spread'
  const rng = mulberry32(seed)

  const categories = Array.from({ length: k }, (_, i) => `Group ${i + 1}`)
  const columnNames = Array.from({ length: nCols }, (_, i) => `Col ${i + 1}`)

  const fillValue = (): number => {
    if (fill === 'zero') return 0
    if (fill === 'const') return constVal
    // 'random' — ~10% exact zeros so the sparse/fraction paths see unexpressed points.
    return rng() < 0.1 ? 0 : rng() * 10
  }

  const codes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    if (codeMode === 'leaveLastEmpty') {
      // never assign the last category → it stays an empty group (k>1); k==1 → all 0.
      codes[i] = k > 1 ? Math.min(k - 2, (rng() * (k - 1)) | 0) : 0
    } else if (codeMode === 'withOutOfRange') {
      // some codes land ≥ k (out of range) → faceting must exclude them.
      codes[i] = (rng() * (k + 2)) | 0
    } else {
      codes[i] = Math.min(k - 1, (rng() * k) | 0)
    }
  }

  const columns = new Map<string, Float32Array>()
  for (let c = 0; c < nCols; c++) {
    const arr = new Float32Array(n)
    for (let i = 0; i < n; i++) arr[i] = fillValue()
    columns.set(columnNames[c], arr)
  }
  const value = columns.get(columnNames[0])!

  const continuous = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    continuous[i] = fill === 'zero' ? 0 : fill === 'const' ? constVal : rng() * 100
  }

  const positions = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const p = fill === 'zero' ? 0 : fill === 'const' ? constVal : (rng() - 0.5) * 200
    positions[i * 2] = p
    positions[i * 2 + 1] = fill === 'random' ? (rng() - 0.5) * 200 : p
  }

  // sparse over ALL indices (row = every point) so densify(col) === value exactly.
  const row = new Uint32Array(n)
  for (let i = 0; i < n; i++) row[i] = i
  const col: SparseColumn = { row, value, length: n }
  const cat: CategoricalColumn = { codes, categories, length: n }

  const log2fc = new Float32Array(nCols)
  const negLog10P = new Float32Array(nCols)
  for (let c = 0; c < nCols; c++) {
    log2fc[c] = fill === 'random' ? (rng() - 0.5) * 6 : fill === 'const' ? constVal : 0
    negLog10P[c] = fill === 'random' ? rng() * 8 : fill === 'const' ? Math.abs(constVal) : 0
  }

  const catalog: DatasetCatalog = {
    datasetId: `case-${seed}`,
    pointCount: n,
    layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
    valueColumns: columnNames,
    categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group', categories }],
    continuousColumns: [{ id: 'qc', kind: 'continuous', label: 'QC' }],
    hasImage: true,
  }

  const image: ImageUnderlay = {
    data: new Uint8Array(2 * 2 * 4),
    width: 2,
    height: 2,
    channels: 4,
    affine: [1, 0, 0, 0, 1, 0],
  }

  return {
    n,
    k,
    nCols,
    categories,
    columnNames,
    codes,
    value,
    columns,
    col,
    cat,
    continuous,
    positions,
    log2fc,
    negLog10P,
    catalog,
    image,
  }
}

/** Finite axis-aligned bounds `[x0,y0,x1,y1]` of interleaved positions (`[0,0,0,0]` when empty). */
function boundsOf(positions: Float32Array, n: number): [number, number, number, number] {
  if (n === 0) return [0, 0, 0, 0]
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/** Count in-range (`0 ≤ code < nCat`) points — the count conservation target. */
function inRangeCount(codes: ArrayLike<number>, nCat: number): number {
  let c = 0
  for (let i = 0; i < codes.length; i++) if (codes[i] >= 0 && codes[i] < nCat) c++
  return c
}

// ── the view-kind runner TABLE (one row per registered type — add a kind ⇒ add a row) ─
//
// Keyed by the registry `type` string (`Record<string, KindRunner>`); the runtime
// conformance tests below assert it stays in lockstep with `chartTypes()`. Each runner
// runs the kind's pure builder / aggregation on the case and
// asserts the structural invariants; it must NEVER throw on a degenerate case and must NOT
// leak NaN into any layer attribute.

interface KindRunner {
  /** Whether this kind renders into the shared deck (scatter/image) vs its own ChartCanvas. */
  readonly dense: boolean
  readonly run: (c: VizCase) => void
}

const KIND: Record<string, KindRunner> = {
  // ── DENSE kinds (shared single-Deck) ───────────────────────────────────────
  scatter: {
    dense: true,
    run: c => {
      // color engine: continuous + categorical buffers are N*4 valid bytes.
      const cont = continuousColors(c.value, {})
      assertByteQuad(cont.colors, c.n, 'scatter/continuousColors')
      assertFiniteRange(cont.domain as [number, number], 'scatter/domain')
      const catColors = categoricalColors(c.codes, {})
      assertByteQuad(catColors, c.n, 'scatter/categoricalColors')
      // selection: a box over the whole extent yields a mask of length N.
      const mask = selectInBox(c.positions, boundsOf(c.positions, c.n), c.n)
      assertMaskLength(mask, c.n, 'scatter/selectInBox')
      expect(mask.count()).toBeLessThanOrEqual(c.n)
      // faceting: dense cells partition by the categorical column.
      const facets = partitionByCategorical(c.codes, c.categories)
      assertPartitionCoversAll(facets, c.codes, c.categories.length, 'scatter/faceting')
    },
  },
  image: {
    dense: true,
    run: c => {
      const img = c.image
      expect(img.data.length).toBe(img.width * img.height * img.channels)
      expect(img.affine.length).toBe(6)
      assertAllFinite(img.affine, 'image/affine')
      // NaN positions are CULLED, never drawn — finite count ≤ N and no crash.
      let finiteCount = 0
      forEachFinitePoint(c.positions, () => finiteCount++)
      expect(finiteCount).toBeLessThanOrEqual(c.n)
      const cont = continuousColors(c.value, {})
      assertByteQuad(cont.colors, c.n, 'image/color')
    },
  },
  // `grid` is a nested-workspace container cell — no per-point aggregation; its contract is
  // that it is NOT dense and that catalog-derived default bindings are always defined.
  grid: {
    dense: false,
    run: c => {
      expect(isDenseKind('grid')).toBe(false)
      // `grid` is the nested CONTAINER — it declares no binding channels, so resolving its
      // (empty) schema yields an empty resolution map. This used to assert that the deleted
      // `defaultBindings` produced four defined values here, which said nothing about `grid`
      // at all: it was asserting the guess never returned `undefined`, for a kind that binds
      // nothing. What is actually true of `grid` is that it has nothing to bind.
      const schema = getChartType('grid')?.bindingSchema ?? []
      expect(schema).toEqual([])
      expect(resolveBindings(schema, c.catalog)).toEqual({})
    },
  },

  // ── CHART kinds (own ChartCanvas) ──────────────────────────────────────────
  violin: {
    dense: false,
    run: c => {
      const groups = violinByGroup(c.value, c.codes, c.categories)
      expect(groups.length).toBe(c.categories.length)
      for (const g of groups) {
        assertAllFinite(g.density.map(d => d.x), `violin/${g.group}/x`)
        // KDE density is a mean of non-negative kernels → never negative, never NaN.
        assertNonNegative(g.density.map(d => d.density), `violin/${g.group}/density`)
      }
      const built = buildViolinProps(groups)
      expect(built.centers.length).toBe(c.categories.length)
      assertAllFinite(built.centers, 'violin/centers')
      for (const ring of built.violin.data) {
        for (const [x, y] of ring.polygon) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`violin/${ring.group}: non-finite polygon vertex [${x}, ${y}]`)
          }
        }
      }
    },
  },
  box: {
    dense: false,
    run: c => {
      const boxes = boxStatsFromColumn(c.col, c.cat)
      expect(boxes.length).toBe(c.categories.length)
      for (const b of boxes) assertQuartilesOrdered(b, `box/${b.group}`)
      const built = buildBoxProps(boxes)
      expect(built.centers.length).toBe(c.categories.length)
      for (const rect of built.boxes.data) {
        for (const [x, y] of rect.polygon) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`box/${rect.group}: non-finite box vertex [${x}, ${y}]`)
          }
        }
      }
    },
  },
  bar: {
    dense: false,
    run: c => {
      const series = barSeriesFromCategorical(c.cat)
      expect(series.length).toBe(c.categories.length)
      const counts = series.map(s => s.values[0])
      // per-category counts are non-negative and CONSERVE the in-range point total.
      assertCountsSumTo(counts, inRangeCount(c.codes, c.categories.length), 'bar/conservation')
      const props = buildBarProps(series, { mode: 'grouped' })
      for (const r of props.data) {
        assertAllFinite([r.x0, r.x1, r.y0, r.y1], 'bar/rect')
        expect(r.y1).toBeGreaterThanOrEqual(r.y0)
      }
      // proportions ∈ [0,1] and sum to 1 (any point) or 0 (empty).
      const props2 = proportions(c.codes, c.categories.length)
      for (const p of props2) expect(p >= 0 && p <= 1).toBe(true)
      const sumP = Array.from(props2).reduce((a, b) => a + b, 0)
      if (inRangeCount(c.codes, c.categories.length) > 0) {
        expect(Math.abs(sumP - 1)).toBeLessThan(1e-5)
      } else {
        expect(sumP).toBe(0)
      }
    },
  },
  dotplot: {
    dense: false,
    run: c => {
      const rows = c.columns.size
      const cols = c.categories.length
      const cells = dotplotMatrix(c.columns, c.codes, c.categories)
      expect(cells.length).toBe(rows * cols)
      for (const d of cells) {
        expect(Number.isFinite(d.meanExpr)).toBe(true)
        expect(d.fractionExpressing >= 0 && d.fractionExpressing <= 1).toBe(true)
      }
      const built = buildDotplotProps(
        cells.map(d => ({ row: d.group, col: d.column, value: d.meanExpr, fraction: d.fractionExpressing })),
      )
      assertFiniteRange(built.domain as [number, number], 'dotplot/domain')
      expect(built.rows.length).toBeLessThanOrEqual(cols)
      expect(built.cols.length).toBeLessThanOrEqual(rows)
    },
  },
  heatmap: {
    dense: false,
    run: c => {
      const rows = c.columns.size // value columns
      const cols = c.categories.length // groups
      const cells = heatmapMatrix(c.columns, c.codes, c.categories)
      // cells are column-major over (column × group) == row-major with rows=columns.
      const values = new Float32Array(rows * cols)
      for (let i = 0; i < cells.length; i++) values[i] = cells[i].value
      assertMatrixShape(
        values,
        rows,
        cols,
        { rowLabels: c.columnNames, colLabels: c.categories },
        'heatmap',
      )
      assertAllFinite(values, 'heatmap/values')
      const built = buildHeatmapProps({ rows: c.columnNames, cols: c.categories, values })
      expect(built.image.data.length).toBe(rows * cols * 4)
      assertFiniteRange(built.domain as [number, number], 'heatmap/domain')
    },
  },
  volcano: {
    dense: false,
    run: c => {
      const pts = volcanoPoints(c.columnNames, c.log2fc, c.negLog10P)
      expect(pts.length).toBe(c.columnNames.length)
      for (const p of pts) {
        expect(Number.isFinite(p.log2fc)).toBe(true)
        expect(Number.isFinite(p.negLog10P)).toBe(true)
        expect(['up', 'down', 'ns']).toContain(p.direction)
        expect(typeof p.significant).toBe('boolean')
      }
      const built = buildVolcanoProps(
        pts.map(p => ({ label: p.column, x: p.log2fc, y: p.negLog10P, direction: p.direction })),
      )
      for (const s of built.guides.data) {
        assertAllFinite([...s.source, ...s.target], 'volcano/guides')
      }
    },
  },
  histogram: {
    dense: false,
    run: c => {
      const h = histogramFromColumn(c.continuous, 20)
      // bin edges cover the range monotonically; counts are non-negative + conserved.
      assertMonotoneTicks(h.binEdges, {}, 'histogram/binEdges')
      assertNonNegative(h.counts, 'histogram/counts')
      if (h.binEdges.length > 0) {
        expect(h.counts.length).toBe(h.binEdges.length - 1)
      }
      let finiteN = 0
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < c.continuous.length; i++) {
        const v = c.continuous[i]
        if (Number.isFinite(v)) {
          finiteN++
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      assertCountsSumTo(h.counts, finiteN, 'histogram/conservation')
      // every finite value lies within the bin range (bins cover the data).
      if (h.binEdges.length >= 2 && Number.isFinite(lo)) {
        const first = h.binEdges[0]
        const last = h.binEdges[h.binEdges.length - 1]
        expect(lo).toBeGreaterThanOrEqual(first - 1e-6)
        expect(hi).toBeLessThanOrEqual(last + 1e-6)
      }
      const props = buildHistogramProps(h.binEdges, h.counts)
      for (const r of props.data) assertAllFinite([r.x0, r.x1, r.y0, r.y1], 'histogram/rect')
    },
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CellKind CONFORMANCE — every kind is dispatched (mirrors the DEC-36
//    story-completeness spirit at the unit level).
// ─────────────────────────────────────────────────────────────────────────────

describe('chart-type conformance — every registered kind maps to a battery runner', () => {
  it('every registered chart type has a runner', () => {
    for (const kind of KINDS) {
      expect(KIND[kind], `no battery runner for registered chart type "${kind}"`).toBeDefined()
    }
  })

  it('every runner key is a registered chart type (no stale rows)', () => {
    const known = new Set<string>(KINDS)
    for (const key of Object.keys(KIND)) {
      expect(known.has(key), `runner "${key}" is not a registered chart type`).toBe(true)
    }
  })

  it('the runner table and the registered chart-type vocabulary are the same size', () => {
    expect(Object.keys(KIND).length).toBe(KINDS.length)
  })

  it('dense flags agree with isDenseKind for every kind', () => {
    for (const kind of KINDS) {
      expect(KIND[kind].dense).toBe(isDenseKind(kind))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PROPERTY BATTERY — each view-kind over NUM_RUNS randomized fixtures.
//    Varies pointCount (incl. tiny/1), group count (incl. 1), and column count.
// ─────────────────────────────────────────────────────────────────────────────

const genParams = fc.record({
  seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  n: fc.integer({ min: 1, max: 300 }), // tiny (1) … a few hundred
  k: fc.integer({ min: 1, max: 8 }), // single group … eight
  nCols: fc.integer({ min: 1, max: 5 }),
})

describe('property battery — every view-kind over randomized fixtures', () => {
  for (const kind of KINDS) {
    it(`${kind}: structural invariants hold over ${NUM_RUNS} randomized fixtures`, () => {
      fc.assert(
        fc.property(genParams, p => {
          KIND[kind].run(buildCase({ ...p }))
        }),
        { numRuns: NUM_RUNS, seed: FC_SEED },
      )
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. DEGENERATE CONTRACT — every kind survives each degenerate fixture without
//    crashing and without leaking NaN (missing.ts contract).
// ─────────────────────────────────────────────────────────────────────────────

const DEGENERATE: { name: string; build: () => VizCase }[] = [
  { name: 'single-point (n=1, k=1)', build: () => buildCase({ seed: 1, n: 1, k: 1, nCols: 2 }) },
  { name: 'empty-dataset (n=0)', build: () => buildCase({ seed: 2, n: 0, k: 2, nCols: 2 }) },
  { name: 'one-group (k=1)', build: () => buildCase({ seed: 3, n: 50, k: 1, nCols: 3 }) },
  {
    name: 'empty-group (k=4, last empty)',
    build: () => buildCase({ seed: 4, n: 60, k: 4, nCols: 3, codeMode: 'leaveLastEmpty' }),
  },
  {
    name: 'all-same-value column (zero variance)',
    build: () => buildCase({ seed: 5, n: 40, k: 3, nCols: 3, fill: 'const', constVal: 3.5 }),
  },
  {
    name: 'all-zero column',
    build: () => buildCase({ seed: 6, n: 40, k: 3, nCols: 3, fill: 'zero' }),
  },
]

describe('degenerate contract — no crash, no NaN leak', () => {
  for (const kind of KINDS) {
    for (const d of DEGENERATE) {
      it(`${kind} survives ${d.name}`, () => {
        expect(() => KIND[kind].run(d.build())).not.toThrow()
      })
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. NaN / MISSING CONTRACT (missing.ts) — feed genuine NaN to the kernels that
//    PROMISE NaN-safety and assert no NaN leaks into any output.
// ─────────────────────────────────────────────────────────────────────────────

describe('NaN / missing contract — kernels that promise NaN-safety', () => {
  it('histogramFromColumn — all-NaN column → empty (no bins, no counts)', () => {
    const h = histogramFromColumn(new Float32Array([NaN, NaN, NaN]), 20)
    expect(h.binEdges).toEqual([])
    expect(h.counts).toEqual([])
    assertMonotoneTicks(h.binEdges)
  })

  it('histogramFromColumn — mixed NaN/finite → Σcounts == #finite, edges monotone', () => {
    const col = new Float32Array([1, NaN, 2, Infinity, 3, -Infinity, 4])
    const h = histogramFromColumn(col, 8)
    assertMonotoneTicks(h.binEdges, {}, 'mixed/edges')
    assertCountsSumTo(h.counts, 4, 'mixed/conservation') // only 1,2,3,4 are finite
  })

  it('quartiles — all-NaN → finite ordered zeros (finiteValues filter)', () => {
    const q = quartiles(new Float32Array([NaN, NaN]))
    assertQuartilesOrdered(q, 'quartiles/all-nan')
    expect(q.q1).toBe(0)
    expect(q.outliers).toEqual([])
  })

  it('violinByGroup — NaN values do not leak into densities', () => {
    const values = new Float32Array([1, NaN, 2, 3, NaN, 4])
    const codes = new Uint16Array([0, 0, 1, 1, 0, 1])
    const groups = violinByGroup(values, codes, ['A', 'B'])
    for (const g of groups) {
      assertAllFinite(g.density.map(d => d.x), `violin/${g.group}/x`)
      assertNonNegative(g.density.map(d => d.density), `violin/${g.group}/density`)
    }
  })

  it('continuousColors — all-NaN column → finite domain + valid N*4 byte buffer', () => {
    const { colors, domain } = continuousColors(new Float32Array([NaN, NaN, NaN]), {})
    assertByteQuad(colors, 3, 'nan/color')
    assertFiniteRange(domain as [number, number], 'nan/domain')
  })

  it('forEachFinitePoint — NaN coordinates are culled; finite count is exact', () => {
    const positions = new Float32Array([0, 0, NaN, 1, 2, NaN, 3, 3])
    let visited = 0
    forEachFinitePoint(positions, () => visited++)
    expect(visited).toBe(2) // only points 0 and 3 are fully finite
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. CROSS-CUTTING PROPERTIES — faceting partition + shared domain, over
//    randomized codes INCLUDING out-of-range values.
// ─────────────────────────────────────────────────────────────────────────────

describe('faceting — partition invariant over randomized codes', () => {
  it(`covers every in-range index exactly once (incl. out-of-range codes), ${NUM_RUNS} runs`, () => {
    fc.assert(
      fc.property(genParams, p => {
        const c = buildCase({ ...p, codeMode: 'withOutOfRange' })
        const facets = partitionByCategorical(c.codes, c.categories)
        assertPartitionCoversAll(facets, c.codes, c.categories.length, 'faceting')
        // the facet grid can hold every facet.
        const layout = facetGridLayout(facets.length, { maxCols: 4 })
        expect(layout.rows * layout.cols).toBeGreaterThanOrEqual(facets.length)
        // the shared value domain is finite or the documented empty sentinel.
        const dom = sharedDomain(facets, i => c.value[i])
        assertFiniteOrSentinel(dom as [number, number], [0, 0], 'faceting/sharedDomain')
      }),
      { numRuns: NUM_RUNS, seed: FC_SEED },
    )
  })
})

describe('color + selection — buffer lengths track N over randomized fixtures', () => {
  it(`color buffers are N*4 and selection masks are length N, ${NUM_RUNS} runs`, () => {
    fc.assert(
      fc.property(genParams, p => {
        const c = buildCase({ ...p })
        assertByteQuad(continuousColors(c.value, {}).colors, c.n, 'xcut/continuous')
        assertByteQuad(categoricalColors(c.codes, {}), c.n, 'xcut/categorical')
        const mask = IndexMask.fromIndices(c.n, [])
        assertMaskLength(mask, c.n, 'xcut/mask')
        const boxMask = selectInBox(c.positions, boundsOf(c.positions, c.n), c.n)
        assertMaskLength(boxMask, c.n, 'xcut/selectInBox')
      }),
      { numRuns: NUM_RUNS, seed: FC_SEED },
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. REAL WIRE PATH — the SAME aggregations over a real FixtureSource (ArrayBuffer
//    → decode → aggregate), across randomized seeds / sizes / group counts.
// ─────────────────────────────────────────────────────────────────────────────

describe('real FixtureSource wire path — aggregations hold invariants', () => {
  it('box / bar / proportions / histogram / dotplot / heatmap / faceting across seeds & sizes', async () => {
    const configs: [number, number, number][] = [
      [1, 64, 1],
      [7, 500, 4],
      [13, 1000, 8],
      [21, 3, 2],
      [42, 128, 6],
    ]
    for (const [seed, pointCount, groupCount] of configs) {
      const src = new FixtureSource({ seed, pointCount, groupCount })
      const catalog = await src.catalog()
      const cat = await src.categorical('group')
      const cont = await src.continuous('qcA')
      const primaryKey = catalog.valueColumns[0]
      const col = await src.valueColumn(primaryKey)

      // box
      for (const b of boxStatsFromColumn(col, cat)) assertQuartilesOrdered(b, `wire/box/${b.group}`)

      // bar + proportions
      const series = barSeriesFromCategorical(cat)
      assertCountsSumTo(
        series.map(s => s.values[0]),
        inRangeCount(cat.codes, cat.categories.length),
        'wire/bar',
      )
      const props = proportions(cat.codes, cat.categories.length)
      const sumP = Array.from(props).reduce((a, b) => a + b, 0)
      expect(Math.abs(sumP - 1)).toBeLessThan(1e-5)

      // histogram (continuous, all finite → Σ == N)
      const h = histogramFromColumn(cont.value, 30)
      assertMonotoneTicks(h.binEdges, {}, 'wire/hist')
      assertCountsSumTo(h.counts, pointCount, 'wire/hist/conservation')

      // dotplot + heatmap over the first few value columns
      const cols = new Map<string, Float32Array>()
      for (const key of catalog.valueColumns.slice(0, 3)) {
        cols.set(key, densify(await src.valueColumn(key)))
      }
      const dp = dotplotMatrix(cols, cat.codes, cat.categories)
      expect(dp.length).toBe(cols.size * cat.categories.length)
      for (const d of dp) {
        expect(Number.isFinite(d.meanExpr)).toBe(true)
        expect(d.fractionExpressing >= 0 && d.fractionExpressing <= 1).toBe(true)
      }
      const hm = heatmapMatrix(cols, cat.codes, cat.categories)
      const values = new Float32Array(hm.length)
      for (let i = 0; i < hm.length; i++) values[i] = hm[i].value
      assertMatrixShape(values, cols.size, cat.categories.length, {}, 'wire/heatmap')
      assertAllFinite(values, 'wire/heatmap/values')

      // faceting partition over the real categorical codes
      const facets = partitionByCategorical(cat.codes, cat.categories)
      assertPartitionCoversAll(facets, cat.codes, cat.categories.length, 'wire/faceting')
    }
  })
})
