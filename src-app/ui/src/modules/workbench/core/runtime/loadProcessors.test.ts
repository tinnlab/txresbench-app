import { describe, it, expect, beforeEach } from 'vitest'
import type {
  Contributions,
  AnalysisContribution,
  ViewContribution,
  ProcessorPackage,
  ProcessorAnalysisData,
} from '@/modules/workbench/core'
import { WORKBENCH_API_VERSION } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  processorAnalysisToContribution,
  registerProcessorPackage,
  loadProcessors,
  loadRuntimeProcessors,
} from './loadProcessors'
import { isDeclarativeRenderSpec, type DeclarativeRenderSpec } from './seam'
import { __resetRegisteredSpecsForTests } from './interpreter'
import { __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { getActionMeta } from '@/core/actions/defineAction'
import { namespaceActionId } from '@/modules/workbench/core/spec/ids'

// ITEM-3/ITEM-23 — the generic processor-package loader: register an `AnalysisContribution` from
// `manifest.yaml` DATA + a `ui/*.yaml` view_spec, sourced from DATA (never compiled `extension.ts`).

/** A mock `Contributions` capturing both analyses + views registrations. */
function mockRegistry(): {
  registry: Contributions
  analyses: AnalysisContribution[]
  views: ViewContribution[]
} {
  const analyses: AnalysisContribution[] = []
  const views: ViewContribution[] = []
  const registry = {
    analyses: {
      register: (c: AnalysisContribution) => {
        if (analyses.some(a => a.id === c.id)) throw new Error(`duplicate analysis id "${c.id}"`)
        analyses.push(c)
      },
    },
    views: { register: (c: ViewContribution) => views.push(c) },
  } as unknown as Contributions
  return { registry, analyses, views }
}

const ANALYSIS_DATA: ProcessorAnalysisData = {
  id: 'demo.metric',
  category: 'qc',
  title: 'Demo metric',
  description: 'Compute a demo metric',
  appliesTo: [{ slot: 'matrix', subtypes_of: 'single-cell/expression' }],
  produces: ['metadata-column'],
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/demo.py' },
  methodsText: 'Computed $params.name on the matrix.',
}

function viewSpec(id: string): ViewSpec {
  return {
    id,
    title: 'Demo view',
    permission: 'jobs::use',
    state: {},
    widgets: [{ id: 'tbl', kind: 'table' }],
    actions: [{ id: 'go', title: 'Go', permission: 'jobs::use', params: {}, body: [{ set: { x: 1 } }] }],
  }
}

function pkg(over: Partial<ProcessorPackage> & { id?: string; uiPaths?: string[] } = {}): ProcessorPackage {
  const id = over.id ?? 'cyto.demo'
  return {
    manifest: over.manifest ?? {
      id,
      name: 'Demo',
      version: '0.1.0',
      apiVersion: '^1.0',
      contributes: { analyses: [{ ...ANALYSIS_DATA, ui: over.uiPaths ?? [] }] },
    },
    views: over.views ?? {},
  }
}

beforeEach(() => {
  __resetRegisteredSpecsForTests()
  __resetBuiltinWidgetsForTests()
})

describe('processorAnalysisToContribution (ITEM-23)', () => {
  it('projects DATA → a live AnalysisContribution, filling extensionId + apiVersion', () => {
    const c = processorAnalysisToContribution(ANALYSIS_DATA, 'cyto.demo')
    expect(c.id).toBe('demo.metric')
    expect(c.extensionId).toBe('cyto.demo')
    expect(c.apiVersion).toBe(WORKBENCH_API_VERSION)
    expect(c.category).toBe('qc')
    expect(c.produces).toEqual(['metadata-column'])
    expect(c.run).toEqual({ kind: 'sandbox', runtime: 'python', entry: 'compute/demo.py' })
    expect(c.appliesTo).toEqual([{ slot: 'matrix', subtypes_of: 'single-cell/expression' }])
  })

  it('wraps a methodsText TEMPLATE STRING into an interpolating fn (INV-1: no shipped closure)', () => {
    const c = processorAnalysisToContribution(ANALYSIS_DATA, 'cyto.demo')
    expect(typeof c.methodsText).toBe('function')
    expect(c.methodsText?.({ name: 'mito' })).toBe('Computed mito on the matrix.')
  })

  // TEST-32 (ITEM-25 / DEC-3). The inverse of what this test used to assert: it checked
  // that `produces_annotations` SURVIVED the manifest → registry round-trip. That key is
  // gone (an unverified forecast of columns — 8 of 9 of them did not exist on a real
  // CELLxGENE dataset while 64 of its 65 columns went undeclared), and a manifest still
  // carrying it now FAILS TO LOAD rather than being quietly dropped.
  //
  // Loud, not silent: a dropped key leaves an author believing a declaration is in force.
  // The error must name the package AND the key, or the author cannot find it.
  it.each([
    ['accepts', { accepts: [] }],
    ['when', { when: 'has:x' }],
    ['params', { params: { fields: [] } }],
    ['defaults', { defaults: {} }],
    ['produces_annotations', { produces_annotations: [{ name: 'pct_mito', type: 'continuous', axis: 'cells' }] }],
    ['inStandardRecipe', { inStandardRecipe: true }],
    ['recipeOrder', { recipeOrder: 2 }],
    ['run.inputs', { run: { kind: 'sandbox', entry: 'c.py', inputs: { matrix: 'matrix.h5ad' } } }],
    ['schedule.resources', { schedule: { class: 'normal', resources: { cpu: 4 } } }],
  ])('REFUSES a manifest still declaring the removed key %s', (key, extra) => {
    const data = { ...ANALYSIS_DATA, ...extra } as unknown as ProcessorAnalysisData
    expect(() => processorAnalysisToContribution(data, 'cyto.demo')).toThrowError(
      new RegExp(`removed key .*${key.replace('.', '\\.')}`),
    )
  })

  it('accepts a manifest carrying NONE of them (the positive control)', () => {
    expect(() => processorAnalysisToContribution(ANALYSIS_DATA, 'cyto.demo')).not.toThrow()
  })

  it('omits methodsText when the DATA carries none', () => {
    const { methodsText: _m, ...noText } = ANALYSIS_DATA
    const c = processorAnalysisToContribution(noText as ProcessorAnalysisData, 'cyto.demo')
    expect(c.methodsText).toBeUndefined()
  })

  it('carries no ui: as undefined (⇒ the generic fallback form, an explicit state)', () => {
    const c = processorAnalysisToContribution(
      { id: 'x', category: 'qc', title: 'X', appliesTo: [], produces: [], run: { kind: 'builtin', fn: 'noop' } },
      'e',
    )
    expect(c.ui).toBeUndefined()
    expect(c.appliesTo).toEqual([])
  })
})

describe('registerProcessorPackage (ITEM-3/23)', () => {
  it('registers manifest analyses into workbenchRegistry.analyses', () => {
    const { registry, analyses } = mockRegistry()
    const res = registerProcessorPackage(pkg(), registry)
    expect(res.errors).toEqual([])
    expect(analyses.map(a => a.id)).toEqual(['demo.metric'])
    expect(res.analysisIds).toEqual(['demo.metric'])
  })

  it('registers a ui/*.yaml view_spec via registerDeclarativeViews (actions into defineAction)', () => {
    const { registry, views } = mockRegistry()
    const res = registerProcessorPackage(
      pkg({ id: 'cyto.demo1', views: { 'ui/v1.yaml': viewSpec('demo/v1') }, uiPaths: ['ui/v1.yaml'] }),
      registry,
    )
    expect(res.errors).toEqual([])
    // ONE contribution per ANALYSIS (INV-3) — both the region fan and the per-file model
    // are gone. The pane is keyed on the analysis even when it has a single `ui:` file,
    // which is the case that made the per-file model look correct for so long.
    expect(views.length).toBe(1)
    expect(res.viewContributionIds).toEqual(['demo.metric'])
    // …and the FILE still owns its own store/action namespace (`view_id` = its spec id).
    expect(getActionMeta(namespaceActionId('demo/v1', 'go'))).toBeTruthy()
  })

  it('fail-ISOLATES an invalid view_spec into errors (never aborts the package)', () => {
    const { registry, analyses } = mockRegistry()
    const bad = { id: 'demo/bad', title: 'x', permission: 'jobs::use', state: {}, widgets: [{ kind: 'not-a-kind' }], actions: [] }
    const res = registerProcessorPackage(
      pkg({ id: 'cyto.demo2', views: { 'ui/bad.yaml': bad }, uiPaths: ['ui/bad.yaml'] }),
      registry,
    )
    // the analysis still registered; the bad view is an error, not a throw.
    expect(analyses.map(a => a.id)).toEqual(['demo.metric'])
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.errors[0].path).toContain('ui/bad.yaml')
  })

  // INV-3 ACCEPTANCE — "One analysis renders into ONE pane. Multiple UI files stack top to
  // bottom in declaration order."
  //
  // No test registered TWO `ui:` entries for one analysis before this one, which is why the
  // per-SPEC contribution shipped: with one file per analysis the spec-keyed and the
  // analysis-keyed models are indistinguishable. The fixture below is the case that tells
  // them apart, so a regression to one-contribution-per-file turns it red on the FIRST
  // assertion (`views.length`), not on a detail.
  it('an analysis with TWO ui: files registers ONE pane holding both, in DECLARED order', () => {
    const { registry, views } = mockRegistry()
    const res = registerProcessorPackage(
      pkg({
        id: 'cyto.stack',
        uiPaths: ['ui/second.yaml', 'ui/first.yaml'], // declaration order, deliberately NOT alphabetical
        views: { 'ui/first.yaml': viewSpec('stack/first'), 'ui/second.yaml': viewSpec('stack/second') },
      }),
      registry,
    )
    expect(res.errors).toEqual([])
    expect(views.length).toBe(1)
    // The pane is the ANALYSIS's — its id is what a persisted layout keys on, and its tab
    // reads the analysis title rather than one of its fragments'.
    expect(views[0].id).toBe('demo.metric')
    expect(views[0].title).toBe('Demo metric')
    expect(res.viewContributionIds).toEqual(['demo.metric'])
    // …and the pane carries BOTH specs, in the order the manifest listed the files.
    const render = (views[0].render as { spec: DeclarativeRenderSpec }).spec
    expect(isDeclarativeRenderSpec(render)).toBe(true)
    expect(render.views.map(v => v.view_spec.id)).toEqual(['stack/second', 'stack/first'])
    expect(render.views.map(v => v.view_id)).toEqual(['stack/second', 'stack/first'])
    // every stacked spec's actions are live (a fragment that registered no actions would
    // render controls that do nothing).
    expect(getActionMeta(namespaceActionId('stack/first', 'go'))).toBeTruthy()
    expect(getActionMeta(namespaceActionId('stack/second', 'go'))).toBeTruthy()
  })

  it('TWO analyses each declaring their own ui: get ONE pane EACH (no cross-attribution)', () => {
    const { registry, views } = mockRegistry()
    const res = registerProcessorPackage(
      {
        manifest: {
          id: 'cyto.two',
          name: 'Two',
          version: '0.1.0',
          apiVersion: '^1.0',
          contributes: {
            analyses: [
              { ...ANALYSIS_DATA, id: 'two.alpha', title: 'Alpha', ui: ['ui/a.yaml'] },
              { ...ANALYSIS_DATA, id: 'two.beta', title: 'Beta', ui: ['ui/b.yaml'] },
            ],
          },
        },
        views: { 'ui/a.yaml': viewSpec('two/a'), 'ui/b.yaml': viewSpec('two/b') },
      },
      registry,
    )
    expect(res.errors).toEqual([])
    expect(views.map(v => v.id)).toEqual(['two.alpha', 'two.beta'])
    // each pane holds ONLY its own analysis' file — the flattened `flatMap(a => a.ui)` this
    // replaces could not tell them apart.
    for (const [i, want] of [['two/a'], ['two/b']].entries()) {
      const render = (views[i].render as { spec: DeclarativeRenderSpec }).spec
      expect(render.views.map(v => v.view_spec.id)).toEqual(want)
    }
  })

  it('a partially-invalid ui: list registers NO pane for that analysis (fail-CLOSED, half a form is not a form)', () => {
    const { registry, views, analyses } = mockRegistry()
    const bad = { id: 'stack/bad', title: 'x', permission: 'jobs::use', state: {}, widgets: [{ kind: 'not-a-kind' }], actions: [] }
    const res = registerProcessorPackage(
      pkg({
        id: 'cyto.halfbad',
        uiPaths: ['ui/ok.yaml', 'ui/bad.yaml'],
        views: { 'ui/ok.yaml': viewSpec('stack/ok'), 'ui/bad.yaml': bad },
      }),
      registry,
    )
    expect(analyses.map(a => a.id)).toEqual(['demo.metric']) // the analysis still registers
    expect(views).toEqual([]) // …but its PANE does not: it would be missing a declared half
    expect(res.errors.some(e => e.path.includes('ui/bad.yaml'))).toBe(true)
  })

  it('is a no-op on a backend-shaped manifest with no contributes.analyses (Slice-1 additive safety)', () => {
    const { registry, analyses, views } = mockRegistry()
    const res = registerProcessorPackage(
      { manifest: { id: 'legacy', name: 'L', version: '1', apiVersion: '^1.0' }, views: {} },
      registry,
    )
    expect(analyses).toEqual([])
    expect(views).toEqual([])
    expect(res.errors).toEqual([])
  })
})

describe('loadProcessors (ITEM-3)', () => {
  it('registers every package, topo-sorted by manifest dependencies', () => {
    const { registry, analyses } = mockRegistry()
    const base: ProcessorPackage = {
      manifest: { id: 'a', name: 'A', version: '1', apiVersion: '^1.0', contributes: { analyses: [{ ...ANALYSIS_DATA, id: 'a.metric' }] } },
      views: {},
    }
    const dependent: ProcessorPackage = {
      manifest: { id: 'b', name: 'B', version: '1', apiVersion: '^1.0', dependencies: ['a'], contributes: { analyses: [{ ...ANALYSIS_DATA, id: 'b.metric' }] } },
      views: {},
    }
    // pass dependent FIRST; topo-sort must still register `a` before `b`.
    const res = loadProcessors([dependent, base], registry)
    expect(res.errors).toEqual([])
    expect(analyses.map(a => a.id)).toEqual(['a.metric', 'b.metric'])
  })

  it('collects a dependency-cycle as an error (never throws)', () => {
    const { registry } = mockRegistry()
    const cyc1: ProcessorPackage = { manifest: { id: 'x', name: 'X', version: '1', apiVersion: '^1.0', dependencies: ['y'] }, views: {} }
    const cyc2: ProcessorPackage = { manifest: { id: 'y', name: 'Y', version: '1', apiVersion: '^1.0', dependencies: ['x'] }, views: {} }
    const res = loadProcessors([cyc1, cyc2], registry)
    expect(res.errors.some(e => e.path === 'topo-sort')).toBe(true)
  })

  it('skips a package with no manifest id', () => {
    const { registry } = mockRegistry()
    const res = loadProcessors([{ manifest: undefined as never, views: {} }], registry)
    expect(res.analysisIds).toEqual([])
    expect(res.errors).toEqual([])
  })
})

// H2 — the RUNTIME view-spec load leg: a package DROPPED at runtime (served by
// `GET /api/processors/packages`, decoded by `fetchRuntimeProcessorPackages`) has its
// declarative view registered with ZERO rebuild, and one already loaded by the build-time
// glob (`skipIds`) is NOT re-registered.
describe('loadRuntimeProcessors (H2 — runtime-dropped view-spec render)', () => {
  it('registers a runtime-dropped package NOT in the baked set', async () => {
    const { registry, analyses, views } = mockRegistry()
    // The manifest must NAME the view file: view registration walks the analyses' `ui:`
    // lists, which replaced the `ui/*.yaml` GLOB. A package that merely CARRIES a view file
    // no analysis declares registers nothing — correctly, and this fixture was relying on
    // the retired scan.
    const dropped = pkg({
      id: 'dropin.widget',
      uiPaths: ['ui/v.yaml'],
      views: { 'ui/v.yaml': viewSpec('dropin.widget.view') },
    })
    const res = await loadRuntimeProcessors(registry, new Set(), async () => [dropped])
    expect(res.errors).toEqual([])
    // its analysis + its declarative view both registered (renders at runtime).
    expect(analyses.map(a => a.extensionId)).toContain('dropin.widget')
    expect(views.length).toBeGreaterThan(0)
    expect(res.viewContributionIds.length).toBeGreaterThan(0)
  })

  it('does NOT re-register a package already loaded by the build-time glob (skipIds)', async () => {
    const { registry, analyses } = mockRegistry()
    const baked = pkg({ id: 'qc' })
    const res = await loadRuntimeProcessors(registry, new Set(['qc']), async () => [baked])
    expect(res.analysisIds).toEqual([])
    expect(analyses).toEqual([])
  })

  it('swallows a runtime fetch failure (the baked baseline already rendered)', async () => {
    const { registry } = mockRegistry()
    const res = await loadRuntimeProcessors(registry, new Set(), async () => {
      throw new Error('offline')
    })
    expect(res.errors).toEqual([])
    expect(res.viewContributionIds).toEqual([])
  })
})
