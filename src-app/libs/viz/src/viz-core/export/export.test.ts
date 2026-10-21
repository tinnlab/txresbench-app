import { describe, it, expect } from 'vitest'
import { selectionToCSV, tableToCSV } from './data'
import { serializeSpec, deserializeSpec, specRoundTrips, type WorkspaceSpec } from './spec'
import { exportCanvasPNG } from './raster'
import { IndexMask } from '../data/selection'
import type { DataTable } from '../data/wire'

describe('selectionToCSV', () => {
  it('emits a header + one row per selected index', () => {
    const mask = IndexMask.fromIndices(100, [3, 41, 88])
    const csv = selectionToCSV(mask)
    expect(csv).toBe('index\n3\n41\n88')
    expect(csv.split('\n')).toHaveLength(4) // header + 3 rows
  })

  it('emits just the header for an empty mask', () => {
    expect(selectionToCSV(new IndexMask(10))).toBe('index')
  })
})

describe('tableToCSV', () => {
  const table: DataTable = {
    rowLabels: ['g1', 'g2'],
    columns: {
      // float32-exact values so the String() projection is deterministic.
      log2fc: new Float32Array([1.5, -2]),
      pval: new Float32Array([0.5, 0.25]),
    },
  }

  it('builds a rowLabel header + numeric columns (comma default)', () => {
    const csv = tableToCSV(table)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('rowLabel,log2fc,pval')
    expect(lines[1]).toBe('g1,1.5,0.5')
    expect(lines[2]).toBe('g2,-2,0.25')
  })

  it('honors a TSV separator', () => {
    const tsv = tableToCSV(table, '\t')
    expect(tsv.split('\n')[0]).toBe('rowLabel\tlog2fc\tpval')
    expect(tsv.split('\n')[1]).toBe('g1\t1.5\t0.5')
  })
})

describe('spec serialize/deserialize', () => {
  const spec: WorkspaceSpec = {
    version: 1,
    layout: {
      type: 'split',
      direction: 'column',
      sizes: [0.6, 0.4],
      children: [
        { type: 'leaf', cellId: 'top' },
        {
          type: 'split',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            { type: 'leaf', cellId: 'bl' },
            { type: 'leaf', cellId: 'br' },
          ],
        },
      ],
    },
    cells: [
      { id: 'top', kind: 'scatter', colorBy: 'categorical:group' },
      { id: 'bl', kind: 'image', colorBy: null },
      { id: 'br', kind: 'heatmap' },
    ],
  }

  it('round-trips deep-equal', () => {
    const back = deserializeSpec(serializeSpec(spec))
    expect(back).toEqual(spec)
  })

  it('specRoundTrips reports true', () => {
    expect(specRoundTrips(spec)).toBe(true)
  })
})

describe('exportCanvasPNG', () => {
  it('returns a data:image/png URL from a canvas', () => {
    // Prefer a real OffscreenCanvas where available; otherwise a minimal stub with
    // toDataURL (the node env has neither `document` nor `OffscreenCanvas.toDataURL`).
    const stub = {
      width: 4,
      height: 4,
      toDataURL: (type: string) => `data:${type};base64,AAAA`,
    } as unknown as HTMLCanvasElement
    const url = exportCanvasPNG(stub)
    expect(typeof url).toBe('string')
    expect(url.startsWith('data:image/png')).toBe(true)
  })
})

// Audit wave-2 F1 (HIGH security): CSV formula/spreadsheet injection is neutralized.
describe('tableToCSV — formula-injection guard', () => {
  it("prefixes a ' before a formula-trigger row label (and quotes it if needed)", () => {
    const table: DataTable = {
      rowLabels: ['=HYPERLINK("http://evil","x")', '+1', '-2', '@cmd', 'safe'],
      columns: { v: new Float32Array([1, 2, 3, 4, 5]) },
    }
    const rows = tableToCSV(table).split('\n').slice(1) // drop header
    expect(rows[0]).toMatch(/^"'=HYPERLINK/) // formula + embedded quote → apostrophe-prefixed + quoted
    expect(rows[1]).toBe("'+1,2") // leading + neutralized
    expect(rows[2]).toBe("'-2,3") // leading - neutralized
    expect(rows[3]).toBe("'@cmd,4") // leading @ neutralized
    expect(rows[4]).toBe('safe,5') // a safe label is untouched
  })
})
