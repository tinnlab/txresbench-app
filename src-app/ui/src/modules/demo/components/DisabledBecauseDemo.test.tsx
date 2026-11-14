// @vitest-environment jsdom
/**
 * TEST-DM-5 (disabled half) — DisabledBecauseDemo (ITEM-5): demo mode marks
 * the wrapped control disabled with the reason wired through BOTH channels
 * (the title tooltip + the visible inline reason referenced by
 * aria-describedby), desktop and pending mode leave the control untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DisabledBecauseDemo } from './DisabledBecauseDemo'
import { DEMO_DISABLED_REASON } from '../copy'
import { resetDemoMode, seedDemoMode } from '../test-utils/demoSeed'

beforeEach(() => resetDemoMode())
afterEach(() => cleanup())

describe('DisabledBecauseDemo (ITEM-5)', () => {
  it('demo mode: the control is aria-disabled, its title is the reason and aria-describedby points at the visible reason', () => {
    seedDemoMode('demo')
    render(
      <DisabledBecauseDemo>
        <button type="button">Upload</button>
      </DisabledBecauseDemo>,
    )
    const control = screen.getByText('Upload')
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.getAttribute('data-demo-disabled')).toBe('true')
    expect(control.getAttribute('title')).toBe(DEMO_DISABLED_REASON)
    const reason = screen.getByTestId('txr-demo-disabled-reason')
    expect(reason.textContent).toBe(DEMO_DISABLED_REASON)
    expect(control.getAttribute('aria-describedby')).toBe(reason.id)
  })

  it('demo mode: a custom reason wins (the plan\'s per-control reason)', () => {
    seedDemoMode('demo')
    render(
      <DisabledBecauseDemo reason="Only the example data can be used in the demo">
        <button type="button">Change files</button>
      </DisabledBecauseDemo>,
    )
    const control = screen.getByText('Change files')
    expect(control.getAttribute('title')).toBe('Only the example data can be used in the demo')
    expect(screen.getByTestId('txr-demo-disabled-reason').textContent).toBe(
      'Only the example data can be used in the demo',
    )
  })

  it('desktop mode: the control is untouched (no aria-disabled, no reason)', () => {
    seedDemoMode('desktop')
    render(
      <DisabledBecauseDemo>
        <button type="button">Upload</button>
      </DisabledBecauseDemo>,
    )
    const control = screen.getByText('Upload')
    expect(control.getAttribute('aria-disabled')).toBeNull()
    expect(control.getAttribute('data-demo-disabled')).toBeNull()
    expect(control.getAttribute('title')).toBeNull()
    expect(screen.queryByTestId('txr-demo-disabled-reason')).toBeNull()
  })

  it('pending mode: the control is untouched too (no flash)', () => {
    render(
      <DisabledBecauseDemo>
        <button type="button">Upload</button>
      </DisabledBecauseDemo>,
    )
    const control = screen.getByText('Upload')
    expect(control.getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('txr-demo-disabled-reason')).toBeNull()
  })

  it('a fragment falls back to the group wrapper (the same describedby pair on the group)', () => {
    seedDemoMode('demo')
    const { container } = render(
      <DisabledBecauseDemo>
        <span>one</span>
        <span>two</span>
      </DisabledBecauseDemo>,
    )
    expect(container.querySelector('[data-testid="txr-demo-disabled"]')).toBeTruthy()
    const group = container.querySelector('[role="group"]')!
    const reason = screen.getByTestId('txr-demo-disabled-reason')
    expect(group.getAttribute('aria-disabled')).toBe('true')
    expect(group.getAttribute('aria-describedby')).toBe(reason.id)
  })
})
