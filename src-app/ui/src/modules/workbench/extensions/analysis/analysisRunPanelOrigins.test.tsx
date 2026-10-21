// @vitest-environment jsdom
//
// TEST-20 [acceptance] [invariant: INV-5] (ITEM-14) — a re-pick IS the review.
//
// ── The property ────────────────────────────────────────────────────────────────────
//
// INV-5: *"A user write resolves the origin to `user`, whatever it was before. Re-picking
// an auto-bound input is the review, and the record must say so."* The sharp case is the
// one below: the user picks, through the real control, the value the system had already
// put there. The params bag before and after that gesture is IDENTICAL — same key, same
// artifact id — and the run launched after it must nonetheless be recorded differently
// from the run launched before it.
//
// That is why nothing here asserts that the auto-bind works. An auto-bind that works and
// a user pick that works are the same two lines of DOM; the whole subject of this file is
// the fact that distinguishes them, carried from the mount effect, through the form, into
// what `jobs.run` receives.
//
// It also pins the `paramOriginsRef` discipline. The panel's auto-pick effect merges its
// patch onto `paramsRef.current` rather than onto its mount-captured closure — so an
// origin map read from a stale closure would describe params that no longer exist. Here
// the launch reads the origins for a bag that was rewritten twice after mount, so a map
// that lagged its values fails on the second Run.
//
// ── What is faked, and why only that ────────────────────────────────────────────────
//
// The two things a jsdom unit cannot supply: the workbench context and the capability
// backends (and `@/api-client`, which the panel pokes for a job's stop-authority). The
// real panel, the real `SchemaForm`, the real field registry, the real kit control and
// the real `buildInputs` all run — "what the run receives" is read off the capability the
// panel actually called, never inferred from component state.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createCapabilityBroker } from '../../core/capabilities/broker'
import { choosePicker } from '../../core/__testutil__/pickerDriver'
import { identityLattice } from '../../core/datatypes/lattice'
import type { AnalysisContribution } from '@/modules/workbench/core'
import type { RunInput } from '../jobs/contract'

/** ONE candidate — sole candidacy is the precondition of the auto-bind under test. */
const ROWS = [{ id: 'art-1', project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' }]

/** Every `jobs.run` the panel makes, in order — the launches this file reads its verdicts
 *  off. Each entry keeps the inputs exactly as the panel handed them over. */
const launches: RunInput[][] = []

const broker = createCapabilityBroker()
broker.publish('data', '1.0.0', {
  catalog: async () => ({ project_id: 'p1', axes: [], artifacts: ROWS }),
  artifacts: { query: async () => ROWS },
} as never)
broker.publish('jobs', '1.0.0', {
  run: async (_spec: unknown, inputs: RunInput[]) => {
    launches.push(inputs.map(i => ({ ...i })))
    return {
      jobId: `job-${launches.length}`,
      // The fake plane ENDS each run (there is no backend to end it), so the panel
      // leaves its `running` state and the surface is launchable again — the second
      // gesture of this test is a second RUN, not a second click on a busy button.
      onProgress: (cb: (f: { phase: string; message?: string }) => void) => {
        setTimeout(() => cb({ phase: 'failed', message: 'no backend in this unit' }), 0)
        return { dispose() {} }
      },
    }
  },
} as never)

vi.mock('@/api-client', () => ({
  ApiClient: {
    Jobs: {
      get: async () => {
        throw new Error('no backend in this unit')
      },
      logs: async () => ({ logs: [] }),
      stop: async () => ({}),
    },
  },
}))

/** The workbench context, built ONCE. Identity matters: the field picker's fetch effect
 *  keys on the `api` object, so a context rebuilt per render would put the control back
 *  into its loading state on every keystroke — a harness artifact that would make the
 *  gestures below unreachable for reasons that have nothing to do with the subject. */
const CTX = {
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
}

vi.mock('../../core/shell/WorkbenchContext', () => ({ useWorkbench: () => CTX }))

beforeAll(() => {
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
  ;(Element.prototype as { scrollIntoView?: () => void }).scrollIntoView ??= () => {}
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(() => {
  cleanup()
  launches.length = 0
})

const { AnalysisRunPanel, changedFields } = await import("./AnalysisRunPanel")
const { BINDING_ORIGIN_COPY } = await import('@/modules/workbench/core')

/** One slot, DECLARING the auto-bind (DEC-15: absence is OFF, so without this the site
 *  under test never fires). Neutral vocabulary — `matrix` is a lattice root. */
function analysis(): AnalysisContribution {
  return {
    id: 'probe.run',
    extensionId: 'probe',
    apiVersion: '^1.0',
    title: 'Probe run',
    category: 'probe',
    appliesTo: [{ slot: 'frame', subtypes_of: 'matrix', auto_bind_sole_candidate: true }],
    produces: ['probe/summary'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'compute/probe.py' },
  } as AnalysisContribution
}

/** The summary line's entry for the slot — R8's second surface, and the panel's own
 *  report of what it thinks the origin is. */
const summaryTag = (): HTMLElement => screen.getByTestId('workbench-analysis-input-probe.run-frame')
/** The control's own mark. */
const controlMark = (): HTMLElement | null => screen.queryByTestId('schemaform-field-frame-origin-mark')

const clickRun = (): void => {
  fireEvent.click(screen.getByTestId('workbench-analysis-run-probe.run'))
}

describe('TEST-20 [acceptance] [invariant: INV-5] — re-picking an auto-bound input is the review', () => {
  it('reports auto after the mount pick, and user after the SAME value is re-picked', async () => {
    render(<AnalysisRunPanel analysis={analysis()} />)

    // ── 1. the mount effect binds the sole candidate, and the panel SAYS so ──────────
    await waitFor(() => expect(summaryTag().getAttribute('data-binding-origin')).toBe('auto'))
    // Stated in words on both surfaces the reader actually looks at, without a hover.
    expect(summaryTag().textContent).toContain(BINDING_ORIGIN_COPY.autoBoundSummary)
    expect(controlMark()?.textContent).toContain(BINDING_ORIGIN_COPY.autoBound)

    // ── 2. a run launched now carries `auto` into what the job receives ──────────────
    clickRun()
    await waitFor(() => expect(launches).toHaveLength(1))
    expect(launches[0]).toEqual([{ slot: 'frame', artifactId: 'art-1', origin: 'auto' }])

    // ── 3. the user picks THE SAME VALUE, through the real control ───────────────────
    //
    // Driven with the shared picker driver, i.e. the way a user drives it: open the
    // popover, press the row. The params bag does not change across this gesture — same
    // key, same artifact id — which is exactly why anything deriving the origin from the
    // VALUES cannot see it happen, and why this is the case worth testing.
    // What the control DISPLAYS as chosen, before and after — so "the same value" is a
    // MEASURED premise rather than a claim this file makes about itself. (This arm's
    // trigger renders the chosen option's label and carries no id attribute, so the label
    // is what there is to read here; the ID is read at the run level, at the end.)
    const shownBefore = screen.getByTestId('schemaform-field-frame').textContent
    expect(shownBefore).toBeTruthy()
    await choosePicker(screen.getByTestId('schemaform-field-frame'), 'art-1')
    expect(screen.getByTestId('schemaform-field-frame').textContent).toBe(shownBefore)

    // ── 4. …and the panel now reports the input as REVIEWED, everywhere ──────────────
    await waitFor(() => expect(summaryTag().getAttribute('data-binding-origin')).toBe('user'))
    expect(summaryTag().textContent).not.toContain(BINDING_ORIGIN_COPY.autoBoundSummary)
    expect(controlMark()).toBeNull()

    // ── 5. THE acceptance clause: the next launch is recorded differently ────────────
    await waitFor(() =>
      expect(screen.getByTestId('workbench-analysis-run-probe.run').hasAttribute('disabled')).toBe(false),
    )
    clickRun()
    await waitFor(() => expect(launches).toHaveLength(2))
    expect(launches[1]).toEqual([{ slot: 'frame', artifactId: 'art-1', origin: 'user' }])
    // Said as one statement: same slot, same artifact, different record. A build that
    // dropped the origin (or defaulted it) makes these two launches equal, and this is
    // the line that says so.
    expect(launches[1]).not.toEqual(launches[0])
    expect(launches[1][0].artifactId).toBe(launches[0][0].artifactId)
  })

  it('NEGATIVE CONTROL — an analysis that did NOT declare the auto-bind reports nothing', async () => {
    // Without this, everything above is equally satisfied by a panel that marks every
    // binding `auto`. Absence of a declaration means no auto-bind, which means no origin
    // at all — not `user`, and not a mark (INV-4).
    const { auto_bind_sole_candidate: _off, ...bare } = analysis().appliesTo![0]
    render(<AnalysisRunPanel analysis={{ ...analysis(), appliesTo: [bare] } as AnalysisContribution} />)

    await screen.findByTestId('schemaform-field-frame')
    await waitFor(() => expect(summaryTag()).toBeTruthy())
    expect(summaryTag().hasAttribute('data-binding-origin')).toBe(false)
    expect(controlMark()).toBeNull()
    expect(summaryTag().textContent).not.toContain(BINDING_ORIGIN_COPY.autoBoundSummary)
  })
})

// TEST-20 (binding-origin / ITEM-14) — `changedFields`' DIFF arm, which nothing exercised.
//
// The helper unions the field the control NAMED with a diff of the two bags. The named field
// is what the panel's own tests drive, so the diff could have been deleted and every one of
// them stayed green — while the case it exists for went silently wrong: a single `onChange`
// may carry more than the touched field (a dependent picker clearing a now-invalid sibling in
// the same write), and a sibling left holding the origin of a value that is gone is a
// fabricated claim about a binding nobody made.
describe('TEST-20: changedFields covers the named field AND the ones the write moved', () => {
  it('includes a sibling the same write changed, which the control did not name', () => {
    const prev = { a: 'art-1', b: 'art-2' }
    const next = { a: 'art-1', b: undefined }
    // `a` is what the user touched; `b` was cleared as a consequence. Both must resolve to
    // `user` — the gesture is what moved them.
    expect(changedFields(prev, next, 'a').sort()).toEqual(['a', 'b'])
  })

  it('includes the NAMED field even when its value did not move — the review case', () => {
    // Re-picking the value already in a slot produces an identical bag, so no diff can see it.
    // This is the INV-5 gesture, and the union is the only thing that catches it.
    const bag = { a: 'art-1' }
    expect(changedFields(bag, { ...bag }, 'a')).toEqual(['a'])
    // …and with nothing named, an identical bag reports nothing changed — the control that
    // keeps the clause above from being vacuous.
    expect(changedFields(bag, { ...bag })).toEqual([])
  })

  it('sees a field ADDED or REMOVED by the write, not only one whose value differs', () => {
    expect(changedFields({}, { a: 'art-1' })).toEqual(['a'])
    expect(changedFields({ a: 'art-1' }, {})).toEqual(['a'])
  })
})
