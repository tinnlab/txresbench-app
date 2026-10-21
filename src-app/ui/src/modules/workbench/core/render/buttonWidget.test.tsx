// @vitest-environment jsdom
//
// TEST-18 (ITEM-9) — `disabledWhen` is DISABLED-AND-VISIBLE, and `when` is HIDDEN. The two
// must not collapse into each other.
//
// The distinction is load-bearing for exactly one kind of control: the primary action.
// `DeclarativeRegion` records the measured deadlock — a pane whose only surface holds the
// RUN button for the very datatype it declares shows "No data yet. Run the analysis that
// produces its input" with the Run button hidden behind the message telling the user to
// run it. So the assertions below are paired: `disabledWhen` must leave the button in the
// document, and `when` must not — and the disabled button must not DISPATCH, because a
// gate that is only visual is a gate that a synthetic click walks through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { __clearWidgetsForTests } from './registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { WidgetList } from './WidgetHost'

const scope = (state: Record<string, unknown>): Scope => ({
  params: {},
  state,
  derived: {},
  const: {},
  data: {},
})

let seq = 0
/** Register the REAL action the button names, capturing invocations. The action registry
 *  is process-global with no reset seam, so each test mints its own id. */
function captureAction(): { id: string; calls: number } {
  const local = `run${++seq}`
  const box = { id: local, calls: 0 }
  defineAction({
    id: `s1::${local}`,
    title: local,
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async () => {
      box.calls += 1
    },
  })
  return box
}

function mount(spec: WidgetSpec, state: Record<string, unknown>) {
  installBuiltinWidgets()
  return render(<WidgetList specs={[spec]} scope={scope(state)} viewId="v1" specId="s1" />)
}

beforeEach(() => {
  __resetBuiltinWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

describe('button disabledWhen (ITEM-9)', () => {
  it('disabledWhen TRUE → the button is PRESENT and disabled (never hidden)', () => {
    const act = captureAction()
    mount(
      { id: 'run', kind: 'button', label: 'Run analysis', disabledWhen: '$state.blocked', onClick: act.id },
      { blocked: true },
    )
    const btn = screen.getByTestId('widget-run') as HTMLButtonElement
    // Present: the user can see the action exists and where it is.
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Run analysis')
    expect(btn.disabled).toBe(true)
  })

  it('disabledWhen TRUE → clicking does NOT dispatch the action', () => {
    const act = captureAction()
    mount({ id: 'run', kind: 'button', label: 'Run', disabledWhen: '$state.blocked', onClick: act.id }, { blocked: true })
    fireEvent.click(screen.getByTestId('widget-run'))
    expect(act.calls).toBe(0)
  })

  it('disabledWhen FALSE → enabled and dispatching (positive control)', async () => {
    const act = captureAction()
    mount({ id: 'run', kind: 'button', label: 'Run', disabledWhen: '$state.blocked', onClick: act.id }, { blocked: false })
    const btn = screen.getByTestId('widget-run') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await Promise.resolve()
    expect(act.calls).toBe(1)
  })

  it('NO disabledWhen → enabled (the field is additive; existing buttons are untouched)', () => {
    const act = captureAction()
    mount({ id: 'run', kind: 'button', label: 'Run', onClick: act.id }, {})
    expect((screen.getByTestId('widget-run') as HTMLButtonElement).disabled).toBe(false)
  })

  it('`when` HIDES where `disabledWhen` DISABLES — the two are not the same gate', () => {
    const act = captureAction()
    // Same falsy condition, expressed through each gate. `when` removes the button from
    // the document; `disabledWhen` leaves it there, greyed. Collapsing `disabledWhen` onto
    // `when` (or vice versa) turns exactly one of these two assertions red.
    mount({ id: 'hidden', kind: 'button', label: 'Run', when: '$state.ready', onClick: act.id }, { ready: false })
    expect(screen.queryByTestId('widget-hidden')).toBeNull()

    cleanup()
    mount({ id: 'shown', kind: 'button', label: 'Run', disabledWhen: '$state.blocked', onClick: act.id }, { blocked: true })
    expect(screen.queryByTestId('widget-shown')).not.toBeNull()
  })
})
