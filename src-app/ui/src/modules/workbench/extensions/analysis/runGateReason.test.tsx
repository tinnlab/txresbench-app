// @vitest-environment jsdom
//
// A GATED RUN BUTTON MUST BE REACHABLE, NOT JUST LEGIBLE.
//
// This is the one site in the disabled-tooltip sweep where almost nothing was lost by the dead
// tooltip: `gate.reason` was a `tooltip` on a natively `disabled` button (so it could never
// open), but the SAME sentence is rendered as permanent visible text immediately beside the
// button — which beats hover-only outright. That is why the fix here is not "restore the hover
// text" but something narrower and different in kind.
//
// WHAT WAS ACTUALLY LOST WAS THE KEYBOARD USER. A natively `disabled` button is not a tab stop,
// so tabbing out of the form skipped Run entirely: no landing, no name, no reason, and no
// indication the control exists. `unavailableReason` makes it aria-disabled — focusable,
// hoverable, still refusing the click — and wires the SAME `gate.reason` string into
// `aria-describedby`, so the two channels cannot drift apart.
//
// The inline span is now `aria-hidden`, because the reason is attached to the control; without
// that a screen-reader user hears it twice, once on the button and once loose in the flow. It
// stays VISIBLE, because permanent text beats a tooltip for discovery.
//
// Asserted on the rendered DOM after a real hover — never on a console spy, which base-ui
// dedupes process-wide and which therefore passes for the wrong reason.

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCapabilityBroker } from '../../core/capabilities/broker'
import { identityLattice } from '../../core/datatypes/lattice'
import type { AnalysisContribution } from '@/modules/workbench/core'

const ROWS = [
  { id: 'art-1', project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' },
]

const broker = createCapabilityBroker()
broker.publish('data', '1.0.0', {
  catalog: async () => ({ project_id: 'p1', axes: [], artifacts: ROWS }),
  artifacts: { query: async () => ROWS },
} as never)
const jobsRun = vi.fn()
broker.publish('jobs', '1.0.0', { run: jobsRun } as never)

vi.mock('../../core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({
    api: {
      version: '1.0.0',
      extensionId: 'test',
      registry: { views: { get: () => undefined } },
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

beforeAll(() => {
  // Required by `act` below. `render` is NOT wrapped by hand — Testing Library already wraps
  // it; the extra `await act(async () => render(...))` that was here first deadlocked every
  // case in this file at 5s, which reads exactly like a slow test rather than a nested act.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(cleanup)

const { AnalysisRunPanel } = await import('./AnalysisRunPanel')

/** Requires one artifact input, which nothing pre-fills ⇒ `runGate` refuses with `Select frame`. */
const GATED = {
  id: 'probe.gated',
  extensionId: 'probe',
  apiVersion: '^1.0',
  title: 'Probe gated',
  category: 'probe',
  appliesTo: [{ slot: 'frame', subtypes_of: 'matrix' }],
  produces: ['probe/summary'],
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/probe.py' },
} as AnalysisContribution

/** The NEGATIVE CONTROL for every reason assertion below: same panel, nothing to refuse.
 *  `appliesTo: []` ⇒ `runGate` returns `{disabled:false}` with no `reason` at all. */
const OPEN: AnalysisContribution = {
  id: 'probe.open',
  extensionId: 'probe',
  apiVersion: '^1.0',
  title: 'Probe open',
  category: 'probe',
  appliesTo: [],
  produces: ['probe/summary'],
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/probe.py' },
} as AnalysisContribution

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no element with data-testid="${id}"`)
  return el
}

function mount(): void {
  render(<AnalysisRunPanel analysis={GATED} />)
}

describe('a Run button refused by its input gate', () => {
  it('is a TAB STOP that states its reason, not a control the keyboard skips', async () => {
    mount()
    const run = byTestId(`workbench-analysis-run-${GATED.id}`)
    expect(
      run.hasAttribute('disabled'),
      'a natively disabled Run is skipped by Tab entirely — the user never learns it exists',
    ).toBe(false)
    expect(run.getAttribute('aria-disabled')).toBe('true')
    const ids = (run.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    const described = ids.map(i => document.getElementById(i)?.textContent ?? '').join(' ').trim()
    expect(described, 'the gate reason must be attached to the control it explains').toBe('Select frame')
  })

  /**
   * THE POINTER CHANNEL, asserted as COMPOSITION here rather than by opening the popup — and
   * that weaker oracle is stated rather than hidden, because "the marker is stamped" is exactly
   * the reading that let this whole class ship.
   *
   * What makes it sound HERE is the pairing: a `data-base-ui-tooltip-trigger` was always
   * stamped on the old button too, and the single reason it was a lie is asserted absent one
   * case above (`disabled` is gone). The OPENING half is proven directly, by real hover on real
   * DOM, in three other places on this same prop — `@txresbench/kit`'s `icon-button-tooltip.test.tsx`
   * describe-D, and this repo's `disabledReasonReachable.test.tsx` for the launcher rows, the
   * analyses dock and AddButton.
   *
   * Why not here: measured, a hover on THIS button opens nothing in jsdom while a kit Button
   * carrying byte-identical props — including inside this panel's own `PaneScroll`, mounted
   * alongside this panel — opens on the first try. Re-firing the hover for 2s does not change
   * it, and there is exactly one element with this testid. So it is a property of this panel's
   * module graph under jsdom, not of the control, and asserting it here would pin a fixture.
   */
  it('composes a tooltip that CAN open, on a button that is no longer inert', async () => {
    mount()
    const run = byTestId(`workbench-analysis-run-${GATED.id}`)
    expect(run.hasAttribute('data-base-ui-tooltip-trigger'), 'the reason must be composed as a tooltip').toBe(true)
    expect(
      run.hasAttribute('disabled'),
      'the ONLY thing that ever made that marker a lie was native `disabled`',
    ).toBe(false)
  })

  it('keeps the reason PERMANENTLY VISIBLE, and announces it exactly once', async () => {
    mount()
    const inline = byTestId(`workbench-analysis-run-reason-${GATED.id}`)
    expect(inline.textContent, 'discovery beats hover — the reason stays on screen').toBe('Select frame')
    expect(
      inline.getAttribute('aria-hidden'),
      'the button already carries this string via aria-describedby; twice is noise',
    ).toBe('true')
  })

  it('still refuses the click — aria-disabled is a claim, not an enforcement', async () => {
    mount()
    jobsRun.mockClear()
    fireEvent.click(byTestId(`workbench-analysis-run-${GATED.id}`))
    await new Promise(r => setTimeout(r, 50))
    // Reaching the jobs capability at all would mean the gate had become decorative — which is
    // the specific risk of trading native `disabled` for `aria-disabled`.
    expect(jobsRun, 'a gated Run that still enqueues a job is worse than one that is greyed').not.toHaveBeenCalled()
  })

  it('keeps the NAME saying Run — the reason must not swallow it', async () => {
    mount()
    expect(byTestId(`workbench-analysis-run-${GATED.id}`).getAttribute('aria-label')).toBe('Run')
  })
})

/**
 * THE NEGATIVE CONTROL. Every assertion above says "when the panel refuses, it says why"; on
 * their own they are all satisfied by a panel that attaches a reason UNCONDITIONALLY, which
 * would announce a refusal that is not happening — a control that reads as broken while working.
 * The pair is what pins the channel to the gate.
 *
 * Written when the stepped form was deleted, because that made this panel's own Run the ONLY run
 * trigger on the surface: `unavailableReason={gate.disabled ? gate.reason : undefined}` is now
 * the single place the reason is decided, and a mutation replacing the `undefined` arm with a
 * string survived the whole suite.
 */
describe('a Run button that is NOT refusing', () => {
  it('carries no reason on any channel — nothing to describe, nothing visible, no aria-disabled', () => {
    render(<AnalysisRunPanel analysis={OPEN} />)
    const run = byTestId(`workbench-analysis-run-${OPEN.id}`)
    expect(run.getAttribute('aria-disabled'), 'an unrefused Run is not aria-disabled').not.toBe('true')
    const ids = (run.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    const described = ids
      .map(i => (document.getElementById(i)?.textContent ?? '').trim())
      .filter(Boolean)
      .join(' ')
    expect(described, 'no refusal ⇒ nothing wired into aria-describedby').toBe('')
    expect(
      document.querySelector(`[data-testid="workbench-analysis-run-reason-${OPEN.id}"]`),
      'the visible reason node renders only while the gate is closed',
    ).toBe(null)
  })
})

/**
 * THE STEPPED PATH IS GONE — and this records what replaced the tripwire that watched it.
 *
 * A previous round found that `SteppedForm` / `Stepper` / `CodeForm` rendered for nobody: this
 * panel is the only host of `<SchemaForm>`, it always passes `fallbackParamsFor(analysis)` (a
 * flat `{ fields }` synthesised from `appliesTo`), and `AnalysisContribution.params` — the only
 * channel that could have carried `steps` or a `code-form` — was removed under INV-1. It left a
 * tripwire here that would go red the day a stepped schema reached this panel.
 *
 * The owner's call was to DELETE the wizard, so the tripwire went with it: it asserted
 * `isSteppedSchema(derived) === false` about a predicate that no longer exists, over a shape
 * `ParamsSchema` can no longer even express. There is nothing left for it to detect.
 *
 * What the tripwire's SECOND half was really pinning is not about steps at all — that this panel
 * renders ONE run trigger, its own, unconditionally — and that outlived it, so it is asserted
 * below instead of deleted. It is the same guarantee stated positively.
 */
describe('the panel owns the one run trigger', () => {
  it('renders its own Run button, unconditionally — no second, form-owned submit', () => {
    render(<AnalysisRunPanel analysis={GATED} />)
    expect(document.querySelector(`[data-testid="workbench-analysis-run-${GATED.id}"]`)).not.toBe(null)
    // the wizard's last-step submit (`schemaform-step-submit`) is gone; nothing else submits.
    expect(document.querySelectorAll('button[type="submit"], [data-testid$="-step-submit"]').length).toBe(0)
  })
})
