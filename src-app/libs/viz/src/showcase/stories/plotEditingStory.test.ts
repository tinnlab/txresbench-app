// plotEditingStory.test.ts — TEST-12 [covers: ITEM-10] — smoke that the plot-editing showcase story's
// option is well-formed: it parses to a grid carrying the `controls` block (all editable) + an editable
// categorical colorBy + the title/style/axisTitles edit fields, so the story renders the full surface.

import { describe, it, expect, beforeAll } from 'vitest'
import { parseOption } from '../../viz-core/option/parse'
import { installBuiltins } from '../../viz-core/charts/installBuiltins'
import { getChartType } from '../../viz-core/registry/registry'
import { buildOption } from './00c-plot-editing.story'
import type { DatasetCatalog } from '../../viz-core/data/wire'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 100,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: ['Feature A', 'Feature B', 'Feature C'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
  continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
  hasImage: false,
}

describe('plot-editing showcase story (ITEM-10 / TEST-12)', () => {
  beforeAll(() => {
    if (!getChartType('scatter')) installBuiltins()
  })

  it('parses to a grid with all controls editable + the edit fields present', () => {
    const plan = parseOption(buildOption(), { demo: CATALOG })
    // controls: every control editable.
    expect(plan.controls).toEqual({
      legend: { show: true, editable: true },
      colormap: { show: true, editable: true },
      titles: { show: true, editable: true },
      pointSize: { show: true, editable: true },
    })
    // four cells: two scatter (legend/colormap), a box + violin (titles).
    expect(Object.keys(plan.cells).sort()).toEqual(['box', 'cat', 'cont', 'violin'])
    // categorical colorBy on the legend cell (editable target).
    expect(plan.cells['cat'].colorBy?.mode).toBe('categorical')
    // marks style on a scatter; plot + axis titles on a chart.
    expect(plan.cells['cat'].style).toEqual({ radius: 3, opacity: 0.85 })
    expect(plan.cells['cat'].title).toBe('Cell types')
    expect(plan.cells['box'].title).toBe('Expression')
    expect(plan.cells['box'].axisTitles).toEqual({ x: 'Group', y: 'Feature A' })
  })
})
