// @vitest-environment jsdom
//
// RerunPane — the before/after diff a re-run produced must survive a REAL tab switch.
//
// The pane's whole reason to exist is the iteration loop "review → re-run → diff → re-run". The
// diff is gated on `newRunId`, the id of the run this pane just completed; while that lived in
// ordinary React state, glancing at another tab in the same region threw the completed re-run's
// comparison away and left the user looking at a fresh, empty form — with no way back to it short
// of running the analysis a third time.
//
// The switch below is the REAL one: `fireEvent.click` on `RegionShell`'s own tab element, which
// calls `setActive`, which is what decides whether the pane body renders at all.
//
// ── WHAT IS FAKED, AND WHY ───────────────────────────────────────────────────────────────────────
// Three seams, all of them boundaries this file is not testing:
//   · `@/core/provenance` + `@/api-client` — the HTTP reads (the source run node, the produced
//     artifacts). There is no server in a unit run.
//   · `AnalysisRunPanel` — the pane's collaborator, whose completion callback is the only way
//     `newRunId` is ever produced. Driving a REAL run to completion needs the compute plane, a
//     poll loop and a job; stubbing the collaborator is what makes the pane's OWN state ownership
//     (write it, lose the tab, read it back) the thing under test rather than the run machinery.
// The pane itself, the shell, the tab, the regions store and the pane-state store are all real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const RUN = {
  run_id: 'run-a',
  generator_id: 'fixture.analysis',
  params: { threshold: 1 },
} as unknown as import('@/api-client/types').RunNodeDto

vi.mock('@/core/provenance', () => ({
  useRunNode: (id: string | null) => ({
    run: id ? RUN : null,
    loading: false,
    error: null,
    reload: () => {},
  }),
}))

vi.mock('@/api-client', () => ({
  ApiClient: { Workstore: { listArtifacts: async () => [] } },
}))

vi.mock('./AnalysisRunPanel', () => ({
  AnalysisRunPanel: ({ onRunComplete }: { onRunComplete?: (id: string) => void }) => (
    // native-control-ok: a mock standing in for AnalysisRunPanel, whose only job is to fire
    // onRunComplete. Using the kit Button here would test the kit, not the pane's state.
    <button type="button" data-testid="stub-complete-run" onClick={() => onRunComplete?.('run-b')}>
      complete
    </button>
  ),
}))

const { createWorkbenchApi } = await import('@/modules/workbench/core')
const { workbenchRegistry } = await import('@/modules/workbench/core/contributions/workbenchRegistry')
const { makeFakeHost } = await import('@/modules/workbench/core/host/createHost')
const { WorkbenchProvider } = await import('@/modules/workbench/core/shell/WorkbenchContext')
const { workbenchDockStore } = await import('@/modules/workbench/core/shell/dock/WorkbenchDock.store')
const { FallbackPane, registerPaneRenderer } = await import('@/modules/workbench/core/shell/dock/paneModel')
const { __resetPaneState } = await import('@/modules/workbench/core/shell/dock/paneState')
const { workbenchRegionsStore } = await import('@/modules/workbench/core/shell/regions/WorkbenchRegions.store')
const { RegionShell } = await import('@/modules/workbench/core/shell/regions/RegionShell')
const { RerunPane } = await import('./RerunPane')

const PROJECT = 'p-rerun-tab-switch'

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  __resetPaneState()
  workbenchRegionsStore.getState().reset()
  workbenchRegistry.analyses.register({
    id: 'fixture.analysis',
    title: 'Fixture analysis',
    category: 'Fixture',
  } as never)
  registerPaneRenderer('rerun', RerunPane)
  registerPaneRenderer('jobs', ({ pane }) => <div data-testid={`other-${pane.id}`} />)
})

afterEach(() => {
  cleanup()
  workbenchRegistry.analyses.remove('fixture.analysis')
  registerPaneRenderer('rerun', FallbackPane)
  registerPaneRenderer('jobs', FallbackPane)
})

it('keeps the completed re-run diff across a real tab switch', async () => {
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'rerun-tab-switch-test')
  workbenchDockStore.getState().ensureProject(PROJECT)
  workbenchRegionsStore.getState().ensureProject(PROJECT)
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={PROJECT} viewId="rerun-tab-switch" canEdit>
        <RegionShell />
      </WorkbenchProvider>,
    )
  })
  let rerun = ''
  let other = ''
  await act(async () => {
    rerun = workbenchDockStore.getState().requestAddPane('rerun', RUN.run_id)
    other = workbenchDockStore.getState().requestAddPane('jobs')
  })

  const switchTo = async (id: string) => {
    await act(async () => {
      fireEvent.click(screen.getByTestId(`region-tab-${id}`))
    })
  }

  await switchTo(rerun)
  // The re-run completes: this is the ONLY producer of the diff's `newRunId`.
  await act(async () => {
    fireEvent.click(screen.getByTestId('stub-complete-run'))
  })
  expect(screen.queryByTestId(`workbench-rerun-diff-${rerun}`), 'the diff renders once the re-run completes').not.toBeNull()

  await switchTo(other)
  expect(screen.queryByTestId(`region-pane-body-${rerun}`), 'the switch really unmounts the pane').toBeNull()
  await switchTo(rerun)

  expect(
    screen.queryByTestId(`workbench-rerun-diff-${rerun}`),
    'the user completed a re-run, glanced at another tab, and came back to a pane that had ' +
      'forgotten the run it had just finished — the comparison is only recoverable by running it again',
  ).not.toBeNull()
})
