import { describe, it, expect } from 'vitest'
import { installBuiltins } from '../charts/installBuiltins'
import { installCoordSystems } from '../coordSystem/installCoordSystems'
import {
  cellRendersOnSharedDeck,
  isMigratedChart,
  SHARED_DECK_CHART_KINDS,
} from './multiView'
import type { GridCell } from './gridModel'

// The predicates resolve cell.kind against the chart + coord-system registries.
installBuiltins()
installCoordSystems()

const cell = (kind: string): Pick<GridCell, 'kind'> => ({ kind: kind as GridCell['kind'] })

describe('shared-deck-charts migration predicates', () => {
  it('dense (world2d) kinds already render on the shared deck; charts do not (by coord system)', () => {
    expect(cellRendersOnSharedDeck(cell('scatter'))).toBe(true)
    expect(cellRendersOnSharedDeck(cell('image'))).toBe(true)
    expect(cellRendersOnSharedDeck(cell('box'))).toBe(false) // chart2d → own-canvas coord host
    expect(cellRendersOnSharedDeck(cell('heatmap'))).toBe(false) // matrix2d → own-canvas coord host
  })

  it('isMigratedChart is true for a chart kind in SHARED_DECK_CHART_KINDS, false for dense', () => {
    // All 7 chart kinds are migrated this round.
    for (const k of ['volcano', 'histogram', 'box', 'heatmap', 'bar', 'dotplot', 'violin']) {
      expect(SHARED_DECK_CHART_KINDS.has(k)).toBe(true)
      expect(isMigratedChart(cell(k))).toBe(true)
    }
    // Dense kinds are NOT "migrated charts" (they were always shared) → false, so they don't get
    // double-counted into the chart-deck path.
    expect(isMigratedChart(cell('scatter'))).toBe(false)
    expect(isMigratedChart(cell('image'))).toBe(false)
  })

  it('an unregistered / non-migrated chart kind is not on the chart-deck path', () => {
    expect(isMigratedChart(cell('__nope__'))).toBe(false)
  })
})
