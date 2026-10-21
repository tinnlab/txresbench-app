// @vitest-environment jsdom
//
// An `alert` may carry an OPTIONAL action, so a view can guide its own user somewhere.
//
// The split is the design: the SENTENCE is authored (the view owns what its user reads — no host
// can phrase it for every analysis) and the DESTINATION is derived (DEC-6). A view that named
// another package's analysis would break SILENTLY — a dead affordance, not an error — the moment
// a deployment shipped a different producer.
//
// Zero, one and several producers are three different renderings (DEC-7), and an action does not
// turn an alert into a button (DEC-10): it stays informational, with an affordance beside it.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import type { ProducerTarget } from '@/modules/workbench/core/runtime/producerTargets'
import { installWidgets } from '@/modules/workbench/extensions/widgets/installWidgets'
import { WidgetHost } from './WidgetHost'

installWidgets()

const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data: {} }

const alertSpec = (withAction: boolean): WidgetSpec =>
  ({
    id: 'hint',
    kind: 'alert',
    tone: 'info',
    text: 'Nothing to work with yet.',
    ...(withAction ? { action: { launch: 'producer' } } : {}),
  }) as unknown as WidgetSpec

function mount(spec: WidgetSpec, targets: ProducerTarget[], onLaunch?: (id: string) => void): void {
  render(
    <WidgetHost
      spec={spec}
      scope={scope}
      viewId="v"
      specId="t/spec"
      producerTargets={() => targets}
      launchAnalysis={onLaunch}
    />,
  )
}

beforeEach(() => cleanup())

describe('an alert action offers what it derives, and never invents one', () => {
  it('ONE producer → one affordance, labelled with the TARGET’s title', () => {
    mount(alertSpec(true), [{ id: 'p.one', title: 'Compute measurements' }])
    const btn = screen.getByTestId('widget-hint-launch-p.one')
    expect(btn.textContent).toBe('Compute measurements')
    // The authored sentence is still the alert's content — the action is beside it, not instead.
    expect(screen.getByTestId('widget-hint').textContent).toContain('Nothing to work with yet.')
  })

  it('SEVERAL producers → all offered, none chosen for the user', () => {
    mount(alertSpec(true), [
      { id: 'p.one', title: 'First' },
      { id: 'p.two', title: 'Second' },
    ])
    expect(screen.getByTestId('widget-hint-launch-p.one')).toBeTruthy()
    expect(screen.getByTestId('widget-hint-launch-p.two')).toBeTruthy()
  })

  it('ZERO producers → the text alone, with no affordance', () => {
    // A link that goes nowhere is worse than no link, and this is the ordinary state of a
    // deployment whose domain ships no such producer.
    mount(alertSpec(true), [])
    expect(screen.queryByTestId('widget-hint-actions')).toBeNull()
    expect(screen.getByTestId('widget-hint').textContent).toContain('Nothing to work with yet.')
  })

  it('activating an affordance routes through the SAME launch the host owns', () => {
    const launched: string[] = []
    mount(alertSpec(true), [{ id: 'p.one', title: 'First' }], id => launched.push(id))
    ;(screen.getByTestId('widget-hint-launch-p.one') as HTMLButtonElement).click()
    expect(launched).toEqual(['p.one'])
  })

  it('an alert with NO action renders exactly as it always has', () => {
    // The field is additive. Every existing alert — including the ones that predate it — must be
    // untouched, or this became a change to the alert kind rather than an addition to it.
    mount(alertSpec(false), [{ id: 'p.one', title: 'First' }])
    expect(screen.queryByTestId('widget-hint-actions')).toBeNull()
    expect(screen.getByTestId('widget-hint').textContent).toContain('Nothing to work with yet.')
  })

  it('an alert is not a button — the affordance is a child, not the surface', () => {
    // DEC-10. Guidance that IS the primary call to action is a `button`; this stays an
    // informational surface, so the alert itself must not become clickable.
    mount(alertSpec(true), [{ id: 'p.one', title: 'First' }])
    const alert = screen.getByTestId('widget-hint')
    expect(alert.tagName.toLowerCase()).not.toBe('button')
    expect(alert.getAttribute('role')).not.toBe('button')
  })
})
