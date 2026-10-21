// @vitest-environment jsdom
//
// THE TAB PRIMITIVE'S OWN CONTRACT — the window the shell tests cannot hold.
//
// `regionTabKeyboard.test.tsx` drives the real shell and asserts OUTCOMES (a pane goes / a pane
// stays). That is the right test for the behaviour and the wrong one for the refusal: when a
// close is blocked, the DOCK STORE also refuses (`removePane` keeps ≥1 pane), so "the pane is still
// there" is satisfied whether or not this component refused anything at all. Measured: mutations
// deleting BOTH of this component's blocked guards — the `if (closeBlocked) return` in the key
// handler and the `closeBlocked ? undefined :` on the click — survived the whole shell suite.
//
// What the component OWNS is narrower and is a contract, not an outcome: while `closeBlocked` is
// set it must never CALL `onClose`. Whether its caller's store would also have said no is the
// store's business — and `closePane` already has one path that does NOT consult it (a hosted
// surface's close is DELEGATED to the surface, never routed through `removePane`), so "the store
// will catch it" is not a property this component may assume.
//
// Testing it in isolation is what makes it a primitive: one component, mounted with a spy, is
// the only place the refusal itself is observable.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RegionTab } from './RegionTab'
import type { WorkbenchPane } from '@/modules/workbench/core/shell/dock/paneModel'

const PANE: WorkbenchPane = { id: 'p-1', kind: 'jobs' }
const REASON = 'This is the last open pane.'

function mount(closeBlocked: string | null) {
  const onClose = vi.fn()
  const onActivate = vi.fn()
  render(
    <RegionTab
      pane={PANE}
      isActive={false}
      closeBlocked={closeBlocked}
      onActivate={onActivate}
      onClose={onClose}
      onDragStart={() => {}}
      className="tab"
      closeClassName="close"
    >
      <span>Jobs</span>
    </RegionTab>,
  )
  return { onClose, onActivate, tab: screen.getByTestId('region-tab-p-1'), close: screen.getByTestId('region-tab-close-p-1') }
}

afterEach(cleanup)

describe('RegionTab refuses a blocked close ITSELF', () => {
  it('the close KEY does not reach onClose while blocked', () => {
    const { onClose, tab } = mount(REASON)
    fireEvent.keyDown(tab, { key: 'Delete' })
    fireEvent.keyDown(tab, { key: 'Backspace' })
    expect(onClose, 'a tab whose close is unavailable must not call it').not.toHaveBeenCalled()
  })

  it('the close CLICK does not reach onClose while blocked', () => {
    const { onClose, close } = mount(REASON)
    fireEvent.click(close)
    expect(onClose).not.toHaveBeenCalled()
  })

  // THE NEGATIVE CONTROLS. Without them "never calls onClose" is satisfied by a component that
  // has no working close at all.
  it('…and BOTH routes reach onClose when it is not blocked', () => {
    const { onClose, tab, close } = mount(null)
    fireEvent.keyDown(tab, { key: 'Delete' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(tab, { key: 'Backspace' })
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('activation is untouched by either state — a blocked CLOSE is not a blocked TAB', () => {
    const blocked = mount(REASON)
    fireEvent.keyDown(blocked.tab, { key: 'Enter' })
    fireEvent.click(blocked.tab)
    expect(blocked.onActivate, 'a pane that cannot be closed can still be selected').toHaveBeenCalledTimes(2)
  })

  it('states the reason from the TAB, and only while it is blocked', () => {
    const blocked = mount(REASON)
    const whyId = blocked.tab.getAttribute('aria-describedby')
    expect(whyId).toBeTruthy()
    expect(document.getElementById(whyId as string)?.textContent).toBe(REASON)
    cleanup()
    const live = mount(null)
    expect(live.tab.getAttribute('aria-describedby')).toBeNull()
  })
})
