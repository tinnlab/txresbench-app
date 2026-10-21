// tooltipModel.test.ts — the O(1) tooltip data model. Verifies exact field values from
// known resident columns, that a custom `extra` field appears, matrix row/col → the right
// cell + labels, clean '—' for missing/NaN (no crash), and — the headline — that resolving
// is O(fields) NOT O(N): a giant column is indexed at ONE point without scanning.

import { describe, it, expect, vi } from 'vitest'
import {
  buildScatterTooltipFields,
  resolveTooltip,
  buildMatrixTooltipFields,
  resolveMatrixTooltip,
  defaultFormat,
  formatNumber,
  type TooltipContext,
  type TooltipMatrix,
} from './tooltipModel'

// ── scatter defaults ──────────────────────────────────────────────────────────

describe('buildScatterTooltipFields + resolveTooltip', () => {
  // 3 points; positions interleaved; codes into 2 categories; a color-by continuous col.
  const ctx: TooltipContext = {
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    codes: new Uint16Array([0, 1, 0]),
    categories: ['T cell', 'B cell'],
    colorValue: new Float32Array([0.5, 1.25, 9.75]),
    columns: { qcA: new Float32Array([10, 20, 30]) },
  }

  it('produces exact field values by O(1) indexing at the picked index', () => {
    const fields = buildScatterTooltipFields(ctx)
    const { rows } = resolveTooltip(fields, 1) // second point

    expect(rows).toEqual([
      { label: 'Group', value: 'B cell' }, // categories[codes[1]] = categories[1]
      { label: 'Value', value: '1.25' }, // colorValue[1]
      { label: 'x', value: '3' }, // positions[2*1]
      { label: 'y', value: '4' }, // positions[2*1+1]
    ])
  })

  it('honors catalog labels + a categorical color-by', () => {
    const fields = buildScatterTooltipFields(
      { ...ctx, colorValue: new Float32Array([0, 1, 0]), colorCategories: ['lo', 'hi'] },
      { group: 'Cell type', color: 'Phase', x: 'UMAP1', y: 'UMAP2' },
    )
    const { rows } = resolveTooltip(fields, 1)
    expect(rows[0]).toEqual({ label: 'Cell type', value: 'B cell' })
    expect(rows[1]).toEqual({ label: 'Phase', value: 'hi' }) // colorCategories[colorValue[1]]
    expect(rows[2].label).toBe('UMAP1')
    expect(rows[3].label).toBe('UMAP2')
  })

  it('CUSTOMIZABLE: an extra field referencing a resident column appears', () => {
    const qc = ctx.columns!.qcA as Float32Array
    const fields = buildScatterTooltipFields(ctx, undefined, [
      { key: 'qc', label: 'QC A', accessor: i => qc[i] },
    ])
    const { rows } = resolveTooltip(fields, 2)
    expect(rows.at(-1)).toEqual({ label: 'QC A', value: '30' })
  })

  it('omits group + color rows when those columns are absent (still has x/y)', () => {
    const fields = buildScatterTooltipFields({ positions: ctx.positions })
    expect(fields.map(f => f.key)).toEqual(['x', 'y'])
  })

  it('renders missing / NaN as a clean em-dash, never a crash', () => {
    const nanCtx: TooltipContext = {
      positions: new Float32Array([Number.NaN, Number.NaN]),
      codes: new Uint16Array([9]), // out-of-range code → undefined category
      categories: ['only'],
      colorValue: new Float32Array([Number.NaN]),
    }
    const { rows } = resolveTooltip(buildScatterTooltipFields(nanCtx), 0)
    expect(rows[0].value).toBe('—') // categories[9] undefined
    expect(rows[1].value).toBe('—') // NaN color
    expect(rows[2].value).toBe('—') // NaN x
    expect(rows[3].value).toBe('—') // NaN y
  })
})

// ── PERF PROOF: O(1) / O(fields), never O(N) ──────────────────────────────────

describe('resolveTooltip is O(1) in N (never scans the columns)', () => {
  it('indexes a MILLION-point column at one point without scanning it', () => {
    const N = 1_000_000
    const positions = new Float32Array(N * 2)
    const target = 777_777
    positions[2 * target] = 42
    positions[2 * target + 1] = -13
    const big = new Float32Array(N)
    big[target] = 3.5

    // Spy accessors so we can assert each is called EXACTLY once (O(fields)) and reads
    // only the picked index — no loop over N.
    const readIndices: number[] = []
    const xSpy = vi.fn((i: number) => {
      readIndices.push(i)
      return positions[2 * i]
    })
    const extraSpy = vi.fn((i: number) => big[i])

    const fields = [
      { key: 'x', label: 'x', accessor: xSpy },
      { key: 'big', label: 'Big', accessor: extraSpy },
    ]
    const { rows } = resolveTooltip(fields, target)

    expect(rows).toEqual([
      { label: 'x', value: '42' },
      { label: 'Big', value: '3.5' },
    ])
    // Each accessor invoked once per resolve — O(fields), independent of N=1e6.
    expect(xSpy).toHaveBeenCalledTimes(1)
    expect(extraSpy).toHaveBeenCalledTimes(1)
    expect(readIndices).toEqual([target]) // only the picked index was touched
  })
})

// ── heatmap matrix ─────────────────────────────────────────────────────────────

describe('buildMatrixTooltipFields + resolveMatrixTooltip', () => {
  // 2 rows (groups) × 3 cols (features), row-major.
  const matrix: TooltipMatrix = {
    rows: ['g0', 'g1'],
    cols: ['fA', 'fB', 'fC'],
    values: new Float32Array([1, 2, 3, 4, 5, 6]),
    counts: new Uint32Array([10, 11, 12, 13, 14, 15]),
  }

  it('resolves row/col → the right cell value + labels + coord + n', () => {
    const fields = buildMatrixTooltipFields(matrix)
    const { rows } = resolveMatrixTooltip(fields, 1, 2) // g1 × fC → values[1*3+2]=6

    expect(rows).toEqual([
      { label: 'Group', value: 'g1' },
      { label: 'Feature', value: 'fC' },
      { label: 'Value', value: '6' },
      { label: 'Cell', value: '1, 2' },
      { label: 'n', value: '15' }, // counts[1*3+2]
    ])
  })

  it('omits n when the matrix carries no counts; honors custom labels + extra', () => {
    const noCount: TooltipMatrix = { rows: matrix.rows, cols: matrix.cols, values: matrix.values }
    const fields = buildMatrixTooltipFields(
      noCount,
      { group: 'Cluster', feature: 'Gene', value: 'Mean' },
      [{ key: 'pct', label: '% expr', accessor: (r, c) => (r === 0 && c === 0 ? 88 : 0) }],
    )
    const { rows } = resolveMatrixTooltip(fields, 0, 0)
    expect(rows.map(r => r.label)).toEqual(['Cluster', 'Gene', 'Mean', 'Cell', '% expr'])
    expect(rows.find(r => r.label === 'n')).toBeUndefined()
    expect(rows.at(-1)).toEqual({ label: '% expr', value: '88' })
  })

  it('NaN / out-of-range cell → em-dash, no crash', () => {
    const m: TooltipMatrix = {
      rows: ['g0'],
      cols: ['fA'],
      values: new Float32Array([Number.NaN]),
    }
    const { rows } = resolveMatrixTooltip(buildMatrixTooltipFields(m), 0, 0)
    expect(rows.find(r => r.label === 'Value')!.value).toBe('—')
  })

  it('matrix resolve is O(1): a huge matrix is indexed at one cell', () => {
    const R = 2000
    const C = 2000 // 4M cells
    const values = new Float32Array(R * C)
    values[1234 * C + 567] = 9.5
    const m: TooltipMatrix = {
      rows: Array.from({ length: R }, (_, i) => `r${i}`),
      cols: Array.from({ length: C }, (_, i) => `c${i}`),
      values,
    }
    const { rows } = resolveMatrixTooltip(buildMatrixTooltipFields(m), 1234, 567)
    expect(rows.find(r => r.label === 'Value')!.value).toBe('9.5')
  })
})

// ── clustering → tooltip wiring (regression for the cluster-reorder mislabel) ────
//
// When HeatmapView clusters rows/cols it reorders the VALUES by the leaf orders
// (`reordered[i*nCols+j] = base[rowOrder[i]*nCols + colOrder[j]]`) and must build the
// display matrix's LABELS with the SAME orders. This replicates that construction and
// asserts that at every DISPLAY cell the resolved Group/Feature LABEL matches the ORIGINAL
// category rowOrder[i]/colOrder[j] that the reordered VALUE came from — i.e. label and
// value describe the same original cell. The bug paired reordered values with
// original-order labels, silently mislabeling every tooltip when clustering was on.

/** Pure replica of HeatmapView's step-3 reorder + step-4 displayMatrix construction. */
function buildDisplayMatrix(
  base: TooltipMatrix,
  rowOrder: readonly number[],
  colOrder: readonly number[],
): TooltipMatrix {
  const nRows = base.rows.length
  const nCols = base.cols.length
  const reordered = new Float32Array(nRows * nCols)
  for (let i = 0; i < nRows; i++)
    for (let j = 0; j < nCols; j++)
      reordered[i * nCols + j] = base.values[rowOrder[i] * nCols + colOrder[j]]
  return {
    rows: rowOrder.map(i => base.rows[i]),
    cols: colOrder.map(j => base.cols[j]),
    values: reordered,
  }
}

describe('clustered heatmap tooltip: label follows the reordered value', () => {
  // 3×3, each cell uniquely identifiable by its ORIGINAL (r,c): value = 10*r + c.
  const base: TooltipMatrix = {
    rows: ['r0', 'r1', 'r2'],
    cols: ['c0', 'c1', 'c2'],
    values: new Float32Array([0, 1, 2, 10, 11, 12, 20, 21, 22]),
  }

  it('non-identity rowOrder/colOrder: display (i,j) → label of rowOrder[i]/colOrder[j] AND its value', () => {
    const rowOrder = [2, 0, 1]
    const colOrder = [1, 2, 0]
    const display = buildDisplayMatrix(base, rowOrder, colOrder)
    const fields = buildMatrixTooltipFields(display)

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const { rows } = resolveMatrixTooltip(fields, i, j)
        const origR = rowOrder[i]
        const origC = colOrder[j]
        // LABEL must name the original category the reordered value came from.
        expect(rows.find(r => r.label === 'Group')!.value).toBe(base.rows[origR])
        expect(rows.find(r => r.label === 'Feature')!.value).toBe(base.cols[origC])
        // VALUE (already correct pre-fix) must describe the SAME original cell.
        expect(rows.find(r => r.label === 'Value')!.value).toBe(String(10 * origR + origC))
      }
    }
  })

  it('identity orders (clustering OFF): display matrix == the original, byte-identical', () => {
    const rowOrder = [0, 1, 2]
    const colOrder = [0, 1, 2]
    const display = buildDisplayMatrix(base, rowOrder, colOrder)
    expect(display.rows).toEqual(base.rows)
    expect(display.cols).toEqual(base.cols)
    expect(Array.from(display.values)).toEqual(Array.from(base.values))

    const fields = buildMatrixTooltipFields(display)
    const { rows } = resolveMatrixTooltip(fields, 1, 2) // r1 × c2 → value 12
    expect(rows.find(r => r.label === 'Group')!.value).toBe('r1')
    expect(rows.find(r => r.label === 'Feature')!.value).toBe('c2')
    expect(rows.find(r => r.label === 'Value')!.value).toBe('12')
  })
})

// ── formatting helpers ──────────────────────────────────────────────────────────

describe('formatting', () => {
  it('formatNumber: integers verbatim, small/large exponential, else trimmed 4dp', () => {
    expect(formatNumber(42)).toBe('42')
    expect(formatNumber(12.34)).toBe('12.34')
    expect(formatNumber(0.000012)).toBe('1.20e-5')
    expect(formatNumber(5_000_000)).toBe('5000000') // integer stays verbatim
    expect(formatNumber(2_500_000.5)).toBe('2.50e+6')
    expect(formatNumber(Number.NaN)).toBe('—')
  })

  it('defaultFormat: null → em-dash, strings pass through', () => {
    expect(defaultFormat(null)).toBe('—')
    expect(defaultFormat('B cell')).toBe('B cell')
    expect(defaultFormat(1.5)).toBe('1.5')
  })
})
