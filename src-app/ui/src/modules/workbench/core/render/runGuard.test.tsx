// @vitest-environment jsdom
//
// The duplicate-run guard, at the surface the user meets it.
//
// Clicking Run used to produce nothing observable until the run finished, so a user could not
// tell a submitted run from a click that did nothing — and the rational response to an
// unresponsive button is to press it again, each press a real duplicate consuming a sandbox
// slot. The guard refuses the ACCIDENTAL second click and nothing else:
//
//   · it engages only while a launch with byte-identical `(inputs, params)` is IN FLIGHT;
//   · it states its reason in the control, because a disabled primary action with no cause
//     reads as broken (DEC-3);
//   · it releases on a terminal phase, so re-running identical inputs stays possible — that is
//     a legitimate act, and a compute is not required to be deterministic;
//   · it lets a CHANGED input launch immediately, because that is a different run.
//
// Driven through the real `WidgetHost` + the real registered renderers, so what is asserted is
// what a user would see rather than a prop passed to a stub.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ViewSpec, WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { registerViewSpecActions } from '@/modules/workbench/core/runtime/interpreter'
import {
  markInFlight,
  __resetInFlightForTests,
} from '@/modules/workbench/core/runtime/inFlightLaunches'
import { launchIdentity } from '@/modules/workbench/core/runtime/launchIdentity'
import { installWidgets } from '@/modules/workbench/extensions/widgets/installWidgets'
import { WidgetHost, RUN_IN_FLIGHT_REASON } from './WidgetHost'

const SPEC_ID = 'guard/spec'
const ANALYSIS = 'an.analysis'

/** A view with one Run button bound to an action that launches `ANALYSIS`. */
const spec = {
  id: SPEC_ID,
  title: 'Guard',
  state: {},
  widgets: [],
  actions: [
    {
      id: 'run',
      title: 'Run',
      body: [{ run_processor: { id: ANALYSIS, inputs: { matrix: '$state.matrix' }, params: { min: '$state.min' } } }],
    },
  ],
} as unknown as ViewSpec

const runButton = { id: 'runBtn', kind: 'button', label: 'Run', onClick: 'run' } as unknown as WidgetSpec

const scopeWith = (matrix: string, min: number): Scope => ({
  params: {},
  state: { matrix, min },
  derived: {},
  const: {},
  data: {},
})

function mount(scope: Scope): void {
  render(<WidgetHost spec={runButton} scope={scope} viewId="v" specId={SPEC_ID} />)
}

// Registered ONCE. `defineAction`'s registry is module-level with no reset, so a second
// `registerViewSpecActions` for the same ids short-circuits — and clearing the launch
// descriptors per test would then leave them cleared for good, with the guard silently inert.
// Only the in-flight set is per-test state.
installWidgets()
registerViewSpecActions(spec)

beforeEach(() => {
  cleanup()
  __resetInFlightForTests()
})

/** The identity the button's action would submit for this scope. */
const identityFor = (matrix: string, min: number): string =>
  launchIdentity(ANALYSIS, { matrix }, { min })

describe('Run is refused only while the IDENTICAL run is in flight', () => {
  it('is enabled, with no reason shown, when nothing is in flight', () => {
    mount(scopeWith('a1', 10))
    expect((screen.getByTestId('widget-runBtn') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('widget-runBtn-blocked')).toBeNull()
  })

  it('is disabled AND says why while that exact run is in flight', () => {
    markInFlight(identityFor('a1', 10))
    mount(scopeWith('a1', 10))
    expect((screen.getByTestId('widget-runBtn') as HTMLButtonElement).disabled).toBe(true)
    // The reason is on screen, not only in a title attribute.
    expect(screen.getByTestId('widget-runBtn-blocked').textContent).toBe(RUN_IN_FLIGHT_REASON)
  })

  it('stays enabled when a DIFFERENT run of the same analysis is in flight', () => {
    // Changing any input makes it a different run, and a different run is not a duplicate.
    markInFlight(identityFor('a1', 10))
    mount(scopeWith('a1', 99))
    expect((screen.getByTestId('widget-runBtn') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('widget-runBtn-blocked')).toBeNull()
  })

  it('re-enables once the run reaches a terminal phase, params unchanged', () => {
    const release = markInFlight(identityFor('a1', 10))
    mount(scopeWith('a1', 10))
    expect((screen.getByTestId('widget-runBtn') as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    release()
    mount(scopeWith('a1', 10))
    expect(
      (screen.getByTestId('widget-runBtn') as HTMLButtonElement).disabled,
      're-running identical inputs is legitimate — the guard is against the accidental second ' +
        'click, and it ends when the run does',
    ).toBe(false)
  })

  it('never blocks a button whose action launches nothing', () => {
    // The negative control. A guard that disabled every button bound to any action would look
    // identical in the case above and be catastrophic everywhere else.
    const plain = { id: 'plainBtn', kind: 'button', label: 'Add', onClick: 'nope' } as unknown as WidgetSpec
    markInFlight(identityFor('a1', 10))
    render(<WidgetHost spec={plain} scope={scopeWith('a1', 10)} viewId="v" specId={SPEC_ID} />)
    expect((screen.getByTestId('widget-plainBtn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a view-declared `disabledWhen` still disables on its own terms', () => {
    // The two gates are independent: the host's guard must not have replaced the view's.
    const gated = {
      id: 'gatedBtn',
      kind: 'button',
      label: 'Run',
      onClick: 'run',
      disabledWhen: '$state.matrix == ""',
    } as unknown as WidgetSpec
    render(<WidgetHost spec={gated} scope={scopeWith('', 10)} viewId="v" specId={SPEC_ID} />)
    expect((screen.getByTestId('widget-gatedBtn') as HTMLButtonElement).disabled).toBe(true)
  })
})
