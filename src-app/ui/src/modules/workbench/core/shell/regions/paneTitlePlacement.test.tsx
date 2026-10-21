// @vitest-environment jsdom
//
// A pane's title renders EXACTLY ONCE, and where it renders depends on the region's tab shape.
//
// Both halves of this were reported from the running app, and they are the same mistake seen from
// two sides. The header used to be keyed on the pane KIND — only the transient, action-created
// kinds got one — which meant:
//
//   · on the BOTTOM, a transient pane printed its title on the tab AND again in a header directly
//     beneath it: "we see the title of the pane twice";
//   · on the LEFT and RIGHT, the durable panes (datasets, visualize, provenance, jobs, analyses,
//     artifacts) got no header at all, and a side tab is a 36px activity-bar strip with the title
//     rotated into vertical writing mode — an indicator, not a legible label. So those panes,
//     which is where they mostly live, had no readable title anywhere.
//
// The rule is therefore about the REGION, not the pane: a horizontal strip already shows a legible
// title on its tab, a side strip does not. These tests assert the rendered tree, at the shipped
// default IA, so a future edit that re-keys the header on kind fails here rather than in the app.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup, within, act } from '@testing-library/react'
import { workbenchDockStore } from '../dock/WorkbenchDock.store'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { RegionShell } from './RegionShell'

const PROJECT = 'p-pane-title-placement'

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
})

/** The active pane of a region, via the body its renderer is mounted into. */
function activePaneId(region: string): string | undefined {
  const el = screen.getByTestId(`region-${region}`)
  const body = el.querySelector('[data-testid^="region-pane-body-"]')
  return body?.getAttribute('data-testid')?.replace('region-pane-body-', '')
}

describe('a pane title renders once, in the place its region can show it', () => {
  const openShell = () => {
    workbenchDockStore.getState().ensureProject(PROJECT)
    render(<RegionShell />)
  }

  /** The shipped default IA puts nothing in the BOTTOM region, so the duplicated-title report is
   *  only reachable once a pane is moved there — which is exactly the gesture the user made. */
  const openShellWithBottomPane = () => {
    workbenchDockStore.getState().ensureProject(PROJECT)
    render(<RegionShell />)
    const moved = screen.getByTestId('region-left').querySelector('[data-testid^="region-pane-body-"]')
    const id = moved!.getAttribute('data-testid')!.replace('region-pane-body-', '')
    act(() => workbenchRegionsStore.getState().moveToRegion(id, 'bottom'))
    return id
  }

  it('a SIDE region titles its pane in a header — the rotated tab is not a legible label', () => {
    openShell()
    for (const region of ['left', 'right']) {
      const id = activePaneId(region)
      expect(id, `the ${region} region has an active pane to title`).toBeTruthy()
      const header = screen.queryByTestId(`pane-header-${id}`)
      expect(
        header,
        `the ${region} region's pane carries no header, so its title exists only as vertical ` +
          `text on a 36px tab — this is the "I don't see it for datasets, visualize, provenance, ` +
          `jobs, analyses, artifacts" report`,
      ).not.toBeNull()
      expect(header!.textContent?.trim(), 'the header states the pane title').toBeTruthy()
    }
  })

  it('a HORIZONTAL region does NOT — its tab already shows the title', () => {
    const id = openShellWithBottomPane()
    expect(
      screen.queryByTestId(`pane-header-${id}`),
      'the bottom pane carries a header as well as a tab, so the title is on screen twice',
    ).toBeNull()
  })

  it('and the bottom title is on screen ONCE — the non-vacuity control', () => {
    // Without this, the test above passes for a region that renders no title at all, which is
    // the opposite defect and exactly what the side regions were suffering from.
    const id = openShellWithBottomPane()
    const tab = screen.getByTestId(`region-tab-${id}`)
    const title = within(tab).getByText(/\S/).textContent!.trim()
    expect(title.length, 'the bottom tab names its pane').toBeGreaterThan(0)

    const region = screen.getByTestId('region-bottom')
    const shown = [...region.querySelectorAll('*')].filter(
      n => n.children.length === 0 && n.textContent?.trim() === title,
    )
    expect(
      shown.length,
      `"${title}" is rendered ${shown.length}× in the bottom region; it belongs on the tab and ` +
        `nowhere else`,
    ).toBe(1)
  })
})
