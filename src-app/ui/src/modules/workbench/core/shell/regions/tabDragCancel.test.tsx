// @vitest-environment jsdom
//
// A CANCELLED TAB DRAG LEAVES NO DRAG STATE BEHIND.
//
// `startPointerDrag` grew `pointercancel` + Escape handling for the SECTION drag (an
// interrupted touch used to leak its window listeners, strand the ghost and turn the next tap
// anywhere into a drop). The primitive's half of that fix is generic, but the STATE each
// caller puts into a store on `onStart` is the caller's to tear down: `startTabDrag` sets
// `dragPaneId` + `dragOverRegion`, both read by `RegionDropOverlay`, and only `onDrop` cleared
// them. So after a cancelled tab drag the primitive was clean and the SHELL was not — the drop
// overlays stayed painted on a highlighted region until some later drag happened to end.
//
// That is why `onCancel` is a callback of its own and not `onDrop(moved: false)`: the two mean
// different things (a sub-threshold press is a CLICK and must not disturb anything; a cancelled
// drag did start and must be undone), and a caller that conflated them would either swallow
// clicks or leave this exact residue.
//
// The drag is driven through the REAL rendered tab, because the defect is in the WIRING —
// which callbacks `startTabDrag` passes — and a test that called the primitive directly would
// assert nothing about that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { DEFAULT_PANE_IDS } from '../dock/defaultLayout'
import { workbenchDockStore } from '../dock/WorkbenchDock.store'
import { __resetPaneState } from '../dock/paneState'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { RegionShell } from './RegionShell'

const PROJECT = 'p-tab-drag-cancel'

// jsdom implements no layout, so it ships no `elementFromPoint` — which `attributeAtPoint`
// calls on the DROP path only. Stubbed to "nothing under the cursor", which is a legitimate
// drop (released over no region) and keeps the control case about the STATE teardown rather
// than about where the pane landed.
beforeEach(() => {
  document.elementFromPoint ??= (): Element | null => null
  cleanup()
  window.localStorage.clear()
  __resetPaneState()
  workbenchRegionsStore.getState().reset()
})
afterEach(cleanup)

async function openShell(): Promise<void> {
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'tab-drag-cancel-test')
  workbenchDockStore.getState().ensureProject(PROJECT)
  workbenchRegionsStore.getState().ensureProject(PROJECT)
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={PROJECT} viewId="tab-drag-cancel" canEdit>
        <RegionShell />
      </WorkbenchProvider>,
    )
  })
}

/**
 * Press the tab and move far enough to cross the 4px threshold, i.e. become a REAL drag.
 *
 * jsdom ships no `PointerEvent`, and `fireEvent.pointerDown(el, { button, clientX })` silently
 * drops both fields on the synthetic event it builds — the handler then sees `button:
 * undefined`, `startPointerDrag` refuses the press as non-primary, and every "nothing was left
 * behind" assertion below would pass without a drag ever having started. So the events are
 * constructed as `MouseEvent`s, which jsdom does implement, and the live-drag state is
 * asserted before anything is cancelled.
 */
async function beginDrag(paneId: string): Promise<void> {
  const tab = screen.getByTestId(`region-tab-${paneId}`)
  await act(async () => {
    fireEvent(tab, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 40 }))
  })
}

describe('a cancelled tab drag leaves no drag state in the shell', () => {
  it('pointercancel ends the drag — the overlays do not stay painted', async () => {
    await openShell()
    const pane = DEFAULT_PANE_IDS.launcher

    await beginDrag(pane)
    // THE PREMISE, asserted rather than assumed. Without this the test passes on a harness
    // where the drag never started, which is the vacuity this whole class of test keeps
    // producing.
    expect(workbenchRegionsStore.getState().dragPaneId, 'the drag never started').toBe(pane)

    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, clientX: 80, clientY: 40 }))
    })
    expect(workbenchRegionsStore.getState().dragPaneId).toBeNull()
    expect(workbenchRegionsStore.getState().dragOverRegion).toBeNull()
  })

  it('Escape ends it too, through the same exit', async () => {
    await openShell()
    const pane = DEFAULT_PANE_IDS.launcher

    await beginDrag(pane)
    expect(workbenchRegionsStore.getState().dragPaneId).toBe(pane)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(workbenchRegionsStore.getState().dragPaneId).toBeNull()
  })

  it('CONTROL: an ordinary release still ends the drag — the cancel path did not replace it', async () => {
    // Without this, a wiring that ended the drag on EVERY exit path (including one that also
    // broke the drop) would satisfy the two cases above.
    await openShell()
    const pane = DEFAULT_PANE_IDS.launcher

    await beginDrag(pane)
    expect(workbenchRegionsStore.getState().dragPaneId).toBe(pane)

    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 80, clientY: 40 }))
    })
    expect(workbenchRegionsStore.getState().dragPaneId).toBeNull()
  })
})
