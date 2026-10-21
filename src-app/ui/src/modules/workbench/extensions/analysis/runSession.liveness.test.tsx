// @vitest-environment jsdom
//
// A LIVE RUN SURVIVES THE PANE BEING LOOKED AWAY FROM.
//
// The defect: `AnalysisRunPanel` held the run's state in `useState` and its progress
// subscription in a ref torn down by `useEffect(() => () => subRef.current?.dispose(), [])`,
// with nothing that re-subscribed. A region renders only its ACTIVE tab (`RegionShell`:
// `{active ? <PaneBody/> : null}`), so a tab switch UNMOUNTED the panel — killing the
// stream and destroying the state — while the run itself carried on server-side. The pane
// came back reading `idle`.
//
// The case that decides the SHAPE of the fix, and the one a bare re-subscribe-on-mount
// gets wrong, is the FIRST test below: a run that FINISHES while the pane is away. Its
// terminal frame is delivered to nobody, so re-attaching to that stream on return yields a
// channel that will never speak again and a pane that spins forever. It passes here
// because the SESSION owns the subscription and outlives the render, so the completion is
// processed with no component mounted at all.
//
// Everything faked is a boundary: the `jobs` capability (the SSE transport), the workbench
// context, and `ApiClient.Jobs`. The panel, the session, the reducer and the console are
// the shipping code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createCapabilityBroker } from '../../core/capabilities/broker'
import { identityLattice } from '../../core/datatypes/lattice'
import type { JobFrame } from '../jobs/contract'

/** The subscribed `onFrame`, captured from the fake `JobHandle` — our SSE transport. */
let onFrame: ((f: JobFrame) => void) | null = null
let disposeCount = 0

const jobsApi = {
  run: vi.fn(async () => ({
    jobId: 'job-1',
    onProgress(cb: (f: JobFrame) => void) {
      onFrame = cb
      return {
        dispose: () => {
          disposeCount += 1
        },
      }
    },
  })),
}

const broker = createCapabilityBroker()
broker.publish('jobs', '1.0.0', jobsApi)

const notify = vi.fn()
const refreshCatalog = vi.fn()

vi.mock('../../core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({
    api: {
      version: '1.0.0',
      extensionId: 'test',
      registry: {},
      capabilities: broker,
      ui: { notify },
      storage: {},
      events: {},
    },
    projectId: 'p1',
    viewId: 'v1',
    canEdit: true,
    producedTypeIds: [],
    lattice: identityLattice,
    backendArch: 'x86_64',
    refreshCatalog,
    catalogEpoch: 0,
  }),
}))

/** `GET /api/jobs/{id}` — the run-id resolution AND the reconcile status read. */
const jobsGet = vi.fn(async (_a: { id: string }) => ({
  job: { id: 'job-1', run_id: 'run-1', status: 'completed' } as { id: string; run_id: string | null; status: string },
  can_stop: true,
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Jobs: {
      get: (a: { id: string }) => jobsGet(a),
      logs: async () => ({ logs: [] }),
      stop: async () => ({}),
    },
  },
}))

// `ArtifactReview` mounts on completion and would go to the network for the run's outputs.
// The subject here is the run LIFECYCLE, not the review, so it is stubbed to a marker.
vi.mock('../jobs/ArtifactReview', () => ({
  ArtifactReview: ({ runId }: { runId: string }) => <div data-testid="artifact-review">{runId}</div>,
}))
vi.mock('./AnalysisFlowGuidance', () => ({ AnalysisFlowGuidance: () => null }))

const { AnalysisRunPanel } = await import('./AnalysisRunPanel')
const { __resetRunSessions, getRunSession } = await import('./runSession')
const { clearPaneState, __resetPaneState } = await import('../../core/shell/dock/paneState')

const ID = 'qc.live'
const PANE = 'pane-run-1'

const analysis = {
  id: ID,
  title: 'Live progress',
  category: 'qc',
  accepts: [],
  produces: [],
  params: { fields: [] },
  defaults: {},
  run: { language: 'python', code: 'print(1)' },
} as never

/** Deliver ONE already-mapped frame into whatever is subscribed (a component need not be
 *  mounted — that is the point). */
async function frame(f: JobFrame): Promise<void> {
  await act(async () => {
    onFrame?.(f)
    // let the terminal transition's awaits settle
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Mount the panel AS A PANE HOSTS IT (keyed by pane id) and click Run. */
async function mountPane(): Promise<ReturnType<typeof render>> {
  const view = render(<AnalysisRunPanel analysis={analysis} sessionKey={PANE} />)
  await act(async () => {})
  return view
}

async function clickRun(): Promise<void> {
  const runBtn = await screen.findByTestId(`workbench-analysis-run-${ID}`)
  await act(async () => {
    fireEvent.click(runBtn)
  })
  expect(onFrame, 'the panel must SUBSCRIBE to the run stream').not.toBeNull()
}

beforeEach(() => {
  onFrame = null
  disposeCount = 0
  notify.mockClear()
  refreshCatalog.mockClear()
  jobsApi.run.mockClear()
  jobsGet.mockClear()
  jobsGet.mockResolvedValue({ job: { id: 'job-1', run_id: 'run-1', status: 'completed' }, can_stop: true })
  __resetRunSessions()
  __resetPaneState()
})
afterEach(() => {
  cleanup()
  __resetRunSessions()
  __resetPaneState()
})

describe('a run outlives the pane being unmounted (the tab-switch defect)', () => {
  // THE headline case. A bare "re-subscribe on mount" fails this one: the terminal frame
  // arrives while nothing is listening, so a stream re-attached on return never speaks.
  it('a run that COMPLETES while the pane is unmounted reads as completed when it returns', async () => {
    await mountPane()
    await clickRun()
    await frame({ phase: 'loading', pct: 20 } as JobFrame)

    // The user switches to a sibling tab: the region stops rendering this pane.
    cleanup()
    expect(getRunSession(PANE).runState).toBe('running')

    // The run finishes while nothing is mounted.
    await frame({ phase: 'completed' } as JobFrame)

    // ... and the user comes back.
    await mountPane()

    // NOT idle (the old behaviour: state destroyed, console gone), and NOT spinning.
    expect(screen.queryByTestId(`workbench-run-live-${ID}`)).toBeNull()
    const console_ = await screen.findByTestId(`workbench-run-console-${ID}`)
    expect(console_.textContent).toContain('Completed')
    // The run was resolved deterministically by run_id and the outputs are reviewable.
    expect(screen.getByTestId('artifact-review').textContent).toBe('run-1')
    expect(getRunSession(PANE).runState).toBe('done')
  })

  it('progress emitted while the pane is unmounted is on the timeline when it returns', async () => {
    // The server agrees the run is still going, so the mount-time reconcile is a no-op
    // here and the surviving subscription is the only thing under test.
    jobsGet.mockResolvedValue({ job: { id: 'job-1', run_id: null, status: 'running' }, can_stop: true })
    await mountPane()
    await clickRun()
    cleanup()

    // Frames keep arriving with nothing mounted — the old code had disposed the stream,
    // so these were never delivered at all and the timeline restarted empty.
    await frame({ kind: 'progress', phase: 'filtering', pct: 40 } as unknown as JobFrame)
    await frame({ kind: 'progress', phase: 'writing', pct: 90 } as unknown as JobFrame)

    await mountPane()
    expect(screen.getByTestId(`workbench-run-console-${ID}`)).toBeTruthy()
    expect(screen.getByTestId('workbench-run-phase-filtering')).toBeTruthy()
    expect(screen.getByTestId('workbench-run-phase-writing')).toBeTruthy()
    // Still live, and the pane says which phase it is on.
    expect(screen.getByTestId(`workbench-run-live-${ID}`).textContent).toBe('writing')
  })

  it('the stream is NOT disposed by an unmount, and IS disposed when the pane closes', async () => {
    await mountPane()
    await clickRun()

    cleanup() // a tab switch
    expect(disposeCount, 'unmount must not end the run stream — that is the defect').toBe(0)

    clearPaneState(PANE) // the pane is CLOSED
    expect(disposeCount, 'closing the pane ends the stream (no leaked SSE reader)').toBe(1)
    expect(getRunSession(PANE).runState, 'and the session is forgotten').toBe('idle')
  })
})

describe('reconcile — the stream that died without saying so', () => {
  // The surviving subscription handles the ordinary case; this covers the SSE that is
  // aborted / dropped / lost to a server restart, where no terminal frame is ever
  // delivered. Without the mount-time reconcile the pane renders a spinner over a job
  // that ended long ago.
  it('a mount that finds the session still `running` asks the server and settles it', async () => {
    jobsGet.mockResolvedValue({ job: { id: 'job-1', run_id: null, status: 'running' }, can_stop: true })
    await mountPane()
    await clickRun()
    // One phase, so the completed console has a timeline to render (it is shown on `done`
    // only when the run announced phases — unchanged by this fix).
    await frame({ kind: 'progress', phase: 'loading', pct: 10 } as unknown as JobFrame)

    // The stream dies silently: no terminal frame, ever.
    onFrame = null
    cleanup()
    expect(getRunSession(PANE).runState).toBe('running')

    // The server says it finished.
    jobsGet.mockResolvedValue({ job: { id: 'job-1', run_id: 'run-9', status: 'completed' }, can_stop: false })

    await mountPane()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getRunSession(PANE).runState).toBe('done')
    expect(screen.getByTestId(`workbench-run-console-${ID}`).textContent).toContain('Completed')
    expect(screen.getByTestId('artifact-review').textContent).toBe('run-9')
  })

  it('a job the server still reports as running is left alone (not declared finished)', async () => {
    await mountPane()
    await clickRun()
    onFrame = null
    cleanup()

    jobsGet.mockResolvedValue({ job: { id: 'job-1', run_id: null, status: 'running' }, can_stop: true })
    await mountPane()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getRunSession(PANE).runState).toBe('running')
    expect(screen.getByTestId(`workbench-run-live-${ID}`)).toBeTruthy()
  })

  it('a read error leaves the run as it is rather than failing it', async () => {
    await mountPane()
    await clickRun()
    onFrame = null
    cleanup()

    jobsGet.mockRejectedValue(new Error('offline'))
    await mountPane()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getRunSession(PANE).runState).toBe('running')
  })
})

describe('sessions are isolated by key', () => {
  it("one pane's run does not appear in another pane's", async () => {
    await mountPane()
    await clickRun()
    await frame({ kind: 'progress', phase: 'filtering', pct: 40 } as unknown as JobFrame)
    cleanup()

    render(<AnalysisRunPanel analysis={analysis} sessionKey="pane-run-2" />)
    await act(async () => {})
    expect(screen.queryByTestId(`workbench-run-console-${ID}`)).toBeNull()
    expect(getRunSession('pane-run-2').runState).toBe('idle')
    expect(getRunSession(PANE).runState).toBe('running')
  })
})
