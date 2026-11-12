// @vitest-environment jsdom
//
// EVERY PANE TITLE CARRIES A CLOSE — and the two cases where "just add the button" is wrong.
//
// The shell used to gate the close twice: the header's X existed only for the `DISMISSABLE` kinds,
// and hosted-surface panes had no close at all (that one is `paneSurfaceHost.test.tsx`, which
// asserts the delegated close closes the SURFACE). What is left here is the other two:
//
//   1. the close EXISTS on every pane the shell titles, derived from the pane REGISTRY rather than
//      from a list this file maintains — the same mechanism that stopped the inset drift returning;
//   2. the ONE case where a pane genuinely cannot be closed — it is the LAST one, because the dock
//      keeps ≥1 pane or the workspace strands with nothing to open anything from — renders the
//      control DISABLED WITH A REASON. Not missing (the user cannot tell an absent control from a
//      surface that has none) and not dead (a control that silently does nothing is worse). This is
//      the `93167985` precedent, applied to a STATE rather than to a kind.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RegionShell } from './RegionShell'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { PANE_KINDS, type PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
// The production registration (the side-effect import the shell performs at boot) — without it
// every kind resolves the registry's seeded fallback and this file would measure the fallback.
import '@/modules/workbench/core/shell/dock/panes'

// A FRESH project per test: the dock store is module-level and survives `cleanup`, so a test that
// closes panes would hand the next one a workspace that is already down to its last pane — and the
// "with panes to spare" control would then measure the state it exists to be distinct from.
let project = ''
let seq = 0

function mountShell() {
  const api = createWorkbenchApi(makeFakeHost({ projectId: project }), 'txr.workbench.pane-close-test')
  return render(
    <WorkbenchProvider api={api} projectId={project} viewId={`test-${project}`} canEdit>
      <RegionShell />
    </WorkbenchProvider>,
  )
}

beforeEach(() => {
  project = `wb-pane-close-${++seq}`
  workbenchDockStore.getState().ensureProject(project)
  workbenchRegionsStore.getState().reconcilePanes(workbenchDockStore.getState().paneIds())
})
afterEach(cleanup)

describe('the close on a pane title', () => {
  it('exists for EVERY pane kind in the registry — on the tab and in the header', () => {
    mountShell()
    // Derived from the registry, never a hand-written list: a kind added tomorrow is covered
    // tomorrow. Each kind is opened into the LEFT region, which is the shape that draws a header
    // (a side region's tab is a 36px rotated indicator, not a legible label).
    const missing: string[] = []
    for (const kind of PANE_KINDS as readonly PaneKind[]) {
      // `requestAddPane` is the shell's own idempotent open: it FOCUSES an existing pane of this
      // kind rather than opening a second, so this yields the open one where there is one and a
      // fresh one otherwise — which is exactly "every kind, however it got here".
      let id: string | undefined
      act(() => {
        id = workbenchDockStore.getState().requestAddPane(kind) || undefined
      })
      if (!id) {
        missing.push(`${kind}: could not be opened at all`)
        continue
      }
      const paneId = id
      act(() => {
        workbenchRegionsStore.getState().moveToRegion(paneId, 'left')
        workbenchRegionsStore.getState().setActive('left', paneId)
      })
      if (!screen.queryByTestId(`region-tab-close-${paneId}`)) missing.push(`${kind}: no tab close`)
      if (!screen.queryByTestId(`pane-header-close-${paneId}`)) missing.push(`${kind}: no header close`)
    }
    expect(
      missing,
      'these pane kinds draw a title with no way to close the pane from it:\n  ' + missing.join('\n  '),
    ).toHaveLength(0)
  })

  // THIS TEST USED TO CERTIFY THE BUG.
  //
  // It asserted the TAB's close was `tagName === 'BUTTON'` with its own `aria-label` —
  // "keyboard-reachable by construction". That construction is exactly axe `nested-interactive`
  // (WCAG 4.1.2): the close sat INSIDE the `role="tab"`, so the composite widget owned a second
  // interactive node and no assistive tech could present the pair as one. The claim the test was
  // really making — a keyboard user can close this pane — is preserved and now asserted where it
  // is true: `regionTabKeyboard.test.tsx` drives `Delete` on the focused TAB and watches the pane
  // go. What is asserted here is the part that belongs to this file: the affordance still EXISTS
  // on every titled pane, and the PANE HEADER's close (which is not inside a tab, and therefore
  // still is a real focusable button) keeps its accessible name.
  it('the header close is a real button with an accessible name that says WHICH pane', () => {
    mountShell()
    const id = workbenchDockStore.getState().paneIds()[0]
    // A header is drawn only by the SIDE regions (a horizontal tab is already a legible label —
    // see `RegionShell`'s "WHERE A PANE'S TITLE LIVES"), so put the pane where one exists.
    act(() => {
      workbenchRegionsStore.getState().moveToRegion(id, 'left')
      workbenchRegionsStore.getState().setActive('left', id)
    })
    const header = screen.getByTestId(`pane-header-close-${id}`)
    expect(header.tagName).toBe('BUTTON')
    expect(header.getAttribute('aria-label')).toMatch(/^Close .+/)
  })

  it('the TAB close is a pointer affordance only — it must not nest inside the tab’s role', () => {
    mountShell()
    const id = workbenchDockStore.getState().paneIds()[0]
    const close = screen.getByTestId(`region-tab-close-${id}`)
    // Out of the accessibility tree (so the tab is ONE node) and out of the tab order (so it is
    // not a focus stop that does nothing). Its action is reachable by key on the tab itself.
    expect(close.getAttribute('aria-hidden')).toBe('true')
    expect(close.hasAttribute('tabindex')).toBe(false)
    expect(close.closest('[role="tab"]'), 'it is still ON the tab, where a mouse reaches for it').not.toBeNull()
  })

  it('the LAST pane says why it cannot be closed, instead of offering a dead button', () => {
    mountShell()
    // Close down to one pane through the STORE (the shell's own path), so the state under test is
    // the real one rather than a fixture.
    act(() => {
      const ids = workbenchDockStore.getState().paneIds()
      for (const id of ids.slice(1)) workbenchDockStore.getState().removePane(id)
    })
    const ids = workbenchDockStore.getState().paneIds()
    expect(ids, 'the dock refuses to drop below one pane').toHaveLength(1)
    const last = ids[0]
    act(() => {
      workbenchRegionsStore.getState().reconcilePanes(ids)
    })

    const close = screen.getByTestId(`region-tab-close-${last}`)
    const tab = screen.getByTestId(`region-tab-${last}`)
    // PRESENT (so the user can see there is a close and find out why it is off) …
    expect(close).toBeTruthy()
    // … UNAVAILABLE — marked, never natively `disabled`. A natively-disabled button lets NO mouse
    // event escape it (measured in Chromium: a document-level listener sees zero), and React
    // delegates at the root, so the hover text carrying the reason could never open. The X is
    // now an `aria-hidden` pointer affordance (see `RegionTab`), so the marker it carries is a
    // data attribute and the ARIA half of the statement lives on the TAB, which is the element
    // the user is on and the one that refuses the key.
    expect(
      close.hasAttribute('data-close-blocked'),
      'the last pane must not offer a close that silently does nothing',
    ).toBe(true)
    // … and it STATES the reason rather than leaving the user to guess. The reason used to be a
    // native `title`; it is now a kit tooltip (hover) PLUS an `aria-describedby` sr-only node
    // (assistive tech), because `title` was the only channel and it is the weakest one — no
    // styling, no keyboard, and nothing at all in the ENABLED state, where this control had no
    // hover affordance whatsoever. jsdom does not run the tooltip's floating layer, so the
    // assertion here is on the DESCRIPTION, which is the half that lives in the DOM; the
    // tooltip half is asserted in the browser by
    // `tests/gallery-e2e/icon-button-tooltips.spec.ts` ("the last pane's blocked close").
    const whyId = tab.getAttribute('aria-describedby')
    expect(whyId, 'a blocked close must point at its reason').toBeTruthy()
    expect(document.getElementById(whyId as string)?.textContent).toMatch(/last open pane/i)
    // The tab's NAME still says which pane it is — the reason must not swallow it.
    expect(tab.getAttribute('aria-label')).toBeTruthy()

    // …and it really is inert: clicking it changes nothing.
    act(() => {
      fireEvent.click(close)
    })
    expect(workbenchDockStore.getState().paneIds()).toEqual([last])
  })

  it('NEGATIVE CONTROL: with panes to spare the same close is enabled and works', () => {
    // Without this, "disabled" could be the permanent state and the test above would pass for a
    // close that never works at all.
    mountShell()
    const before = workbenchDockStore.getState().paneIds()
    expect(before.length, 'need ≥2 panes for this control').toBeGreaterThan(1)
    const id = before[0]
    const close = screen.getByTestId(`region-tab-close-${id}`)
    expect(close.hasAttribute('data-close-blocked')).toBe(false)
    act(() => {
      fireEvent.click(close)
    })
    expect(workbenchDockStore.getState().paneIds()).not.toContain(id)
  })
})
