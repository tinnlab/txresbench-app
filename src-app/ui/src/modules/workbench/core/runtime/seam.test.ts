import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import {
  viewSpecsToContribution,
  isDeclarativeRenderSpec,
  DECLARATIVE_VIEW_AREA,
  type DeclarativeRenderSpec,
} from './seam'

// TEST-14 (ITEM-6, INV-3) — ONE ANALYSIS renders into ONE pane, and the pane's contents are
// its view files' declaration order, each file's widgets in ITS declaration order.
//
// This suite has now been rewritten twice against the same invariant, and the second rewrite
// is the interesting one. The first replaced a REGION FAN (one contribution per populated
// `layout.regions` entry, id `${spec.id}::region::${region}`) with one contribution per SPEC —
// which reads as INV-3 only while an analysis has exactly one `ui:` file. Both shipped
// processors did, so nothing caught it: two files still meant two panes, with the same title,
// each holding a fragment of one form. The pane is keyed on the ANALYSIS now, so the count is
// structural — `viewSpecsToContribution` returns ONE contribution for a LIST of specs.
//
// Each assertion is written so that restoring EITHER older model turns it red: the id is the
// analysis id (not a spec id, not a region alias), the payload is an ORDERED list (not a single
// spec), and a two-file analysis is asserted explicitly rather than implied.

function spec(id = 'view.alpha/interactive', title = 'Filter items'): ViewSpec {
  return {
    id,
    title,
    permission: 'jobs::use',
    state: {},
    widgets: [
      { id: 'qcSections', kind: 'group', children: [] },
      { id: 'countsTable', kind: 'table' },
      { id: 'saveBtn', kind: 'button', label: 'Save' },
      { id: 'notPlaced', kind: 'alert' },
    ],
    actions: [],
  }
}

const WHEN = { has: 'single-cell/expression' } as const
const OPTS = { extensionId: 'cyto.view-alpha', title: 'Alpha analysis', when: WHEN }
const view = (s: ViewSpec) => ({ view_spec: s, view_id: s.id })

describe('view_spec contribution seam (INV-3)', () => {
  it('produces exactly ONE contribution for MANY view files', () => {
    const c = viewSpecsToContribution(
      'alpha.run',
      [view(spec('alpha/first')), view(spec('alpha/second')), view(spec('alpha/third'))],
      OPTS,
    )
    // A single `ViewContribution` is the RETURN TYPE, so "one" is structural rather than a
    // length check — neither the region fan nor the per-file model could satisfy this.
    expect(Array.isArray(c)).toBe(false)
    expect(c.id).toBe('alpha.run')
  })

  it('the contribution id is the ANALYSIS id — not a spec id, not a `::region::` alias', () => {
    const c = viewSpecsToContribution('alpha.run', [view(spec())], OPTS)
    expect(c.id).toBe('alpha.run')
    expect(c.id).not.toBe('view.alpha/interactive')
    expect(c.id).not.toContain('::region::')
  })

  it('stacks the view files TOP TO BOTTOM in declaration order, each with its own view_id', () => {
    const c = viewSpecsToContribution(
      'alpha.run',
      [view(spec('alpha/second')), view(spec('alpha/first'))],
      OPTS,
    )
    const render = (c.render as { spec: DeclarativeRenderSpec }).spec
    expect(isDeclarativeRenderSpec(render)).toBe(true)
    expect(render.analysis_id).toBe('alpha.run')
    // declaration order, NOT sorted — the caller's order is the layout.
    expect(render.views.map(v => v.view_spec.id)).toEqual(['alpha/second', 'alpha/first'])
    // each file keeps its OWN store binding: one `view_id` per file, never one shared id.
    expect(render.views.map(v => v.view_id)).toEqual(['alpha/second', 'alpha/first'])
    expect(new Set(render.views.map(v => v.view_id)).size).toBe(2)
  })

  it('carries NO per-region payload and no single-spec shortcut', () => {
    const c = viewSpecsToContribution('alpha.run', [view(spec())], OPTS)
    const render = (c.render as { spec: DeclarativeRenderSpec }).spec
    // The three fields older models used to slice the pane by. Their ABSENCE is the
    // invariant: a payload that still named a region, a widget-id subset, or ONE spec would
    // mean something is again deciding which of an analysis' declared UI a pane may show.
    expect(render).not.toHaveProperty('region')
    expect(render).not.toHaveProperty('panels')
    expect(render).not.toHaveProperty('view_spec')
  })

  it("the pane renders each file's widgets in DECLARATION ORDER", () => {
    const c = viewSpecsToContribution('alpha.run', [view(spec())], OPTS)
    const render = (c.render as { spec: DeclarativeRenderSpec }).spec
    expect(render.views[0].view_spec.widgets.map(w => (w as { id?: string }).id)).toEqual([
      'qcSections',
      'countsTable',
      'saveBtn',
      'notPlaced',
    ])
  })

  it('an ID-LESS widget still reaches the pane (it was unplaceable under regions)', () => {
    const s: ViewSpec = { ...spec(), widgets: [{ kind: 'alert', text: 'note' }, { id: 'b', kind: 'stat' }] }
    const render = (viewSpecsToContribution('alpha.run', [view(s)], OPTS).render as { spec: DeclarativeRenderSpec }).spec
    expect(render.views[0].view_spec.widgets).toHaveLength(2)
  })

  it('REFUSES an empty view list — a pane with nothing in it is not a pane', () => {
    expect(() => viewSpecsToContribution('alpha.run', [], OPTS)).toThrowError(/alpha\.run/)
  })

  it('docks into the control/run region and carries the gate + the ANALYSIS title', () => {
    const c = viewSpecsToContribution('alpha.run', [view(spec())], OPTS)
    expect(c.area).toBe(DECLARATIVE_VIEW_AREA)
    expect(c.area).toBe('right')
    // Never the reserved canvas region, whatever the spec says.
    expect(c.area).not.toBe('center')
    expect(c.when).toBe(WHEN)
    // The tab reads the ANALYSIS' human title. Under the per-file model it read the FIRST
    // file's title, so a two-file analysis was named after one of its fragments.
    expect(c.title).toBe('Alpha analysis')
  })
})

// The dock AREA is a property of the PANE, and the pane is the analysis'. A stacked file
// therefore cannot carry a placement of its own — two files declaring different areas would
// be a conflict with no answer. `parseViewSpec` refuses the keys outright rather than
// accepting-and-ignoring them, the same posture it takes for `layout`.
describe('a view file may not declare its own placement (INV-3)', () => {
  it.each(['area', 'region'])('parseViewSpec refuses `%s`, naming the key', key => {
    const r = parseViewSpec({ ...spec(), [key]: 'bottom' })
    expect(r.ok).toBe(false)
    expect(r.value).toBeUndefined()
    const messages = (r.errors ?? []).map(e => `${e.path} ${e.message}`).join('\n')
    expect(messages).toContain(`$.${key}`)
  })

  it('positive control: the same spec WITHOUT a placement key parses', () => {
    const r = parseViewSpec(spec())
    expect(r.errors ?? []).toEqual([])
    expect(r.ok).toBe(true)
  })
})

describe('a spec that still declares layout.regions is REFUSED (fail-closed)', () => {
  it('parseViewSpec rejects it, naming the key', () => {
    const legacy = { ...spec(), layout: { regions: { right: ['saveBtn'] } } }
    const r = parseViewSpec(legacy)
    expect(r.ok).toBe(false)
    expect(r.value).toBeUndefined()
    const messages = (r.errors ?? []).map(e => `${e.path} ${e.message}`).join('\n')
    expect(messages).toContain('$.layout')
    expect(messages).toMatch(/layout/i)
  })

  it('an EMPTY layout block is refused too — it is the key, not its contents', () => {
    // The tempting leniency (accept `layout: {}` since it places nothing) would let the
    // key survive in shipped specs and quietly come back populated.
    const r = parseViewSpec({ ...spec(), layout: {} })
    expect(r.ok).toBe(false)
  })

  it('positive control: the same spec WITHOUT layout parses', () => {
    const r = parseViewSpec(spec())
    expect(r.errors ?? []).toEqual([])
    expect(r.ok).toBe(true)
  })
})
