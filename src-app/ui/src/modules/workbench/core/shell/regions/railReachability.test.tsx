// @vitest-environment jsdom
//
// The side-region rail must keep its "Add a pane" control REACHABLE, however many panes are open.
//
// The defect this pins was found by a real-compute e2e and is worth stating exactly, because the
// symptom points away from the cause. The rail is a vertical column: a `role="tablist"` of pane
// tabs, then fixed-height pop-out and collapse buttons. The tabs carry VERTICAL text, so a pane
// with a long title is TALL — two panes overflow a normal-height rail. The tablist had
// `min-h-0 flex-1` but no `overflow`, and the add-pane trigger lived INSIDE it, so the list simply
// grew past its track and the trigger was laid out on top of the fixed controls below it. What
// Playwright reported was:
//
//     waiting for element to be visible, enabled and stable
//       - element is visible, enabled and stable
//       - <button aria-label="Open <pane title> in a window"> subtree intercepts pointer events
//
// i.e. the control was visible, enabled, stable — and unclickable, because a sibling was painted
// over it. A user meets that as "the + button does nothing".
//
// Two structural invariants, asserted on the RENDERED tree rather than on the source:
//   1. the trigger is NOT inside the scrolling tab list — so it cannot scroll out of reach;
//   2. it is still inside the rail — so (1) cannot be satisfied by deleting it.
//
// jsdom does no layout, so the overlap itself is not observable here; the CONTAINMENT that caused
// it is, and it is what a future edit would have to undo to reintroduce the bug.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { workbenchDockStore } from '../dock/WorkbenchDock.store'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { RegionShell } from './RegionShell'

const PROJECT = 'p-rail-reachability'

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('the side rail keeps "add a pane" reachable', () => {
  // The shipped default IA is enough: both invariants are about STRUCTURE (what contains what),
  // and they must hold at every pane count — the overflow that exposed the bug is just the state
  // in which a user notices. Seeding a crowded layout would only add a fixture to maintain.
  const openShell = () => {
    workbenchDockStore.getState().ensureProject(PROJECT)
    render(<RegionShell />)
  }

  it('the trigger is a SIBLING of the tab list, never a child of it', () => {
    openShell()
    const add = screen.queryByTestId('region-add-pane-right')
    expect(add, 'the right rail offers an add-pane control').not.toBeNull()

    const tablist = add!.closest('[data-testid^="region-strip-"]')?.querySelector('[role="tablist"]')
    expect(tablist, 'the rail renders a tab list').not.toBeNull()

    // The invariant. Inside the list, the affordance for opening one more pane is the first
    // thing to scroll away once enough panes exist to need it — and, before it scrolls, it
    // overflows onto the controls below and becomes unclickable.
    expect(
      tablist!.contains(add!),
      'the add-pane trigger is inside the scrolling tab list, where it can overflow onto the ' +
        'fixed controls below it and be intercepted',
    ).toBe(false)
  })

  it('…and is still part of the rail — the invariant is not satisfied by removing it', () => {
    openShell()
    const add = screen.getByTestId('region-add-pane-right')
    const strip = add.closest('[data-testid^="region-strip-"]')
    expect(strip, 'the trigger still lives in the region rail').not.toBeNull()
  })

  it('the tab list can SCROLL rather than push its siblings', () => {
    openShell()
    const strip = screen.getByTestId('region-add-pane-right').closest('[data-testid^="region-strip-"]')
    const tablist = strip!.querySelector('[role="tablist"]') as HTMLElement
    // A list that neither scrolls nor shrinks resumes overflowing onto whatever follows it,
    // which is the same defect with the trigger merely moved out of the way.
    //
    // The CLAIM is unchanged; its SUBJECT moved. The rail's track used to be the tablist itself
    // (a native `overflow-y-auto` on it), which is why this used to read the tablist's class
    // string. The track is now the kit `ScrollArea` that WRAPS the tablist, so the assertion is
    // on containment — the state — rather than on the spelling of a utility class, which a
    // restyle can change without changing whether anything scrolls.
    const track = tablist.closest('[data-testid="region-tabs-scroll-right"]')
    expect(track, 'the tab list must sit on a scroll track (vertical tab text is tall)').not.toBeNull()
    expect(
      track!.hasAttribute('data-overlayscrollbars-initialize'),
      'that track must be a real scroller, not a plain div wearing the testid',
    ).toBe(true)
  })

  // …AND THE TRACK MUST NOT HAVE EATEN THE COMPOSITE ROLE.
  //
  // This is the reason the two tab strips were left on native overflow when everything else moved
  // to the kit track (74d7ed9c): overlayscrollbars renders `host > [data-overlayscrollbars-contents]
  // > children`, so a `role="tablist"` turned INTO the host gets a plain div between it and its
  // `role="tab"` children and axe's `aria-required-children` fails. Wrapping is safe, converting is
  // not, and nothing in the source distinguishes them — so the relation is asserted on the tree.
  // (The rendered-page half of this is the axe run in `tests/e2e/14-workbench/region-tab-strip.spec.ts`;
  // jsdom does no layout and cannot see the bar, but it can see the parentage.)
  it('every tablist still DIRECTLY parents its tabs', () => {
    openShell()
    const lists = [...document.querySelectorAll('[role="tablist"]')]
    expect(lists.length, 'the shell renders tab lists to check').toBeGreaterThan(0)
    for (const list of lists) {
      expect(
        list.hasAttribute('data-overlayscrollbars-initialize'),
        'a tablist must WRAP in the scroll track, never BE it',
      ).toBe(false)
      const tabs = [...list.querySelectorAll('[role="tab"]')]
      expect(tabs.length, 'the list holds tabs').toBeGreaterThan(0)
      for (const tab of tabs) {
        expect(
          tab.parentElement,
          `tab "${tab.getAttribute('aria-label')}" must be a DIRECT child of its tablist`,
        ).toBe(list)
      }
    }
  })
})

// ── adding a pane must FOCUS it ─────────────────────────────────────────────────────────────
//
// A region renders only its ACTIVE pane's body, so a pane that is added without being activated
// is added invisibly: the tab appears and nothing else changes. The user clicked a menu item
// naming the thing they wanted to see, and the surface they were already looking at stays put.
describe('adding a pane through the "+" menu focuses it', () => {
  it('the newly added pane becomes the active tab of its region', async () => {
    workbenchDockStore.getState().ensureProject(PROJECT)
    render(<RegionShell />)

    const trigger = screen.getByTestId('region-add-pane-right')
    trigger.click()

    const item = await screen.findByTestId('region-add-pane-item-artifacts')
    item.click()

    // The assertion the e2e could only make through a rendered body: the added pane is the one
    // the region is showing. Scoped to the RIGHT rail — the other regions have their own
    // selected tab, and a document-wide query would answer about whichever came first.
    await screen.findByLabelText('Artifacts')
    const rightRail = document.querySelector('[data-testid="region-strip-right"]')
    const selected = rightRail?.querySelector('[role="tab"][aria-selected="true"]')
    expect(
      selected?.getAttribute('aria-label'),
      'the region shows the pane the user just added, not the one they were already on',
    ).toBe('Artifacts')
  })
})

// ── docking must not steal focus ────────────────────────────────────────────────────────────
//
// `paneReconcile` re-asserts the DECLARED region for every mounted view pane, and it re-runs
// whenever the pane map changes. It used to do that with `moveToRegion`, which focuses what it
// moves — so walking the view list handed the region's active slot to whichever view came last,
// every time ANY pane was opened. Two user-visible consequences, one bug:
//
//   · open a pane by name → it appears as a tab and something else is on screen;
//   · select a tab, then open anything at all → your selection is gone.
//
// The store now separates the two intents. This pins that separation at the STORE level — the
// reusable invariant, and the thing a future caller has to reach past to reintroduce the steal.
// It deliberately does NOT assert which variant `paneReconcile` calls: that is wiring, it is
// covered by the real-compute journey in the declarative-view e2e directory, which opens
// a pane by name after a run and asserts its body renders), and a source-shaped assertion here
// would guard the spelling instead of the behaviour.
describe('dockToRegion places a pane without changing what is on screen', () => {
  it('re-asserting a region leaves the active tab alone', () => {
    const rs = workbenchRegionsStore.getState()
    rs.moveToRegion('pane-a', 'right')
    rs.moveToRegion('pane-b', 'right')
    // `pane-b` moved last, so it holds focus — a MOVE is a user act and focuses.
    expect(workbenchRegionsStore.getState().active.right).toBe('pane-b')

    // The user then selects `pane-a`.
    workbenchRegionsStore.getState().setActive('right', 'pane-a')
    expect(workbenchRegionsStore.getState().active.right).toBe('pane-a')

    // Reconciliation re-asserts where every view pane belongs. Nothing about what the user is
    // looking at has changed, so nothing about it may change.
    workbenchRegionsStore.getState().dockToRegion('pane-a', 'right')
    workbenchRegionsStore.getState().dockToRegion('pane-b', 'right')
    expect(
      workbenchRegionsStore.getState().active.right,
      're-asserting a pane’s region took the region away from the pane the user selected',
    ).toBe('pane-a')
  })

  it('still docks a pane that is not yet in the region', () => {
    // The negative control: a no-focus dock must still DOCK, or the reconciliation silently
    // stops placing panes and they pile into their default region.
    workbenchRegionsStore.getState().dockToRegion('pane-c', 'bottom')
    expect(workbenchRegionsStore.getState().regionOverride['pane-c']).toBe('bottom')
  })
})
