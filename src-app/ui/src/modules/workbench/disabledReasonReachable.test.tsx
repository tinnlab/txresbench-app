// @vitest-environment jsdom
//
// A CONTROL THAT REFUSES A USER MUST BE ABLE TO SAY WHY — asserted by OPENING the hover text,
// never by reading a prop.
//
// ── The defect these tests were written against ────────────────────────────────────────────
// A natively `disabled` <button> can open NO React tooltip at all. Two independent reasons,
// either sufficient: the kit's `buttonVariants` sets `disabled:pointer-events-none`, and even
// without it a disabled control's mouse events never reach the DOCUMENT ROOT, which is where
// React listens (it delegates there). A document-level listener records ZERO `mouseover` on a
// disabled button, capture and bubble alike.
//
// So `<Button disabled tooltip="Read-only — viewers cannot launch analyses">` shipped a
// sentence no user could ever read — and for these controls that sentence was the ONLY place
// the reason existed. Greyed, unexplained, and silent about it.
//
// ── WHY THE RENDERED DOM AND NOT A CONSOLE SPY ─────────────────────────────────────────────
// The kit warns about this class. Asserting THAT WARNING is the wrong oracle: base-ui and the
// kit's own `inertTooltipsWarned` dedupe process-wide, so a spy in the second test of a file
// passes because an earlier render already consumed the message — it passes for the wrong
// reason, and it passes against unfixed source. (Measured: exactly that test was written
// first, and it was green on the broken tree.)
//
// The oracle here is what a user gets: hover, then look for the text in the document. Red on
// `disabled`, green on `aria-disabled`, and nothing in between can fake it.
//
// ── The remedy pinned here (commit 93167985, `PaneToolbar.blockedAction`) ───────────────────
// `aria-disabled` + no click handler: hoverable AND focusable, so the pointer channel
// (tooltip) and the assistive-tech channel (`aria-describedby` → sr-only node) both carry the
// reason while `aria-label` keeps saying what the control IS.

import { act, type ReactNode } from 'react'
import { vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createWorkbenchApi,
  workbenchRegistry,
  type AnalysisContribution,
} from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import type { WorkbenchPane } from './core/shell/dock/paneModel'
import { LauncherPane } from './extensions/jobs/LauncherPane'
import { BottomAnalysesDock } from './core/shell/BottomAnalysesDock'
import { AddButton } from '@/modules/settings/components/AddButton'

// The launcher drives its rows through `runAction('analysis.launch')`. Spied rather than
// stubbed-away: the question this file has to answer for a VIEWER is not "is the button
// enabled" but "does clicking it actually go somewhere" — an enabled control whose handler
// early-returns is the very defect this branch exists to remove, in its purest form.
const runActionSpy = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true }))
vi.mock('@/core/actions/defineAction', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  runAction: (...a: unknown[]) => runActionSpy(...a),
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no element with data-testid="${id}"`)
  return el
}

/** Hover the way a pointer does, then let the kit's 300ms open delay elapse. */
async function hover(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 700))
  })
}

/** What a SIGHTED user reads on hover. '' when nothing opened — which is the failure. */
const shown = (): string =>
  Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')

async function hoverText(el: Element): Promise<string> {
  await hover(el)
  return shown()
}

/** The reason in the ACCESSIBILITY tree — the channel a pointer user never touches. */
const describedText = (el: Element): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim()

/**
 * The whole contract for one refused control, asserted in the order a user meets it.
 *  1. the reason is READABLE ON HOVER  (the half native `disabled` destroys)
 *  2. the reason is in the A11Y TREE   (the half a pointer user never reaches)
 *  3. the NAME still says what the control IS (the 93167985 rule — a reason must not
 *     swallow the name, or a screen-reader user cannot tell WHICH control refused them)
 *  4. the MECHANISM that makes 1-3 reachable, pinned so no future edit satisfies them
 *     with a construction that puts the control back out of reach.
 */
async function expectRefusalExplains(testid: string, reason: string, name: string): Promise<void> {
  const el = byTestId(testid)
  expect(
    await hoverText(el),
    `${testid}: hovering an unavailable control must show WHY it is unavailable`,
  ).toBe(reason)
  expect(describedText(el), `${testid}: the reason must also reach assistive tech`).toBe(reason)
  expect(el.getAttribute('aria-label'), `${testid}: the reason must not swallow the NAME`).toBe(name)
  expect(el.getAttribute('aria-disabled'), `${testid}: must be marked unavailable`).toBe('true')
  expect(
    el.hasAttribute('disabled'),
    `${testid}: a natively disabled button is pointer-events:none AND out of the tab order`,
  ).toBe(false)
}

/**
 * The same claim with the WORDING removed. A test naming the sentence fails both when the
 * tooltip cannot open AND when someone rephrases it, and those are not the same finding —
 * this one is red ONLY for the mechanism.
 */
async function expectSomethingOpensOnHover(testid: string): Promise<void> {
  expect(
    await hoverText(byTestId(testid)),
    `${testid}: hovering opened NOTHING — a greyed control with no hover text explains itself ` +
      'to nobody, whatever the words would have been',
  ).not.toBe('')
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

/** Two launcher-visible analyses. `needs.input` is gated on a type the project has not
 *  produced, so its row is `needs-type`; `ready.now` has no `appliesTo` and is available. */
const ANALYSES: AnalysisContribution[] = [
  {
    id: 'ready.now',
    extensionId: 'disabled-reason-test',
    apiVersion: '^1.0',
    title: 'Ready now',
    category: 'testing',
    appliesTo: [],
    produces: [],
    run: { kind: 'sandbox', runtime: 'bash', entry: 'run.sh' },
  },
  {
    id: 'needs.input',
    extensionId: 'disabled-reason-test',
    apiVersion: '^1.0',
    title: 'Needs input',
    category: 'testing',
    appliesTo: [{ slot: 'frame', subtypes_of: 'probe/frame' }],
    produces: [],
    run: { kind: 'sandbox', runtime: 'bash', entry: 'run.sh' },
  },
] as AnalysisContribution[]

const PANE = { id: 'pane-launcher', kind: 'launcher' } as unknown as WorkbenchPane

async function mount(node: ReactNode, canEdit: boolean): Promise<void> {
  const projectId = 'disabled-reason'
  const api = createWorkbenchApi(makeFakeHost({ projectId }), 'disabled-reason-test')
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={projectId} viewId="disabled-reason-view" canEdit={canEdit}>
        {node}
      </WorkbenchProvider>,
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('the analysis launcher explains every row it refuses', () => {
  beforeEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.register(a)
  })
  afterEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.remove(a.id)
  })

  it("a viewer's launch row is NOT refused — the row opens a form, and reading is not a write", async () => {
    // THIS TEST PREVIOUSLY CERTIFIED THE DEFECT. It asserted the row said "viewers cannot launch
    // analyses", which read as a well-explained refusal and was in fact a refusal that should
    // never have happened: `analysis.launch` opens the analysis' FORM and enqueues nothing, so
    // there is nothing here for a viewer to be refused. The refusal that IS true — you cannot
    // RUN this — belongs to the Run button inside the form, where `AnalysisRunPanel` already
    // states it, and which this gate stood in front of.
    await mount(<LauncherPane pane={PANE} />, false)
    const el = byTestId('workbench-launcher-row-ready.now')
    expect(el.getAttribute('aria-disabled'), 'a viewer may open an analysis form').toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
  })

  it("a viewer's row still says WHICH analysis it is, in both channels", async () => {
    // Not asserted via hover: this row renders WORDS, so it is not icon-only and the kit gives it
    // no tooltip — correctly, since its name is on screen. (Measured, not assumed: hovering it
    // opens nothing, which is the right answer for a text control and the wrong one for the ⚙
    // beside it, asserted separately below.)
    await mount(<LauncherPane pane={PANE} />, false)
    const el = byTestId('workbench-launcher-row-ready.now')
    expect(el.getAttribute('aria-label')).toBe('Ready now')
    expect((el.textContent ?? '').includes('Ready now')).toBe(true)
  })

  it('NEGATIVE CONTROL — an availability gate still refuses a VIEWER, and still explains itself', async () => {
    // Without this, "the viewer row is not aria-disabled" would pass just as well if the refusal
    // machinery had been removed altogether rather than narrowed to the causes that are real.
    await mount(<LauncherPane pane={PANE} />, false)
    await expectRefusalExplains(
      'workbench-launcher-row-needs.input',
      'Requires probe/frame',
      'Needs input',
    )
  })

  it('a row missing its input says which input', async () => {
    await mount(<LauncherPane pane={PANE} />, true)
    await expectRefusalExplains(
      'workbench-launcher-row-needs.input',
      'Requires probe/frame',
      'Needs input',
    )
  })

  it('an available row is live and its hover text is its plain name', async () => {
    await mount(<LauncherPane pane={PANE} />, true)
    const el = byTestId('workbench-launcher-row-ready.now')
    expect(el.getAttribute('aria-disabled'), 'a usable control is not marked unavailable').toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
  })

  it("a viewer's row click actually LAUNCHES — an enabled control that no-ops explains nothing", async () => {
    // The `canEdit` early-return inside `LauncherPane.launch` was defense-in-depth while the row
    // was refused. With the row now enabled, keeping it would produce a live-looking button that
    // silently does nothing — strictly worse than the greyed one it replaced, and the exact
    // shape of refusal this whole branch is about. Asserted by DRIVING the click, because
    // "the guard was deleted" is a source fact and this is a behaviour.
    await mount(<LauncherPane pane={PANE} />, false)
    runActionSpy.mockClear()
    await act(async () => {
      fireEvent.click(byTestId('workbench-launcher-row-ready.now'))
    })
    expect(runActionSpy).toHaveBeenCalledTimes(1)
    expect(runActionSpy.mock.calls[0]?.[0]).toBe('analysis.launch')
  })

  it('NEGATIVE CONTROL — an availability-refused row still does NOT launch when clicked', async () => {
    await mount(<LauncherPane pane={PANE} />, false)
    runActionSpy.mockClear()
    await act(async () => {
      fireEvent.click(byTestId('workbench-launcher-row-needs.input'))
    })
    expect(runActionSpy).not.toHaveBeenCalled()
  })

  it("a viewer's ⚙ form button is live — INSPECTING an analysis is the whole point of it", async () => {
    // Also previously a test that certified the defect. The button whose entire job is "open
    // this analysis' form for inspection" was refused to precisely the user with the strongest
    // reason to inspect one: someone deciding whether to ask for edit access, who could not read
    // the parameters they would be asking about. The claim justifying it here — that the action
    // framework would refuse the click anyway — was measurably false: `runAction` performs no
    // permission check, and `ActionMeta.permission` documents itself as "never the enforcement
    // point".
    await mount(<LauncherPane pane={PANE} />, false)
    const el = byTestId('workbench-analysis-open-ready.now')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(await hoverText(el), 'and it still says WHICH analysis it opens').toBe('Open Ready now form')
  })

  it('an editor\'s ⚙ form button is live and named after its row', async () => {
    await mount(<LauncherPane pane={PANE} />, true)
    const el = byTestId('workbench-analysis-open-needs.input')
    expect(el.getAttribute('aria-disabled'), 'availability gates LAUNCH, not inspection').toBeNull()
    expect(await hoverText(el)).toBe('Open Needs input form')
  })
})

describe('the analyses dock explains its Add button when there is nothing to add', () => {
  beforeEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.register(a)
  })
  afterEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.remove(a.id)
  })

  it('Add analysis with every analysis already open explains itself', async () => {
    await mount(<BottomAnalysesDock />, true)
    // REACH the blocked state the way a user does — open every analysis in the rail — rather
    // than staging it with a prop. That also proves the rail's own open path still works.
    for (const a of ANALYSES) {
      await act(async () => {
        fireEvent.click(byTestId(`workbench-analysis-open-${a.id}`))
      })
    }
    await expectRefusalExplains(
      'workbench-add-analysis',
      'Every analysis is already open',
      'Add analysis',
    )
  })

  it('Add analysis is live while an analysis remains unopened', async () => {
    await mount(<BottomAnalysesDock />, true)
    const el = byTestId('workbench-add-analysis')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
  })
})

describe('AddButton — the shared list/card add affordance', () => {
  it('opens SOMETHING on hover while unavailable (wording-independent)', async () => {
    render(<AddButton label="Add server" disabledReason="Only an admin can add a server" data-testid="ab" />)
    await expectSomethingOpensOnHover('ab')
  })

  it('states the caller-supplied reason, and keeps its own name', async () => {
    render(<AddButton label="Add server" disabledReason="Only an admin can add a server" data-testid="ab" />)
    await expectRefusalExplains('ab', 'Only an admin can add a server', 'Add server')
  })

  it('is a live control with its plain name when no reason is given', async () => {
    render(<AddButton label="Add server" data-testid="ab" />)
    const el = byTestId('ab')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(await hoverText(el)).toBe('Add server')
  })
})
