import { describe, it, expect, beforeEach } from 'vitest'
import type { ScatterWidget, ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createViewStore } from './store'
import { registerViewStore, __resetViewStoresForTests, getViewStore } from './viewStores'
import { registerViewSpecActions, __resetRegisteredSpecsForTests } from './interpreter'
import { runAction } from '@/core/actions/defineAction'
import { namespaceActionId } from '@/modules/workbench/core/spec/ids'
import { buildScatterOption } from '@/modules/workbench/extensions/canvas/viz'
import type { Scope } from './expr'

// TEST-14 (PLAN.md ITEM-18) — the real-time filter↔viz loop through the shared store:
//   setThreshold → derived.filter_mask → scatter `filters` + kept-counts recompute;
//   applyGate    → keptMask combines slider AND gate.
// Drives the DECLARED actions via `runAction` (the same path a widget onCommit / an AI
// call takes), so the whole store→interpreter→derived→viz-option chain runs for real.

// obs: two samples (s1: rows 0,1 · s2: rows 2,3). nCount separates the outliers.
const obs = {
  nCount: [100, 400, 500, 90],
  nFeature: [50, 200, 250, 40],
  pct_mito: [3, 4, 5, 30],
  ident: ['s1', 's1', 's2', 's2'],
}

function spec(): ViewSpec {
  return {
    id: 'rt/qc',
    title: 'RT QC',
    permission: 'jobs::use',
    const: { criteria: ['nCount'] },
    state: {
      filteringParams: { type: 'map', default: {} },
      gate: { type: 'array', default: [] },
    },
    derived: {
      idents: { unique: '$data.obs.ident' },
      hiddenByCrit: {
        for_each: '$const.criteria as $c',
        value: {
          filter_mask: {
            values: '$data.obs[$c]',
            group_of: '$data.obs.ident',
            ranges: '$state.filteringParams[$c]',
          },
        },
      },
      sliderHidden: { or_masks: '$derived.hiddenByCrit' },
      hidden: { gate_mask: { base: '$derived.sliderHidden', gate: '$state.gate' } },
      metricFilters: {
        for_each: '$const.criteria as $c',
        key: '$c',
        value: { range_envelope: '$state.filteringParams[$c]' },
      },
      nCells: { count_by: { group: '$data.obs.ident', hidden: '$derived.hidden' } },
    },
    widgets: [],
    actions: [
      {
        id: 'setThreshold',
        title: 'Set threshold',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { criterion: 'string', ident: 'string', range: '[number, number]' },
        body: [{ set: { 'filteringParams.{$params.criterion}.{$params.ident}': '$params.range' } }],
      },
      {
        id: 'applyGate',
        title: 'Apply gate',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { ids: 'array<int>' },
        body: [{ set: { gate: '$params.ids' } }],
      },
    ],
  }
}

const VIEW = 'rt-view'
const scatterW: ScatterWidget = {
  kind: 'scatter',
  id: 'sc',
  encode: { x: 'nCount', y: 'nFeature', colorBy: 'pct_mito' },
  filters: '$derived.metricFilters',
  selection: '$state.gate',
}

function scatterScope() {
  const store = getViewStore(VIEW)!
  const s: Scope = { params: {}, state: store.state, derived: store.derived, const: {}, data: { obs } }
  return s
}

beforeEach(() => {
  __resetViewStoresForTests()
  __resetRegisteredSpecsForTests()
  const s = spec()
  registerViewSpecActions(s)
  registerViewStore(VIEW, createViewStore(s, VIEW, { obs }))
})

describe('real-time filter↔viz loop (ITEM-18)', () => {
  it('setThreshold → filter_mask + kept-counts recompute → scatter filters', async () => {
    const store = getViewStore(VIEW)!
    // baseline: no thresholds → nothing hidden.
    expect((store.derived.nCells as Record<string, { after: number }>).s1.after).toBe(2)
    expect(store.derived.hidden).toEqual([false, false, false, false])
    expect(buildScatterOption(scatterW, scatterScope()).filters).toBeUndefined()

    // drag s1's nCount slider up to [200, 100000] → s1 row0 (nCount 100) drops.
    await runAction(namespaceActionId('rt/qc', 'setThreshold'), {
      view_id: VIEW,
      criterion: 'nCount',
      ident: 's1',
      range: [200, 100000],
    })

    const nCells = store.derived.nCells as Record<string, { before: number; after: number }>
    expect(nCells.s1).toEqual({ before: 2, after: 1 }) // row0 hidden
    expect(nCells.s2).toEqual({ before: 2, after: 2 }) // s2 untouched
    expect(store.derived.hidden).toEqual([true, false, false, false])
    // the scatter's value-range filter now reflects the threshold envelope.
    expect(buildScatterOption(scatterW, scatterScope()).filters).toEqual({ nCount: [200, 100000] })
  })

  it('applyGate → keptMask combines slider AND gate', async () => {
    // slider first: hide s1 row0.
    await runAction(namespaceActionId('rt/qc', 'setThreshold'), {
      view_id: VIEW,
      criterion: 'nCount',
      ident: 's1',
      range: [200, 100000],
    })
    const store = getViewStore(VIEW)!
    expect(store.derived.sliderHidden).toEqual([true, false, false, false])

    // now brush a gate keeping only rows 1 and 2 → row3 (in-slider-range) also drops.
    await runAction(namespaceActionId('rt/qc', 'applyGate'), { view_id: VIEW, ids: [1, 2] })

    // combined: row0 hidden by slider, row3 hidden by gate; rows 1,2 kept.
    expect(store.derived.hidden).toEqual([true, false, false, true])
    const nCells = store.derived.nCells as Record<string, { after: number }>
    expect(nCells.s1.after).toBe(1) // only row1
    expect(nCells.s2.after).toBe(1) // only row2 (row3 gated out)
    // the gate also drives the scatter's selection-dim.
    expect(buildScatterOption(scatterW, scatterScope()).selection?.ids).toEqual([1, 2])
  })
})
