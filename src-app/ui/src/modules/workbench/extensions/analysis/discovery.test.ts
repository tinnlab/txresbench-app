// TEST-13 (ITEM-17) — visualization discoverability. `availableVisualizations` resolves
// an analysis's advertised viz from BOTH (a) its declarative `view_spec` viz widgets and
// (b) datatype-keyed `views` whose `consumes` matches the analysis `produces`,
// and marks a viz whose DECLARED data precondition (`requires`) is unmet unavailable WITH
// a reason rather than silently dropping it (the list-and-explain contract).
//
// NOTE: co-located under `analysis/` (not the declarative engine under `core/`) — this wave's scope is disjoint
// from the declarative engine build; the resolver is a pure `analysis/` utility.
//
// ITEM-34 dropped the `plotTypes` half of source (b) with the `plotTypes` contribution
// point — its reader was doubly dead (`registry` defaults to `{}` and the ONE production
// caller, `AnalysisRunPanel`, passes no `registry` prop). The `views` half is unchanged,
// so every case below is re-pointed at it rather than deleted.

import { describe, expect, it } from 'vitest'
import type { AnalysisContribution } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { availableVisualizations, needsDataReason } from './discovery'

function analysis(over: Partial<AnalysisContribution> & Pick<AnalysisContribution, 'id'>): AnalysisContribution {
  return {
    extensionId: 'test',
    apiVersion: '^1.0',
    title: over.id,
    category: 'qc',
    accepts: [],
    produces: [],
    params: { fields: [] },
    defaults: {},
    run: { kind: 'builtin', fn: 'noop' },
    ...over,
  } as AnalysisContribution
}

// A Filter-like view_spec: a metric scatter (always drawable) + an embedding scatter that
// DECLARES `requires: ['vis2D']` (and separately gates its render on the same slice) + a violin.
const filterViewSpec: ViewSpec = {
  id: 'cell.filter.view',
  title: 'Filter cells',
  permission: 'studies::use',
  state: {},
  widgets: [
    {
      kind: 'scatter',
      id: 'metricScatter',
      title: 'nCount × nFeature',
      encode: { x: '$data.obs.nCount', y: '$data.obs.nFeature', colorBy: '$data.obs.pctMito' },
    },
    {
      kind: 'group',
      children: [
        {
          kind: 'scatter',
          id: 'embeddingScatter',
          title: 'Embedding',
          when: '$data.vis2D',
          requires: ['vis2D'],
          encode: { x: '$data.vis2D.x', y: '$data.vis2D.y' },
        },
        { kind: 'violin', id: 'metricViolin', title: 'Per-sample violins', points: '$data.obs.nCount' },
      ],
    },
  ],
  actions: [],
}

describe('availableVisualizations — declared view_spec viz (TEST-13a)', () => {
  const filter = analysis({ id: 'cell.filter', produces: ['single-cell/expression'] })
  const withView = { ...filter, view_spec: filterViewSpec } as AnalysisContribution

  it('resolves the declared scatter/violin widgets (nested in a group)', () => {
    const viz = availableVisualizations(withView)
    expect(viz.map(v => v.id).sort()).toEqual(['embeddingScatter', 'metricScatter', 'metricViolin'])
    const metric = viz.find(v => v.id === 'metricScatter')!
    expect(metric).toMatchObject({ available: true, source: 'view_spec' })
  })

  it('marks the embedding scatter UNAVAILABLE with a reason when there is no embedding', () => {
    const viz = availableVisualizations(withView) // no data → no vis2D
    const embedding = viz.find(v => v.id === 'embeddingScatter')!
    expect(embedding.available).toBe(false)
    expect(embedding.reason).toBe(needsDataReason(['vis2D']))
  })

  it('marks the embedding scatter AVAILABLE once vis2D is present', () => {
    const viz = availableVisualizations(withView, {}, { vis2D: { x: [], y: [] } })
    const embedding = viz.find(v => v.id === 'embeddingScatter')!
    expect(embedding).toMatchObject({ available: true, reason: undefined })
  })

  it('tolerates an analysis without a view_spec', () => {
    expect(availableVisualizations(filter)).toEqual([])
  })
})

// E6 (DOMAIN_AUDIT) — the precondition must be DECLARED, not sniffed out of a `when`
// expression string. Substring-matching `vis2D` misclassified any expression that merely
// MENTIONED a similarly-named symbol, and no processor could express a non-embedding
// precondition (a raster, a graph, a second table) at all.
describe('availableVisualizations — declared data preconditions (E6)', () => {
  const spec = (widgets: ViewSpec['widgets']): ViewSpec => ({
    id: 'p.view',
    title: 'P',
    permission: 'studies::use',
    state: {},
    widgets,
    actions: [],
  })

  it('a `when` that merely MENTIONS a slice-like symbol is not a precondition', () => {
    const withView = analysis({ id: 'p' })
    const v = {
      ...withView,
      view_spec: spec([
        { kind: 'scatter', id: 's', title: 'S', when: '$state.vis2D_enabled' },
      ]),
    } as AnalysisContribution
    const viz = availableVisualizations(v)
    expect(viz.find(x => x.id === 's')).toMatchObject({ available: true, reason: undefined })
  })

  it('a NON-embedding precondition is expressible and reported in the processor’s own words', () => {
    const withView = analysis({ id: 'p' })
    const v = {
      ...withView,
      view_spec: spec([
        { kind: 'scatter', id: 'raster', title: 'Raster overlay', requires: ['image'] },
      ]),
    } as AnalysisContribution
    const missing = availableVisualizations(v, {}, {})
    expect(missing.find(x => x.id === 'raster')).toMatchObject({
      available: false,
      reason: 'needs image',
    })
    const present = availableVisualizations(v, {}, { image: { affine: [] } })
    expect(present.find(x => x.id === 'raster')).toMatchObject({ available: true, reason: undefined })
  })

  it('a datatype-keyed source declares its precondition the SAME way', () => {
    const a = analysis({ id: 'run.pca', produces: ['embedding'] })
    const registry = { views: [{ id: 'umap', title: 'UMAP', consumes: 'embedding', requires: ['vis2D'] }] }
    expect(availableVisualizations(a, registry, {})).toMatchObject([
      { id: 'umap', available: false, reason: 'needs vis2D' },
    ])
    expect(availableVisualizations(a, registry, { vis2D: {} })).toMatchObject([
      { id: 'umap', available: true },
    ])
  })
})

describe('availableVisualizations — datatype-keyed views (TEST-13b)', () => {
  const analysisWithEmbedding = analysis({
    id: 'run.pca',
    produces: ['single-cell/expression', 'embedding'],
  })
  const registry = {
    views: [
      { id: 'violin-panel', title: 'Violin panel', consumes: 'single-cell/expression' },
      { id: 'umap-scatter', title: 'UMAP', consumes: 'embedding', requires: ['vis2D'] },
      { id: 'unrelated', title: 'Nope', consumes: 'proteomics/xyz' }, // not produced → excluded
      { id: 'qc-report', title: 'QC report', consumes: 'single-cell/expression' },
    ],
  }

  it('advertises only viz whose consumes matches a produced datatype', () => {
    const viz = availableVisualizations(analysisWithEmbedding, registry, undefined)
    expect(viz.map(v => v.id).sort()).toEqual(['qc-report', 'umap-scatter', 'violin-panel'])
    expect(viz.find(v => v.id === 'violin-panel')).toMatchObject({ available: true, source: 'view' })
    expect(viz.find(v => v.id === 'qc-report')).toMatchObject({ available: true, source: 'view' })
  })

  it('an embedding-consuming viz is unavailable-with-reason until vis2D exists', () => {
    const without = availableVisualizations(analysisWithEmbedding, registry, undefined)
    expect(without.find(v => v.id === 'umap-scatter')).toMatchObject({ available: false, reason: needsDataReason(['vis2D']) })
    const withData = availableVisualizations(analysisWithEmbedding, registry, { vis2D: {} })
    expect(withData.find(v => v.id === 'umap-scatter')).toMatchObject({ available: true, reason: undefined })
  })

  it('unions declared + datatype-keyed sources, de-duped by id', () => {
    const withView = { ...analysisWithEmbedding, view_spec: filterViewSpec } as AnalysisContribution
    const viz = availableVisualizations(withView, registry, { vis2D: {} })
    // 3 declared (metricScatter/embeddingScatter/metricViolin) + 3 datatype-keyed.
    expect(viz.map(v => v.id).sort()).toEqual([
      'embeddingScatter',
      'metricScatter',
      'metricViolin',
      'qc-report',
      'umap-scatter',
      'violin-panel',
    ])
  })
})
