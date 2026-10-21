// @vitest-environment jsdom
//
// A TAB OWNS ITS CLOSE — WITHOUT OWNING A SECOND FOCUSABLE CONTROL.
//
// ── the finding ─────────────────────────────────────────────────────────────────────────────
// Every region tab is a `role="tab"` element that CONTAINS the close `<button>`. That is axe's
// `nested-interactive` (WCAG 4.1.2): a composite widget's own element must not wrap another
// interactive control, because the two compete for the same activation and the AT has no way to
// present "a tab, and also a button" as one node. `27b19e86` found it with an axe pass over the
// real rendered rail and allow-listed that ONE rule id rather than fix it in that lane.
//
// ── what replaces it, and why THIS shape ────────────────────────────────────────────────────
// The close stays exactly where a mouse user reaches for it (the X on the tab) but leaves the
// a11y + focus tree: it is `aria-hidden` and not focusable, so the tab is once again a single
// node. Closing is then exposed on the TAB itself, through the key every tabbed editor already
// uses for it — `Delete` (and `Backspace`, which is the same intent on a Mac keyboard whose
// `Delete` IS backspace). `aria-keyshortcuts` is what tells AT that, and the hover text on the X
// is what tells a sighted keyboard user.
//
// The alternative — make the tab a `<button>` and put the close beside it — was rejected because
// a `tablist` may only own `tab` children: a sibling button is a NEW `aria-required-children`
// violation, which is the exact rule `27b19e86` had to preserve when it moved these strips onto
// the overlay scroll track.
//
// ── asserted on MEASURED STATE, never on source text or a class string ──────────────────────
// The nested-interactive invariant below is computed from the rendered tree: for every
// `role="tab"`, is there a descendant that the a11y tree would present as interactive? A source
// scan cannot answer that (a component may render whatever it likes), and 27b19e86 had to
// replace exactly this shape of claim once already. The browser-side half — real axe over the
// real rail, with the non-vacuity check that the rule was EVALUATED — is in
// `tests/e2e/14-workbench/region-tab-strip.spec.ts`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RegionShell } from './RegionShell'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
// The production registration (the side-effect import the shell performs at boot).
import '@/modules/workbench/core/shell/dock/panes'

/**
 * Elements the accessibility tree presents as INTERACTIVE — the set axe's `nested-interactive`
 * is about. Native controls, links with an href, anything explicitly given a widget role, and
 * anything placed in the tab order by hand.
 */
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], ' +
  '[role="textbox"], [role="switch"], [role="radio"], [role="combobox"], [role="slider"]'

/** Is `el` hidden from assistive tech by itself or by an ancestor inside `root`? An
 *  `aria-hidden` subtree is not in the a11y tree at all, so nothing in it can nest. */
function hiddenFromAT(el: Element, root: Element): boolean {
  let cur: Element | null = el
  while (cur) {
    if (cur.getAttribute('aria-hidden') === 'true') return true
    if (cur === root) return false
    cur = cur.parentElement
  }
  return false
}

/** Every `role="tab"` in the document that CONTAINS another interactive node — the violation,
 *  measured off the rendered tree rather than claimed about the source. */
function nestedInteractiveTabs(): string[] {
  const out: string[] = []
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const inner = [...tab.querySelectorAll(INTERACTIVE)].filter(el => !hiddenFromAT(el, tab))
    if (inner.length > 0) {
      out.push(
        `${tab.getAttribute('aria-label') ?? tab.getAttribute('data-testid')}: ` +
          inner.map(el => el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '')).join(', '),
      )
    }
  }
  return out
}

let project = ''
let seq = 0

function mountShell() {
  const api = createWorkbenchApi(makeFakeHost({ projectId: project }), `cyto.workbench.tabkeys-${seq}`)
  return render(
    <WorkbenchProvider api={api} projectId={project} viewId={`test-${project}`} canEdit>
      <RegionShell />
    </WorkbenchProvider>,
  )
}

beforeEach(() => {
  project = `wb-tab-keys-${++seq}`
  window.localStorage.clear()
  workbenchDockStore.getState().ensureProject(project)
  workbenchRegionsStore.getState().reconcilePanes(workbenchDockStore.getState().paneIds())
})
afterEach(cleanup)

describe('a region tab is ONE node in the accessibility tree', () => {
  it('no tab in EITHER strip contains another interactive control', () => {
    mountShell()
    // Both shapes must be present or this measures one strip and calls it two: the horizontal
    // bar (centre/bottom) and the vertical rail (left/right) hand-roll their own tab content.
    expect(
      document.querySelectorAll('[data-testid="region-strip-left"] [role="tab"], [data-testid="region-strip-right"] [role="tab"]').length,
      'the default layout renders side-rail tabs to check',
    ).toBeGreaterThan(0)
    expect(
      document.querySelectorAll('[data-testid="region-center"] [role="tab"], [data-testid="region-bottom-wrap"] [role="tab"]').length,
      'the default layout renders horizontal tabs to check',
    ).toBeGreaterThan(0)

    expect(
      nestedInteractiveTabs(),
      'a role="tab" that wraps a focusable control is axe nested-interactive (WCAG 4.1.2)',
    ).toEqual([])
  })

  it('…and the detector is not vacuous: an interactive child IS reported', () => {
    // THE NEGATIVE CONTROL. A scan that matched nothing would read identically to a clean tree.
    mountShell()
    const tab = document.querySelector('[role="tab"]') as HTMLElement
    const planted = document.createElement('button')
    planted.setAttribute('aria-label', 'planted')
    tab.appendChild(planted)
    try {
      expect(nestedInteractiveTabs().join(' | ')).toContain('planted')
    } finally {
      planted.remove()
    }
    expect(nestedInteractiveTabs(), 'the plant was the only offender').toEqual([])
  })
})

describe('a keyboard user can close a tab', () => {
  it('Delete on the FOCUSED tab closes that pane', () => {
    mountShell()
    const ids = workbenchDockStore.getState().paneIds()
    expect(ids.length, 'need ≥2 panes so the close is not blocked by keep-≥1').toBeGreaterThan(1)
    const id = ids[0]
    const tab = screen.getByTestId(`region-tab-${id}`)

    // Reached by keyboard at all: the tab is in the tab order.
    expect(tab.getAttribute('tabindex'), 'a tab must be focusable to receive a key at all').toBe('0')
    act(() => {
      ;(tab as HTMLElement).focus()
    })
    expect(document.activeElement, 'the tab took focus').toBe(tab)

    act(() => {
      fireEvent.keyDown(tab, { key: 'Delete' })
    })
    expect(
      workbenchDockStore.getState().paneIds(),
      'Delete on a focused tab must close its pane — it is the only close a keyboard user has ' +
        'on a horizontal strip, which draws no pane header',
    ).not.toContain(id)
  })

  it('Backspace does the same (a Mac keyboard’s Delete key IS backspace)', () => {
    mountShell()
    const ids = workbenchDockStore.getState().paneIds()
    const id = ids[0]
    const tab = screen.getByTestId(`region-tab-${id}`)
    act(() => {
      fireEvent.keyDown(tab, { key: 'Backspace' })
    })
    expect(workbenchDockStore.getState().paneIds()).not.toContain(id)
  })

  it('announces the shortcut, so it is not a secret', () => {
    mountShell()
    const id = workbenchDockStore.getState().paneIds()[0]
    const tab = screen.getByTestId(`region-tab-${id}`)
    expect(
      tab.getAttribute('aria-keyshortcuts'),
      'a close reachable only by an undocumented key is a close a user does not have',
    ).toBe('Delete')
  })

  it('a BLOCKED close refuses the key too, and says why on the TAB', () => {
    mountShell()
    // Down to the last pane — the dock keeps ≥1, so its close is unavailable.
    act(() => {
      const ids = workbenchDockStore.getState().paneIds()
      for (const id of ids.slice(1)) workbenchDockStore.getState().removePane(id)
    })
    const ids = workbenchDockStore.getState().paneIds()
    expect(ids, 'the dock refuses to drop below one pane').toHaveLength(1)
    act(() => {
      workbenchRegionsStore.getState().reconcilePanes(ids)
    })
    const last = ids[0]
    const tab = screen.getByTestId(`region-tab-${last}`)

    act(() => {
      fireEvent.keyDown(tab, { key: 'Delete' })
    })
    expect(workbenchDockStore.getState().paneIds(), 'the key must not do what the button refuses').toEqual([last])

    // The reason reaches assistive tech from the element the user is ON — the tab. It used to be
    // described only from the close button, which is no longer in the tree.
    const whyId = tab.getAttribute('aria-describedby')
    expect(whyId, 'a tab whose close is blocked must point at the reason').toBeTruthy()
    expect(document.getElementById(whyId as string)?.textContent).toMatch(/last open pane/i)
  })

  it('Enter still ACTIVATES, so the key that closes did not eat the key that selects', () => {
    // The negative control for the keydown handler: adding a close key must not swallow the
    // activation this tab already had.
    mountShell()
    const ids = workbenchDockStore.getState().paneIds()
    const rightTabs = [...document.querySelectorAll('[data-testid="region-strip-right"] [role="tab"]')]
    expect(rightTabs.length, 'need a rail tab to activate').toBeGreaterThan(0)
    const tab = rightTabs[rightTabs.length - 1] as HTMLElement
    const paneId = (tab.getAttribute('data-testid') ?? '').slice('region-tab-'.length)
    act(() => {
      fireEvent.keyDown(tab, { key: 'Enter' })
    })
    expect(workbenchRegionsStore.getState().active.right).toBe(paneId)
    expect(workbenchDockStore.getState().paneIds(), 'Enter must not close anything').toEqual(ids)
  })
})
