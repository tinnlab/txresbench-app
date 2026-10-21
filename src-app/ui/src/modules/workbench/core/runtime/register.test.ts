import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Contributions, ViewContribution } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { registerDeclarativeViews } from './register'
import { __resetRegisteredSpecsForTests } from './interpreter'
import { __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { getActionMeta } from '@/core/actions/defineAction'
import { namespaceActionId } from '@/modules/workbench/core/spec/ids'

// ITEM-9/15 registration seam — validate + register an ANALYSIS' declarative view files:
// every file's actions (into defineAction), the widget renderers, and the ONE pane
// `ViewContribution` the analysis becomes (INV-3).

function spec(id: string): ViewSpec {
  return {
    id,
    title: 'Demo step',
    permission: 'jobs::use',
    state: {},
    widgets: [
      { id: 'sc', kind: 'scatter' },
      { id: 'tbl', kind: 'table' },
    ],
    actions: [
      { id: 'go', title: 'Go', permission: 'jobs::use', mutating: true, params: {}, body: [{ set: { x: 1 } }] },
    ],
  }
}

function mockRegistry(): { registry: Contributions; registered: ViewContribution[] } {
  const registered: ViewContribution[] = []
  const registry = { views: { register: (c: ViewContribution) => registered.push(c) } } as unknown as Contributions
  return { registry, registered }
}

beforeEach(() => {
  __resetRegisteredSpecsForTests()
  __resetBuiltinWidgetsForTests()
})

const OPTS = { extensionId: 'demo.step', title: 'Demo step' }
const file = (s: ViewSpec, path = `ui/${s.id}.yaml`) => ({ path, raw: s as unknown })

describe('registerDeclarativeViews (ITEM-9)', () => {
  it('validates, registers the declared actions, and registers ONE contribution', () => {
    const { registry, registered } = mockRegistry()
    const res = registerDeclarativeViews('reg.analysis', [file(spec('reg/one'))], registry, OPTS)
    expect(res.ok).toBe(true)
    // INV-3 — one ANALYSIS, one pane, docked in the control/run region. This registered one
    // contribution per `layout.regions` entry once, then one per view FILE; both put a
    // single analysis on screen as several tabs.
    expect(registered).toHaveLength(1)
    expect(registered.map(c => c.area)).toEqual(['right'])
    expect(res.contributionIds).toEqual(['reg.analysis'])
    // the declared action + the synthesized describe are live in the registry.
    expect(getActionMeta(namespaceActionId('reg/one', 'go'))).toBeTruthy()
    expect(getActionMeta('reg/one::describe')).toBeTruthy()
  })

  it('stacks SEVERAL files into that one contribution, in the order given', () => {
    const { registry, registered } = mockRegistry()
    const res = registerDeclarativeViews(
      'reg.analysis',
      [file(spec('reg/second')), file(spec('reg/first'))],
      registry,
      OPTS,
    )
    expect(res.ok).toBe(true)
    expect(registered).toHaveLength(1)
    const payload = (registered[0].render as { spec: { views: Array<{ view_id: string }> } }).spec
    expect(payload.views.map(v => v.view_id)).toEqual(['reg/second', 'reg/first'])
    // every stacked file's actions are live — a fragment whose verbs were skipped would
    // render controls that silently do nothing.
    expect(getActionMeta(namespaceActionId('reg/first', 'go'))).toBeTruthy()
    expect(getActionMeta(namespaceActionId('reg/second', 'go'))).toBeTruthy()
  })

  it('fail-closed on an invalid view_spec (registers nothing)', () => {
    const { registry, registered } = mockRegistry()
    const bad = { id: 'reg/bad', title: 'x', permission: 'jobs::use', state: {}, widgets: [{ kind: 'not-a-kind' }], actions: [] }
    const res = registerDeclarativeViews('reg.bad', [{ path: 'ui/bad.yaml', raw: bad }], registry, OPTS)
    expect(res.ok).toBe(false)
    expect(res.errors?.length).toBeGreaterThan(0)
    expect(registered).toHaveLength(0)
  })

  it('fail-closed at the ANALYSIS: one bad file drops the WHOLE pane, and its actions', () => {
    const { registry, registered } = mockRegistry()
    const bad = { id: 'reg/bad2', title: 'x', permission: 'jobs::use', state: {}, widgets: [{ kind: 'not-a-kind' }], actions: [] }
    const res = registerDeclarativeViews(
      'reg.half',
      [file(spec('reg/good')), { path: 'ui/bad.yaml', raw: bad }],
      registry,
      OPTS,
    )
    expect(res.ok).toBe(false)
    expect(registered).toHaveLength(0)
    // The error names the FILE the author has to open, not just the analysis.
    expect(res.errors?.some(e => e.path.includes('ui/bad.yaml'))).toBe(true)
    // …and the good half registered NO verbs either: live actions for a pane that never
    // mounts are drivable by the AI while invisible to the human (INV-4).
    expect(getActionMeta(namespaceActionId('reg/good', 'go'))).toBeFalsy()
  })
})

// ── TEST-6 (ITEM-2): a SECTION registers into `registry.sections`, never `registry.views` ──
//
// The whole point of the section kind is the registry it lands in (DEC-1 / INV-12): a slot
// `placeViews` / `reconcileViews` / `viewAutomountGate` / `assertContributableArea` never
// read, so the centre reservation is unreachable from this path by construction. The
// negative half of each assertion below is therefore the load-bearing one.

import { registerDeclarativeSection } from './register'
import type { SectionContribution } from '@/modules/workbench/core'
import type { ProcessorSectionData } from '@/modules/workbench/core/manifest/processorPackage'

function bothRegistry(): {
  registry: Contributions
  views: ViewContribution[]
  sections: SectionContribution[]
} {
  const views: ViewContribution[] = []
  const sections: SectionContribution[] = []
  const registry = {
    views: { register: (c: ViewContribution) => views.push(c) },
    sections: { register: (c: SectionContribution) => sections.push(c) },
  } as unknown as Contributions
  return { registry, views, sections }
}

const SECTION: ProcessorSectionData = {
  id: 'sec.alpha',
  title: 'Alpha',
  pane: 'visualize',
  order: 20,
  collapsed: true,
  applies_to: [{ capabilities: ['plottable-xy'] }],
  ui: ['ui/alpha.yaml'],
}

describe('registerDeclarativeSection (ITEM-2)', () => {
  it('registers into `sections` and NOT into `views`, carrying pane/order/collapsed/appliesTo', () => {
    const { registry, views, sections } = bothRegistry()
    const res = registerDeclarativeSection(
      SECTION,
      [file(spec('sec/a1'), 'ui/alpha.yaml')],
      registry,
      { extensionId: 'viz.pkg' },
    )
    expect(res.ok).toBe(true)
    // the negative half FIRST: nothing reached the view/docking path.
    expect(views).toHaveLength(0)
    expect(sections).toHaveLength(1)
    const s = sections[0]
    expect(res.contributionIds).toEqual(['sec.alpha'])
    expect(s.id).toBe('sec.alpha')
    expect(s.extensionId).toBe('viz.pkg')
    expect(s.pane).toBe('visualize')
    expect(s.order).toBe(20)
    expect(s.collapsed).toBe(true)
    expect(s.appliesTo).toEqual([{ capabilities: ['plottable-xy'] }])
    // A section carries no `area`: there is no field through which `center` could be
    // smuggled, which is what makes INV-12 a property of the TYPE rather than a check.
    expect((s as unknown as Record<string, unknown>).area).toBeUndefined()
    // the parsed stack is on the contribution — one `DeclarativeRegion` per declared file.
    expect(s.views.map(v => v.view_id)).toEqual(['sec/a1'])
    expect(s.ui).toEqual(['ui/alpha.yaml'])
  })

  it('stacks several files in the declared order and namespaces every file\'s actions', () => {
    const { registry, sections } = bothRegistry()
    const res = registerDeclarativeSection(
      { ...SECTION, ui: ['ui/b.yaml', 'ui/a.yaml'] },
      [file(spec('sec/b'), 'ui/b.yaml'), file(spec('sec/a'), 'ui/a.yaml')],
      registry,
      { extensionId: 'viz.pkg' },
    )
    expect(res.ok).toBe(true)
    expect(sections[0].views.map(v => v.view_id)).toEqual(['sec/b', 'sec/a'])
    // `${viewSpecId}::${actionId}` — unchanged from the analysis path (ITEM-2).
    expect(getActionMeta(namespaceActionId('sec/a', 'go'))).toBeTruthy()
    expect(getActionMeta(namespaceActionId('sec/b', 'go'))).toBeTruthy()
  })

  it('fails CLOSED for the section alone: one bad file registers nothing, and no verbs', () => {
    const { registry, sections } = bothRegistry()
    const bad = { id: 'sec/bad', title: 'x', permission: 'jobs::use', state: {}, widgets: [{ kind: 'not-a-kind' }], actions: [] }
    const res = registerDeclarativeSection(
      { ...SECTION, ui: ['ui/good.yaml', 'ui/bad.yaml'] },
      [file(spec('sec/good'), 'ui/good.yaml'), { path: 'ui/bad.yaml', raw: bad }],
      registry,
      { extensionId: 'viz.pkg' },
    )
    expect(res.ok).toBe(false)
    expect(sections).toHaveLength(0)
    expect(res.errors?.some(e => e.path.includes('ui/bad.yaml'))).toBe(true)
    expect(getActionMeta(namespaceActionId('sec/good', 'go'))).toBeFalsy()
  })

  it('refuses to register a section with an EMPTY stack rather than an empty header', () => {
    const { registry, sections } = bothRegistry()
    expect(() =>
      // reached only if a caller hands it zero PARSED views for a declared `ui:` list
      registerDeclarativeSection({ ...SECTION }, [], registry, { extensionId: 'x' }),
    ).not.toThrow()
    expect(sections).toHaveLength(0)
  })
})

// ── TEST-6 (ITEM-2), loader half: sibling isolation + the "no analysis" package ─────────

describe('registerProcessorPackage — sections (ITEM-2)', () => {
  it('registers sections from a package that declares NO analysis at all (ITEM-65)', async () => {
    const { registerProcessorPackage } = await import('./loadProcessors')
    const { registry, views, sections } = bothRegistry()
    const out = registerProcessorPackage(
      {
        manifest: {
          id: 'viz.pkg',
          name: 'viz.pkg',
          version: '0.1.0',
          apiVersion: '^1.0.0',
          contributes: { sections: [SECTION] },
        },
        views: { 'ui/alpha.yaml': spec('pkg/a1') as unknown },
      },
      registry,
    )
    expect(out.errors).toEqual([])
    expect(out.analysisIds).toEqual([])
    expect(out.viewContributionIds).toEqual([])
    expect(out.sectionIds).toEqual(['sec.alpha'])
    expect(views).toHaveLength(0)
    expect(sections).toHaveLength(1)
  })

  it('fail-isolates ONE bad section: its siblings still register, and the error names the file', async () => {
    const { registerProcessorPackage } = await import('./loadProcessors')
    const { registry, sections } = bothRegistry()
    const out = registerProcessorPackage(
      {
        manifest: {
          id: 'viz.pkg',
          name: 'viz.pkg',
          version: '0.1.0',
          apiVersion: '^1.0.0',
          contributes: {
            sections: [
              { ...SECTION, id: 'sec.missing', ui: ['ui/nope.yaml'] },
              { ...SECTION, id: 'sec.ok', ui: ['ui/ok.yaml'] },
            ],
          },
        },
        views: { 'ui/ok.yaml': spec('pkg/ok') as unknown },
      },
      registry,
    )
    expect(sections.map(s => s.id)).toEqual(['sec.ok'])
    expect(out.sectionIds).toEqual(['sec.ok'])
    expect(out.errors.some(e => e.path === 'ui/nope.yaml' && e.message.includes('sec.missing'))).toBe(true)
  })

  it('reports a section declaring NO `ui:` files rather than registering an empty header', async () => {
    const { registerProcessorPackage } = await import('./loadProcessors')
    const { registry, sections } = bothRegistry()
    const out = registerProcessorPackage(
      {
        manifest: {
          id: 'p',
          name: 'p',
          version: '0.1.0',
          apiVersion: '^1.0.0',
          contributes: { sections: [{ id: 'sec.bare', title: 'Bare', pane: 'visualize' }] },
        },
        views: {},
      },
      registry,
    )
    expect(sections).toHaveLength(0)
    expect(out.errors.some(e => e.message.includes('declares no `ui:` files'))).toBe(true)
  })
})
