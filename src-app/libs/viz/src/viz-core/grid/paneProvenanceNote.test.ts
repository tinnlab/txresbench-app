// paneProvenanceNote.test.ts — a per-cell PROVENANCE MARKER the host hands viz, and the two
// surfaces it has to reach.
//
// ── WHY THE FIELD EXISTS ─────────────────────────────────────────────────────────────────────────
// A host may know something about a picture that the picture cannot show: in txresbench's case, that the
// artifact supplying its colouring never declared which row space it is aligned to, so the points
// and the colours may or may not be about the same cells. That fact is only worth carrying if it is
// carried where the picture is READ. A marker shown once, in the picker, at the moment of choosing,
// is not a marker — it is a disclaimer nobody sees again.
//
// So the cell carries the string, and viz renders it on the two surfaces that survive:
//   · the plot CHROME, beside the title, for as long as the cell is open, and
//   · the LEGEND, whose geometry is shared with the vector export — which is the load-bearing one,
//     because a screenshot crops the chrome and keeps the legend.
//
// Viz renders the string and knows nothing about what it means. The geometry half is asserted in
// `../controls/legendRender.test.ts`; what is asserted HERE is the model plumbing that decides
// whether a marked cell can reach either surface at all: the wire field survives `parseOption` and
// `getOption`, and it travels with a cell's CONTENT on a drag-swap — otherwise a swap would launder
// the mark off a cell whose data is still unverified (and onto one whose data is fine).

import { describe, expect, it } from 'vitest'
import { type GridCell, swapCellContent } from './gridModel'
import { createVizStores } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { installBuiltins } from '../charts/installBuiltins'
import { FixtureSource } from '../data/fixtures'
import { parseOption } from '../option/parse'
import type { VizOption } from '../option/types'
import type { DatasetCatalog } from '../data/wire'
import { beforeAll } from 'vitest'

const NOTE = 'alignment not declared'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 3,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: false,
}

beforeAll(() => {
  installBuiltins()
})

describe('per-cell provenance note', () => {
  const option: VizOption = {
    dataset: { id: 'demo' },
    grid: [{ id: 'g-marked', region: { col: 0 } }, { id: 'g-plain', region: { col: 1 } }],
    series: [
      { id: 's-marked', type: 'scatter', coordId: 'g-marked', encode: { layout: 'primary' }, provenanceNote: NOTE },
      { id: 's-plain', type: 'scatter', coordId: 'g-plain', encode: { layout: 'primary' } },
    ],
  }

  it('parseOption stamps it; a series without one stays field-free', () => {
    const plan = parseOption(option, { demo: CATALOG })
    expect(plan.cells['g-marked'].provenanceNote).toBe(NOTE)
    // Field-free is what keeps markers RARE by construction rather than by convention: an
    // unmarked cell carries nothing at all, so "marked" is never the default state of anything.
    expect(plan.cells['g-plain'].provenanceNote).toBeUndefined()
  })

  it('a BLANK declared note is not stamped, and a padded one is trimmed', () => {
    const blank: VizOption = {
      ...option,
      series: [{ ...option.series![0], provenanceNote: '   \n ' }, option.series![1]],
    }
    expect(parseOption(blank, { demo: CATALOG }).cells['g-marked'].provenanceNote).toBeUndefined()
    const padded: VizOption = {
      ...option,
      series: [{ ...option.series![0], provenanceNote: `  ${NOTE} ` }, option.series![1]],
    }
    expect(parseOption(padded, { demo: CATALOG }).cells['g-marked'].provenanceNote).toBe(NOTE)
  })

  it('a save/restore round-trip keeps the mark', async () => {
    // A restore that dropped it would hand back an UNMARKED picture of data whose provenance is
    // still exactly as unverified as it was before the save.
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 100 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'g1', region: { col: 0 } }],
      series: [{ id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' }, provenanceNote: NOTE }],
    })
    const saved = controller.getOption()
    expect(saved.series?.find(s => s.id === 'g1')?.provenanceNote).toBe(NOTE)
    await controller.setOption(JSON.parse(JSON.stringify(saved)) as VizOption, { replace: true })
    expect(stores.gridWorkspace.getState().cells['g1'].provenanceNote).toBe(NOTE)
  })

  it('travels with the CONTENT on a swap — in BOTH directions', () => {
    const a: GridCell = { id: 'a', kind: 'scatter', layoutId: 'primary', provenanceNote: NOTE }
    const b: GridCell = { id: 'b', kind: 'violin', layoutId: 'primary' }
    const [aNext, bNext] = swapCellContent(a, b)
    // The mark is a fact about the DATA the cell draws, so it follows the content it is about…
    expect(bNext.provenanceNote).toBe(NOTE)
    // …and does not stay behind on the cell that now draws something else.
    expect(aNext.provenanceNote).toBeUndefined()
  })
})
