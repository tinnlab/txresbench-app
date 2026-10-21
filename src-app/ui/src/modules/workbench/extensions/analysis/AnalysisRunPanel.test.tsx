// @vitest-environment jsdom
//
// TEST-12 (unit) [covers: ITEM-4] — the run pane's FALLBACK FORM: one control per
// `appliesTo` slot, and nothing else.
//
// ── Why this file exists ─────────────────────────────────────────────────────────────
//
// ITEM-4 deleted `params` (a whole form schema) from the manifest and replaced the run
// pane's form with one synthesized from `appliesTo` alone
// (`inputEconomy.ts::fallbackParamsFor`). Nothing asserted the result. Measured, the one
// end-to-end spec over this surface asserts that three CONTAINERS are visible — and
// `AnalysisRunPanel` renders the `SchemaForm` and its testid unconditionally, so
// `fallbackParamsFor → { fields: [] }` leaves that spec green over a form holding zero
// controls. The helper itself had no direct test either: it is reached only through
// `artifactRefFields(...)` inside the panel, and every existing case around it drives the
// helpers BESIDE it (`runGate`, `autoPickSoleArtifacts`) against a hand-built fixture.
//
// So the assertions below are on the RENDERED form — `schemaform-fieldrow-<slot>`, the
// per-field wrapper every branch of every field renderer emits — driven through the real
// `AnalysisRunPanel` → real `SchemaForm` → real field registry. Only the two things a
// jsdom unit cannot supply are faked: the workbench context and the `data`/`jobs`
// capability backends.
//
// ── The subject is a fixture analysis, and its vocabulary is NEUTRAL ─────────────────
//
// ITEM-4 is a claim about ANY analysis, so driving a migrated in-tree one would prove only
// that it works. `subtypes_of: matrix` / `tabular` are lattice ROOTS, not domain types.
//
// ── The second clause, and how it differs from the plan's wording ────────────────────
//
// TESTS.md's TEST-12 also said "for an analysis WITH `ui:`, the run pane renders no rival
// form". That is NOT what the shipped code does and it is recorded as such in TESTS.md:
// `analysis.launch` opens a run pane for every analysis, and `AnalysisRunPanel` renders
// the slot-derived form unconditionally. What IS true — and is the property ITEM-4
// actually delivers — is that the run pane has only ONE form source left. The manifest
// can no longer contribute a schema, so a `ui:` list neither adds, removes nor relabels a
// control here; the declarative view is a different pane (INV-3), not a second reading of
// the same declaration. That is asserted below, as an equality between the two cases.

import { describe, expect, it, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createCapabilityBroker } from '../../core/capabilities/broker'
import { identityLattice } from '../../core/datatypes/lattice'
import type { AnalysisContribution } from '@/modules/workbench/core'

/** The catalog rows the faked `data` capability serves. Two of them, so a picker has
 *  something to render and the field never falls into its (Router-dependent) empty CTA. */
const ROWS = [
  { id: 'art-1', project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' },
  { id: 'art-2', project_id: 'p1', datatype: 'tabular', structure: {}, created_at: '2026-08-01T00:00:00Z' },
]

const broker = createCapabilityBroker()
broker.publish('data', '1.0.0', {
  catalog: async () => ({ project_id: 'p1', axes: [], artifacts: ROWS }),
  artifacts: { query: async () => ROWS },
} as never)
broker.publish('jobs', '1.0.0', { run: vi.fn() } as never)

/** The view contributions the faked registry reports as REGISTERED, keyed by ANALYSIS id — a
 *  declarative pane's contribution IS keyed on its analysis (`core/runtime/seam.ts`). Mutable so
 *  one case can drive the DECLARED-but-failed-to-register state, which is a different fact with a
 *  different remedy (see the `registerDeclarativeViews` fail-closed contract). */
const registeredViews = new Map<string, { id: string; title: string }>()

vi.mock('../../core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({
    api: {
      version: '1.0.0',
      extensionId: 'test',
      registry: { views: { get: (id: string) => registeredViews.get(id) } },
      capabilities: broker,
      ui: { notify: vi.fn() },
      storage: {},
      events: {},
    },
    projectId: 'p1',
    viewId: 'v1',
    canEdit: true,
    producedTypeIds: [],
    lattice: identityLattice,
    backendArch: 'x86_64',
    refreshCatalog: vi.fn(),
    catalogEpoch: 0,
  }),
}))

const { AnalysisRunPanel } = await import('./AnalysisRunPanel')

/** A contribution carrying ONLY what INV-1 leaves on the manifest. `over` varies the one
 *  thing under test at a time. */
function analysis(over: Partial<AnalysisContribution> = {}): AnalysisContribution {
  return {
    id: 'probe.run',
    extensionId: 'probe',
    apiVersion: '^1.0',
    title: 'Probe run',
    category: 'probe',
    appliesTo: [
      { slot: 'frame', subtypes_of: 'matrix' },
      { slot: 'refs', subtypes_of: 'tabular', multiple: true },
    ],
    produces: ['probe/summary'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'compute/probe.py' },
    ...over,
  } as AnalysisContribution
}

/** The ids of the field rows the panel actually PAINTED, in document order. */
function renderedFieldIds(): string[] {
  return [...document.querySelectorAll('[data-testid^="schemaform-fieldrow-"]')].map(el =>
    (el.getAttribute('data-testid') as string).replace('schemaform-fieldrow-', ''),
  )
}

afterEach(() => {
  cleanup()
  registeredViews.clear()
})

describe('AnalysisRunPanel fallback form — one control per `appliesTo` slot (TEST-12)', () => {
  it('renders exactly one field per slot, in declaration order, and NOTHING else', () => {
    render(<AnalysisRunPanel analysis={analysis()} />)
    // THE property. `fallbackParamsFor → { fields: [] }` — the mutation the e2e over this
    // surface survives — turns this line red on the first assertion rather than on a detail.
    expect(renderedFieldIds()).toEqual(['frame', 'refs'])
    // The form container is present either way (it renders unconditionally), which is
    // exactly why its presence proves nothing and the rows above are what is asserted.
    expect(screen.getByTestId('workbench-analysis-form-probe.run')).toBeTruthy()
  })

  it('the row set FOLLOWS `appliesTo` — a different declaration renders a different form', () => {
    // Without this, the case above is equally satisfied by a form hardcoded to two rows.
    render(<AnalysisRunPanel analysis={analysis({ appliesTo: [{ slot: 'only', subtypes_of: 'matrix' }] })} />)
    expect(renderedFieldIds()).toEqual(['only'])
  })

  it('an `appliesTo` entry with NO slot contributes no control (a slot IS the wire key)', () => {
    // An unslotted selector is an applicability fact with no input to bind — it gates the
    // launcher, and there is nothing for the form to name.
    render(
      <AnalysisRunPanel
        analysis={analysis({
          appliesTo: [{ subtypes_of: 'matrix' }, { slot: 'frame', subtypes_of: 'matrix' }],
        })}
      />,
    )
    expect(renderedFieldIds()).toEqual(['frame'])
  })

  it('an analysis declaring NO `appliesTo` renders NO controls (the honest empty form)', () => {
    render(<AnalysisRunPanel analysis={analysis({ appliesTo: [] })} />)
    expect(renderedFieldIds()).toEqual([])
  })

  it('the LABEL is the slot name — the manifest carries no presentation to render (INV-1)', () => {
    // `params.fields[].title`/`doc` were where a label used to come from. With `params`
    // gone there is nothing to read, so the slot name is the label — and a processor that
    // wants better than that ships a view, which is the point of ITEM-3.
    render(<AnalysisRunPanel analysis={analysis()} />)
    const row = screen.getByTestId('schemaform-fieldrow-frame')
    expect(row.textContent).toContain('frame')
  })
})

// ── The second clause, made TRUE ────────────────────────────────────────────────────
//
// This block used to assert the OPPOSITE property — that an analysis WITH `ui:` renders the
// SAME slot-derived form as one without ("`ui:` is not a second form source"). That was a
// true statement about the code and a test CERTIFYING the defect: the run pane's form is
// built from `appliesTo` alone, so for a shipped view-backed analysis it offers the manifest
// slot and OMITS the second artifact input the view declares and the compute consumes. Run
// from here dispatched with that input unset, which the compute reads as an empty match set
// rather than an error — a completed run reporting zeros, reachable from the launcher.
// `fallbackParamsFor`'s own doc comment already said the right thing ("An analysis with a
// view renders that view — one pane, one form"); only the panel never branched.
//
// The cases below assert the ABSENCE of that rival, and the control immediately after is what
// makes "absent" mean "GATED" rather than "the panel rendered nothing at all".
describe('AnalysisRunPanel — an analysis that OWNS its form gets no rival here (TEST-12)', () => {
  it('an analysis declaring `ui:` renders NO form, NO Run and NO input controls', () => {
    registeredViews.set('probe.run', { id: 'probe.run', title: 'Probe run' })
    render(<AnalysisRunPanel analysis={analysis({ ui: ['ui/probe.yaml'] })} />)

    // THE property. Not "the form is empty" — the form is not built at all, and neither is
    // the trigger that would launch from it.
    expect(renderedFieldIds()).toEqual([])
    expect(screen.queryByTestId('workbench-analysis-form-probe.run')).toBeNull()
    expect(screen.queryByTestId('workbench-analysis-run-probe.run')).toBeNull()
    // The inputs→produces line reads the same `appliesTo` projection, so it would restate the
    // rival form's (incomplete) input list in words. It goes with it.
    expect(screen.queryByTestId('workbench-analysis-io-probe.run')).toBeNull()
  })

  it('NON-VACUITY CONTROL — the SAME analysis WITHOUT `ui:` still renders its form AND its Run', () => {
    // Without this the case above passes against a panel that renders nothing for anyone —
    // a gate deleted, a context mock that throws, a render that never commits. This repo has
    // shipped exactly that failure (a permission test green with the gate removed, because the
    // page never loaded), so the control is the assertion that carries the meaning.
    render(<AnalysisRunPanel analysis={analysis()} />)
    expect(renderedFieldIds()).toEqual(['frame', 'refs'])
    expect(screen.getByTestId('workbench-analysis-form-probe.run')).toBeTruthy()
    expect(screen.getByTestId('workbench-analysis-run-probe.run')).toBeTruthy()
  })

  it('says WHERE the form is and offers to reveal it — a signpost, not a blank pane', () => {
    registeredViews.set('probe.run', { id: 'probe.run', title: 'Probe run' })
    render(<AnalysisRunPanel analysis={analysis({ ui: ['ui/probe.yaml'] })} />)
    const note = screen.getByTestId('workbench-analysis-own-form-probe.run')
    expect(note.textContent).toContain('Probe run')
    expect(screen.getByTestId('workbench-analysis-reveal-own-form-probe.run')).toBeTruthy()
  })

  it('a DECLARED view that failed to REGISTER offers no run and no dead link (fail-closed)', () => {
    // `registerDeclarativeViews` is fail-closed at the ANALYSIS ("half a form is not a form"),
    // so a `ui:` entry that is missing or unparseable registers NO pane while the analysis
    // itself stays registered. Falling back to the slot-only form there is the same
    // invisible-input failure with an extra step, so the gate keys on the DECLARATION. The
    // reveal affordance keys on the REGISTRATION — pointing at a pane that does not exist
    // would be a lie, and the two states have different remedies.
    render(<AnalysisRunPanel analysis={analysis({ ui: ['ui/probe.yaml'] })} />)
    expect(renderedFieldIds()).toEqual([])
    expect(screen.queryByTestId('workbench-analysis-run-probe.run')).toBeNull()
    expect(screen.queryByTestId('workbench-analysis-reveal-own-form-probe.run')).toBeNull()
    expect(screen.getByTestId('workbench-analysis-own-form-probe.run').textContent).toMatch(
      /could not be loaded/i,
    )
  })

  it('an EMPTY `ui:` list is NOT a view — the fallback form is still the surface', () => {
    // `loadProcessors` skips pane registration for `ui: []`, so such an analysis genuinely has
    // no form of its own and the fallback is the honest (ITEM-4) surface. The predicate is
    // "declares at least one view FILE", never "the key is present".
    render(<AnalysisRunPanel analysis={analysis({ ui: [] })} />)
    expect(renderedFieldIds()).toEqual(['frame', 'refs'])
    expect(screen.getByTestId('workbench-analysis-run-probe.run')).toBeTruthy()
  })
})
