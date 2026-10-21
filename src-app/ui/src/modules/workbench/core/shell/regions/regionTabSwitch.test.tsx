// @vitest-environment jsdom
//
// regionTabSwitch — a REAL tab switch, driven the way a user drives one.
//
// ── THE GAP THIS FILE CLOSES ─────────────────────────────────────────────────────────────────────
// Two suites already assert that state survives "a tab switch": `declarativeMount.test.ts` calls
// `release()` and `canvasPersistence.test.tsx` calls the RTL `unmount()`. Both SIMULATE the switch
// by performing the consequence they believe it has. Nothing drove `RegionShell`'s own
// `setActive` — so the actual path a user takes (click the other tab, click back) was never
// exercised, and a regression in it would be invisible to both.
//
// So every case below goes through the rendered shell: `fireEvent.click` on the real
// `region-tab-<paneId>` element, which calls `workbenchRegionsStore.setActive`, which is what
// decides whether `{active ? <PaneBody/> : null}` renders. The panes are the REAL pane components,
// registered as their real kinds.
//
// ── THE NON-VACUITY CONTROL ──────────────────────────────────────────────────────────────────────
// A "state survived the tab switch" assertion is worthless if the switch did not actually unmount
// anything. `LocalStateProbe` holds its value in ordinary `useState` and MUST lose it — that is the
// control proving the harness reproduces the real loss, and it is asserted first.

import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { LauncherPane } from '@/modules/workbench/extensions/jobs/LauncherPane'
import { DEFAULT_PANE_IDS } from '../dock/defaultLayout'
import { workbenchDockStore } from '../dock/WorkbenchDock.store'
import {
  FallbackPane,
  registerPaneRenderer,
  type PaneKind,
  type WorkbenchPane,
} from '../dock/paneModel'
import { __resetPaneState, getPaneState, usePaneState } from '../dock/paneState'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { RegionShell } from './RegionShell'

const PROJECT = 'p-region-tab-switch'

/** A pane that keeps its value in ordinary React state — the loss this whole round is about. */
function LocalStateProbe({ pane }: { pane: WorkbenchPane }) {
  const [value, setValue] = useState('')
  return (
    <input
      aria-label={`local-${pane.id}`}
      data-testid={`probe-local-${pane.id}`}
      value={value}
      onChange={e => setValue(e.target.value)}
    />
  )
}

/** The same pane, keeping its value where a pane's content state belongs. */
function PaneStateProbe({ pane }: { pane: WorkbenchPane }) {
  const [state, patch] = usePaneState<{ value?: string }>(pane.id)
  return (
    <input
      aria-label={`kept-${pane.id}`}
      data-testid={`probe-kept-${pane.id}`}
      value={state?.value ?? ''}
      onChange={e => patch({ value: e.target.value })}
    />
  )
}

/** The kinds this file re-registers, restored to the visible fallback afterwards so a later suite
 *  never inherits a probe renderer. */
const OVERRIDDEN: PaneKind[] = ['launcher', 'jobs', 'artifacts']

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  __resetPaneState()
  workbenchRegionsStore.getState().reset()
  registerPaneRenderer('launcher', LauncherPane)
  registerPaneRenderer('jobs', LocalStateProbe)
  registerPaneRenderer('artifacts', PaneStateProbe)
})

afterEach(() => {
  cleanup()
  for (const kind of OVERRIDDEN) registerPaneRenderer(kind, FallbackPane)
})

/** Mount the real shell on the default IA, then add the two extra RIGHT-region panes the cases
 *  switch between (`launcher` is already there by default; `jobs` + `artifacts` join it). */
async function openShell(): Promise<{ launcher: string; local: string; kept: string }> {
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'region-tab-switch-test')
  workbenchDockStore.getState().ensureProject(PROJECT)
  workbenchRegionsStore.getState().ensureProject(PROJECT)
  let local = ''
  let kept = ''
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={PROJECT} viewId="region-tab-switch" canEdit>
        <RegionShell />
      </WorkbenchProvider>,
    )
  })
  await act(async () => {
    local = workbenchDockStore.getState().requestAddPane('jobs')
    kept = workbenchDockStore.getState().requestAddPane('artifacts')
  })
  // The launcher is part of the shipped default IA, so its id is the named default one.
  return { launcher: DEFAULT_PANE_IDS.launcher, local, kept }
}

/** Click a tab exactly as a user does — this is the whole point of the file. */
async function switchTo(paneId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`region-tab-${paneId}`))
  })
}

/** Is this pane's body mounted right now? (`{active ? <PaneBody/> : null}`) */
const bodyMounted = (paneId: string) => screen.queryByTestId(`region-pane-body-${paneId}`) !== null

describe('a real tab switch through RegionShell', () => {
  it('CONTROL: switching tabs really unmounts the pane, and ordinary React state dies with it', async () => {
    const { local, kept } = await openShell()

    await switchTo(local)
    expect(bodyMounted(local), 'the clicked tab is the one rendering its body').toBe(true)
    fireEvent.change(screen.getByTestId(`probe-local-${local}`), { target: { value: 'typed' } })
    expect((screen.getByTestId(`probe-local-${local}`) as HTMLInputElement).value).toBe('typed')

    await switchTo(kept)
    expect(
      bodyMounted(local),
      'a tab switch must UNMOUNT the pane body — if it does not, every assertion in this file is ' +
        'vacuous and the suite proves nothing',
    ).toBe(false)

    await switchTo(local)
    expect(
      (screen.getByTestId(`probe-local-${local}`) as HTMLInputElement).value,
      'ordinary useState is destroyed by the remount — this is the loss the round is about, and it ' +
        'must be REPRODUCED here or the positive cases below are meaningless',
    ).toBe('')
  })

  it('pane content state keyed by pane id survives it', async () => {
    const { local, kept } = await openShell()

    await switchTo(kept)
    fireEvent.change(screen.getByTestId(`probe-kept-${kept}`), { target: { value: 'kept-value' } })

    await switchTo(local)
    expect(bodyMounted(kept)).toBe(false)
    await switchTo(kept)

    expect(
      (screen.getByTestId(`probe-kept-${kept}`) as HTMLInputElement).value,
      'the pane is still OPEN — the user switched tabs and changed nothing',
    ).toBe('kept-value')
  })

  it('…and CLOSING that pane drops it, so surviving a switch is not leaking forever', async () => {
    const { kept } = await openShell()
    await switchTo(kept)
    fireEvent.change(screen.getByTestId(`probe-kept-${kept}`), { target: { value: 'kept-value' } })
    expect(getPaneState(kept)).toEqual({ value: 'kept-value' })

    await act(async () => {
      fireEvent.click(screen.getByTestId(`region-tab-close-${kept}`))
    })
    expect(getPaneState(kept), 'a CLOSE ends the pane, and its content state goes with it').toBeUndefined()
  })

  it("the launcher's search query survives it", async () => {
    const { launcher, local } = await openShell()

    await switchTo(launcher)
    const search = () => screen.getByTestId('workbench-launcher-search') as HTMLInputElement
    fireEvent.change(search(), { target: { value: 'cluster' } })
    expect(search().value).toBe('cluster')

    await switchTo(local)
    expect(bodyMounted(launcher)).toBe(false)
    await switchTo(launcher)

    expect(
      search().value,
      'the user typed a search, glanced at another tab, and came back to an EMPTY box with the ' +
        'full analysis list — having changed nothing',
    ).toBe('cluster')
  })
})
