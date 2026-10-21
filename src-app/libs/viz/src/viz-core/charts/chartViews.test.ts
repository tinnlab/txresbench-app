// chartViews.test.ts — unit tests for the PURE data-shaping helpers exported by the
// chart VIEW components (viz-core/charts/*View.tsx). These helpers turn decoded wire
// columns into the exact builder inputs the `chartLayers` builders consume; they carry
// no GL/React/DOM, so they test in node. (The View components' rendering path is
// exercised by the showcase gallery, not here.)

import { describe, it, expect } from 'vitest'
import { violinGroupsFromColumn } from './ViolinView'
import { boxStatsFromColumn } from './BoxView'
import { dotCellsFromColumns } from './DotplotView'
import { heatmapMatrixFromColumns } from './HeatmapView'
import { volcanoInputFromTable } from './VolcanoView'
import { barSeriesFromCategorical } from './BarView'
import { histogramFromColumn } from './HistogramView'
import { FixtureSource } from '../data/fixtures'
import type { CategoricalColumn, DataTable, SparseColumn } from '../data/wire'

// ── helpers to fabricate decoded wire columns without the network/fixture ──────

/** A dense value column expressed as the sparse CSC slice the wire uses (0 = absent). */
function sparseFromDense(dense: number[]): SparseColumn {
  const rows: number[] = []
  const vals: number[] = []
  dense.forEach((v, i) => {
    if (v !== 0) {
      rows.push(i)
      vals.push(v)
    }
  })
  return { row: Uint32Array.from(rows), value: Float32Array.from(vals), length: dense.length }
}

function categorical(codes: number[], categories: string[]): CategoricalColumn {
  return { codes: Uint16Array.from(codes), categories, length: codes.length }
}

// ── ViolinView: sparse value column + categorical → per-group density input ─────

describe('violinGroupsFromColumn', () => {
  it('turns a value column + categorical into one density curve per category', async () => {
    const source = new FixtureSource({ seed: 1, pointCount: 500 })
    const col = await source.valueColumn('Feature A')
    const cat = await source.categorical('group')
    const groups = violinGroupsFromColumn(col, cat, { ticks: 16 })
    // one ViolinGroup per category, each a KDE curve sampled at `ticks` grid points
    expect(groups).toHaveLength(cat.categories.length)
    expect(groups[0].group).toBe(cat.categories[0])
    expect(groups[0].density).toHaveLength(16)
    for (const p of groups[0].density) expect(Number.isFinite(p.density)).toBe(true)
  })
})

// ── BoxView: grouped values → per-group Tukey stats ────────────────────────────

describe('boxStatsFromColumn', () => {
  it('computes per-group quartiles in category order', () => {
    const col = sparseFromDense([1, 2, 3, 4, 5])
    const cat = categorical([0, 0, 0, 0, 0], ['A'])
    const stats = boxStatsFromColumn(col, cat)
    expect(stats).toHaveLength(1)
    expect(stats[0].group).toBe('A')
    expect(stats[0].median).toBe(3)
    expect(stats[0].q1).toBe(2)
    expect(stats[0].q3).toBe(4)
  })

  it('buckets values by group code', () => {
    // group A = {2,4}; group B = {10}
    const col = sparseFromDense([2, 4, 10])
    const cat = categorical([0, 0, 1], ['A', 'B'])
    const stats = boxStatsFromColumn(col, cat)
    expect(stats.map(s => s.group)).toEqual(['A', 'B'])
    expect(stats[0].median).toBe(3) // median of {2,4}
    expect(stats[1].median).toBe(10) // single-value group
  })
})

// ── DotplotView: value columns + categorical → grid cells ──────────────────────

describe('dotCellsFromColumns', () => {
  it('maps mean→value and fraction-expressing→fraction per (group, column) cell', () => {
    const columns = new Map([['X', Float32Array.from([0, 2, 4])]])
    const cat = categorical([0, 0, 1], ['A', 'B'])
    const cells = dotCellsFromColumns(columns, cat)
    // 2 groups × 1 column = 2 cells
    expect(cells).toHaveLength(2)
    const a = cells.find(c => c.row === 'A' && c.col === 'X')!
    const b = cells.find(c => c.row === 'B' && c.col === 'X')!
    expect(a.value).toBeCloseTo(1) // mean of {0,2}
    expect(a.fraction).toBeCloseTo(0.5) // 1 of 2 non-zero
    expect(b.value).toBeCloseTo(4)
    expect(b.fraction).toBeCloseTo(1)
  })
})

// ── HeatmapView: value columns + categorical → row-major rows×cols matrix ───────

describe('heatmapMatrixFromColumns', () => {
  it('builds a rows(groups) × cols(columns) row-major mean matrix', () => {
    const columns = new Map([
      ['X', Float32Array.from([0, 2, 4])],
      ['Y', Float32Array.from([1, 1, 7])],
    ])
    const cat = categorical([0, 0, 1], ['A', 'B'])
    const m = heatmapMatrixFromColumns(columns, cat)
    expect(m.rows).toEqual(['A', 'B'])
    expect(m.cols).toEqual(['X', 'Y'])
    expect(m.values).toHaveLength(4) // 2 rows × 2 cols, row-major
    // row A (index 0): X mean {0,2}=1, Y mean {1,1}=1
    expect(m.values[0]).toBeCloseTo(1)
    expect(m.values[1]).toBeCloseTo(1)
    // row B (index 1): X mean {4}=4, Y mean {7}=7
    expect(m.values[2]).toBeCloseTo(4)
    expect(m.values[3]).toBeCloseTo(7)
  })
})

// ── VolcanoView: stat table → classified points ────────────────────────────────

describe('volcanoInputFromTable', () => {
  const table: DataTable = {
    rowLabels: ['g1', 'g2', 'g3'],
    columns: {
      effect: Float32Array.from([2, -2, 0.1]),
      signif: Float32Array.from([3, 3, 0.1]),
    },
  }

  it('maps effect→x, significance→y and classifies direction', () => {
    const pts = volcanoInputFromTable(table)
    expect(pts).toHaveLength(3)
    expect(pts[0]).toMatchObject({ label: 'g1', x: 2, direction: 'up' })
    expect(pts[1]).toMatchObject({ label: 'g2', direction: 'down' })
    expect(pts[2]).toMatchObject({ label: 'g3', direction: 'ns' })
    expect(pts[0].y).toBeCloseTo(3)
  })

  it('returns [] when the named columns are absent', () => {
    expect(volcanoInputFromTable({ rowLabels: ['a'], columns: {} })).toEqual([])
  })
})

// ── BarView: categorical → per-category count series ───────────────────────────

describe('barSeriesFromCategorical', () => {
  it('tallies one single-value series per category', () => {
    const cat = categorical([0, 0, 1], ['A', 'B'])
    const series = barSeriesFromCategorical(cat)
    expect(series).toEqual([
      { category: 'A', values: [2] },
      { category: 'B', values: [1] },
    ])
  })
})

// ── HistogramView: value column → uniform bins ─────────────────────────────────

describe('histogramFromColumn', () => {
  it('bins uniformly over [min,max] with edges length bins+1', () => {
    const h = histogramFromColumn([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)
    expect(h.binEdges).toHaveLength(6)
    expect(h.binEdges[0]).toBe(0)
    expect(h.binEdges[5]).toBeCloseTo(9) // max value is 9 → last edge is the max
    expect(h.counts).toEqual([2, 2, 2, 2, 2])
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(10)
  })

  it('flat column → one unit-width bin holding every value', () => {
    const h = histogramFromColumn([5, 5, 5], 4)
    expect(h.binEdges).toEqual([5, 6])
    expect(h.counts).toEqual([3])
  })

  it('empty column → no bins', () => {
    expect(histogramFromColumn([], 8)).toEqual({ binEdges: [], counts: [] })
  })

  it('skips non-finite values', () => {
    const h = histogramFromColumn([0, NaN, 10, Infinity], 2)
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(2)
  })
})
