// titles.test.ts — TEST-6 [covers: ITEM-4/7] — the plot-editing TITLES: the plot title + x/y axis
// titles resolve from the VizOption onto the resolved series (and the cell), only the set fields are
// carried, and unset ⇒ absent (the View's default title, byte-identical).

import { describe, it, expect, beforeAll } from 'vitest'
import { parseOption } from './parse'
import { installBuiltins } from '../charts/installBuiltins'
import { getChartType } from '../registry/registry'
import type { DatasetCatalog } from '../data/wire'
import type { VizOption } from './types'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 100,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: ['Feature A'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
  continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
  hasImage: false,
}

const opt = (extra: Partial<VizOption['series'][number]>): VizOption => ({
  dataset: { id: 'demo' },
  grid: [{ id: 'g', region: {} }],
  series: [{ id: 's', type: 'scatter', coordId: 'g', ...extra }],
})

describe('plot-editing: titles resolution (ITEM-4)', () => {
  beforeAll(() => {
    if (!getChartType('scatter')) installBuiltins()
  })

  it('plot title + axis titles resolve onto the series', () => {
    const plan = parseOption(opt({ title: 'My QC', axisTitles: { x: 'UMAP-1', y: 'UMAP-2' } }), { demo: CATALOG })
    expect(plan.series[0].title).toBe('My QC')
    expect(plan.series[0].axisTitles).toEqual({ x: 'UMAP-1', y: 'UMAP-2' })
    // …and onto the cell (the render + editor read them there).
    expect(plan.cells['g'].title).toBe('My QC')
    expect(plan.cells['g'].axisTitles).toEqual({ x: 'UMAP-1', y: 'UMAP-2' })
  })

  it('only the SET axis is carried (x-only)', () => {
    const plan = parseOption(opt({ axisTitles: { x: 'only-x' } }), { demo: CATALOG })
    expect(plan.series[0].axisTitles).toEqual({ x: 'only-x' })
  })

  it('no titles ⇒ absent (byte-identical to the View default)', () => {
    const plan = parseOption(opt({}), { demo: CATALOG })
    expect(plan.series[0].title).toBeUndefined()
    expect(plan.series[0].axisTitles).toBeUndefined()
    expect(plan.cells['g'].title).toBeUndefined()
    expect(plan.cells['g'].axisTitles).toBeUndefined()
  })

  it('a non-string title is dropped (defensive parse)', () => {
    const plan = parseOption(opt({ title: 42 as unknown as string }), { demo: CATALOG })
    expect(plan.series[0].title).toBeUndefined()
  })
})
