// marks.test.ts — TEST-7 [covers: ITEM-5] — the plot-editing MARKS style (point size + opacity):
// `style.radius` / `style.opacity` resolve onto the series through parseOption, defaults are
// byte-identical when unset, and the round-trip re-emits only the set fields.

import { describe, it, expect, beforeAll } from 'vitest'
import { parseOption } from '../option/parse'
import { installBuiltins } from './installBuiltins'
import { getChartType } from '../registry/registry'
import { MARK_RADIUS_MIN, MARK_RADIUS_MAX } from '../controls/MarksControl'
import type { DatasetCatalog } from '../data/wire'
import type { VizOption } from '../option/types'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 100,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: ['Feature A'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
  continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
  hasImage: false,
}

const opt = (style?: { radius?: number; opacity?: number }): VizOption => ({
  dataset: { id: 'demo' },
  grid: [{ id: 'g', region: {} }],
  series: [{ id: 's', type: 'scatter', coordId: 'g', ...(style ? { style } : {}) }],
})

describe('plot-editing: mark style resolution (ITEM-5)', () => {
  beforeAll(() => {
    if (!getChartType('scatter')) installBuiltins()
  })

  it('radius + opacity resolve onto the series style', () => {
    const plan = parseOption(opt({ radius: 5, opacity: 0.4 }), { demo: CATALOG })
    expect(plan.series[0].style).toEqual({ radius: 5, opacity: 0.4 })
  })

  it('only the SET field is carried (radius-only / opacity-only)', () => {
    expect(parseOption(opt({ radius: 3 }), { demo: CATALOG }).series[0].style).toEqual({ radius: 3 })
    expect(parseOption(opt({ opacity: 0.7 }), { demo: CATALOG }).series[0].style).toEqual({ opacity: 0.7 })
  })

  it('no style ⇒ absent (byte-identical to pre-feature)', () => {
    expect(parseOption(opt(), { demo: CATALOG }).series[0].style).toBeUndefined()
  })

  it('a non-number field is dropped (defensive parse)', () => {
    // radius given, opacity garbage → only radius survives.
    const plan = parseOption(
      opt({ radius: 4, opacity: 'x' as unknown as number }),
      { demo: CATALOG },
    )
    expect(plan.series[0].style).toEqual({ radius: 4 })
  })

  it('the marks control offers a sane point-size range', () => {
    expect(MARK_RADIUS_MIN).toBeLessThan(MARK_RADIUS_MAX)
    expect(MARK_RADIUS_MIN).toBeGreaterThan(0)
  })
})
