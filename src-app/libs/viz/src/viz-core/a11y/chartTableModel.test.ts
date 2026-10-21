// chartTableModel.test.ts — each builder on a KNOWN aggregate → exact columns + rows, plus
// degenerate (empty) safety and CSV serialisation. Pure math; no GL, no DOM.

import { describe, it, expect } from 'vitest'
import {
  boxStatsToTable,
  matrixToTable,
  barCountsToTable,
  violinSummaryToTable,
  tableModelToCsv,
  type BoxTableRow,
  type MatrixCell,
} from './chartTableModel'

describe('boxStatsToTable', () => {
  it('emits the seven box columns and one row per group with exact stats', () => {
    const stats: BoxTableRow[] = [
      { group: 'a', n: 100, q1: 1, median: 2, q3: 3, lowerFence: -2, upperFence: 6 },
      { group: 'b', n: 50, q1: 10, median: 12, q3: 15, lowerFence: 2.5, upperFence: 22.5 },
    ]
    const t = boxStatsToTable(stats)
    expect(t.columns).toEqual(['Group', 'N', 'Q1', 'Median', 'Q3', 'Lower fence', 'Upper fence'])
    expect(t.rows).toEqual([
      ['a', 100, 1, 2, 3, -2, 6],
      ['b', 50, 10, 12, 15, 2.5, 22.5],
    ])
  })

  it('empty groups → header only, no rows', () => {
    const t = boxStatsToTable([])
    expect(t.columns).toHaveLength(7)
    expect(t.rows).toEqual([])
  })
})

describe('matrixToTable', () => {
  it('reshapes group×feature cells into a wide grid (first-seen order)', () => {
    const cells: MatrixCell[] = [
      { column: 'F1', group: 'g0', value: 1 },
      { column: 'F1', group: 'g1', value: 2 },
      { column: 'F2', group: 'g0', value: 3 },
      { column: 'F2', group: 'g1', value: 4 },
    ]
    const t = matrixToTable(cells)
    expect(t.columns).toEqual(['Group', 'F1', 'F2'])
    expect(t.rows).toEqual([
      ['g0', 1, 3],
      ['g1', 2, 4],
    ])
  })

  it('missing (group,feature) pair → empty cell', () => {
    const t = matrixToTable([
      { column: 'F1', group: 'g0', value: 5 },
      { column: 'F2', group: 'g1', value: 7 },
    ])
    expect(t.columns).toEqual(['Group', 'F1', 'F2'])
    expect(t.rows).toEqual([
      ['g0', 5, ''],
      ['g1', '', 7],
    ])
  })

  it('empty matrix → lone Group header, no rows', () => {
    const t = matrixToTable([])
    expect(t.columns).toEqual(['Group'])
    expect(t.rows).toEqual([])
  })
})

describe('barCountsToTable', () => {
  it('single-series counts → Category / Count rows', () => {
    const t = barCountsToTable([
      { category: 'x', values: [12] },
      { category: 'y', values: [7] },
    ])
    expect(t.columns).toEqual(['Category', 'Count'])
    expect(t.rows).toEqual([
      ['x', 12],
      ['y', 7],
    ])
  })

  it('stacked series → summed count', () => {
    const t = barCountsToTable([{ category: 'x', values: [3, 4, 5] }])
    expect(t.rows).toEqual([['x', 12]])
  })

  it('empty → header only', () => {
    expect(barCountsToTable([]).rows).toEqual([])
  })
})

describe('violinSummaryToTable', () => {
  it('emits Group / N / Median / IQR rows', () => {
    const t = violinSummaryToTable([
      { group: 'a', n: 200, median: 5, iqr: 2 },
      { group: 'b', n: 180, median: 9, iqr: 3.5 },
    ])
    expect(t.columns).toEqual(['Group', 'N', 'Median', 'IQR'])
    expect(t.rows).toEqual([
      ['a', 200, 5, 2],
      ['b', 180, 9, 3.5],
    ])
  })

  it('empty → header only', () => {
    expect(violinSummaryToTable([]).rows).toEqual([])
  })
})

describe('tableModelToCsv', () => {
  it('serialises header + rows and quotes fields with commas/quotes', () => {
    const csv = tableModelToCsv({
      columns: ['Group', 'Note'],
      rows: [
        ['a', 'plain'],
        ['b', 'has, comma'],
        ['c', 'has "quote"'],
      ],
    })
    expect(csv).toBe(
      ['Group,Note', 'a,plain', 'b,"has, comma"', 'c,"has ""quote"""'].join('\n'),
    )
  })

  it('round-trips a box table header', () => {
    const csv = tableModelToCsv(
      boxStatsToTable([{ group: 'a', n: 3, q1: 1, median: 2, q3: 3, lowerFence: 0, upperFence: 4 }]),
    )
    expect(csv.split('\n')[0]).toBe('Group,N,Q1,Median,Q3,Lower fence,Upper fence')
    expect(csv.split('\n')[1]).toBe('a,3,1,2,3,0,4')
  })
})

// Audit wave-2 F1 (HIGH security): the a11y "Copy CSV" path also neutralizes formula injection.
describe('tableModelToCsv — formula-injection guard', () => {
  it("prefixes a ' before a formula-trigger group label", () => {
    const csv = tableModelToCsv({ columns: ['Group', 'N'], rows: [['=1+1', 5], ['@x', 3], ['ok', 2]] })
    const rows = csv.split('\n').slice(1)
    expect(rows[0]).toBe("'=1+1,5")
    expect(rows[1]).toBe("'@x,3")
    expect(rows[2]).toBe('ok,2')
  })
})
