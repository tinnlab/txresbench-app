// @vitest-environment jsdom
//
// TEST-542 (ITEM-22/23) — the run pane's LIVE progress, end to end from a raw jobs-SSE
// payload to the DOM. This suite exists because ITEM-22 previously had NO assertion
// anywhere in the repo:
//
//   • `run-pane.spec.ts` (the e2e named for it) asserted only `workbench-run-console-*`,
//     `workbench-run-logs-*` and `workbench-run-stop-*` — all three of which are satisfied
//     by the CLICK's own synchronous state. `submit()` opens with `setRunState('running')`
//     (`AnalysisRunPanel.tsx:352`) BEFORE the POST is awaited and before `onProgress` is
//     subscribed (`:401`); the console mounts on `runState === 'running'` (`:523`), the log
//     pane renders unconditionally with a "No output yet" branch (`RunProgressConsole:145`),
//     and Stop renders on `canEdit && running` (`:530`). Zero frames are required.
//   • the only frame-DEPENDENT testids — `workbench-run-timeline-*` (`:98`),
//     `workbench-run-phase-*` (`:100`), `workbench-run-metric-*` (`:131`),
//     `workbench-run-live-*` (`:69`) — had zero references outside the component.
//   • `upsertPhase` (the phase reducer) and the panel's `onFrame` dispatch had no test.
//
// So the whole `progress`/`log`/`metric` chain could stop delivering and every gate in the
// repo stayed green. These cases close that: each drives a REAL jobs-SSE payload through the
// REAL `mapSseFrame`, into the REAL panel's `onFrame`, through the REAL `upsertPhase`, and
// asserts the REAL `RunProgressConsole` output.
//
// WHAT THIS DOES NOT COVER (deliberately — it needs a sandbox-executable host):
//   • the SSE TRANSPORT itself (`jobsHost.streamJob`'s EventSource wiring) — the frame
//     MAPPER is pinned by `jobsHost.streamJob.test.ts` (TEST-305); the transport and the
//     backend actually EMITTING these frames during a run are covered by the gated
//     `run-pane.spec.ts` "live SSE frames" case (TXR_E2E_REAL_COMPUTE=1).
//   • the terminal (`status`) path — `finishTerminal` reaches for `ApiClient.Jobs.*`; the
//     completion surface is `artifact-review.spec.ts`'s subject, also compute-gated.
//
// Only the jobs CAPABILITY and the workbench CONTEXT are faked (the two things a jsdom unit
// cannot supply); the panel, the reducer and the console are the shipping code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createCapabilityBroker } from '../../core/capabilities/broker'
import { identityLattice } from '../../core/datatypes/lattice'
import { mapSseFrame } from '../jobs/jobFrames'
import type { JobFrame } from '../jobs/contract'

/** The subscribed `onFrame` callback, captured from the fake `JobHandle` — our stand-in
 *  for the SSE transport. Frames are pushed through it exactly as `streamJob` would. */
let onFrame: ((f: JobFrame) => void) | null = null
let disposed = false

const jobsApi = {
  run: vi.fn(async () => ({
    jobId: 'job-1',
    onProgress(cb: (f: JobFrame) => void) {
      onFrame = cb
      return { dispose: () => (disposed = true) }
    },
  })),
}

const broker = createCapabilityBroker()
broker.publish('jobs', '1.0.0', jobsApi)

const notify = vi.fn()

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
    refreshCatalog: vi.fn(),
    catalogEpoch: 0,
  }),
}))

const { AnalysisRunPanel, upsertPhase } = await import('./AnalysisRunPanel')

const ID = 'qc.live'

/** A minimal flat analysis: no artifact-ref fields (so the auto-pick / data-default effects
 *  short-circuit and no `data` capability is needed) and no steps (so the panel renders its
 *  OWN Run button — the same one the e2e clicks). */
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

/** Push ONE raw jobs-SSE event (the `server/src/modules/jobs/sse.rs::SSEJobEvent` wire
 *  vocabulary) through the real mapper into the panel's subscribed handler. */
async function sse(event: string, data: Record<string, unknown>): Promise<void> {
  const frame = mapSseFrame(event, data)
  expect(frame, `mapSseFrame dropped a real "${event}" event`).not.toBeNull()
  await act(async () => {
    onFrame?.(frame as JobFrame)
  })
}

/** Mount the panel and click Run — leaving the run in flight with zero frames delivered. */
async function mountAndRun(): Promise<void> {
  render(<AnalysisRunPanel analysis={analysis} />)
  const runBtn = await screen.findByTestId(`workbench-analysis-run-${ID}`)
  await act(async () => {
    fireEvent.click(runBtn)
  })
  expect(onFrame, 'the panel must SUBSCRIBE to the run stream').not.toBeNull()
}

beforeEach(() => {
  onFrame = null
  disposed = false
  notify.mockClear()
  jobsApi.run.mockClear()
})
afterEach(() => cleanup())

// ---------------------------------------------------------------------------------------
// The phase reducer (pure) — the timeline's ordering + active/done semantics.
// ---------------------------------------------------------------------------------------

describe('upsertPhase — the timeline reducer (ITEM-23)', () => {
  it('a NEW phase appends itself ACTIVE and marks every prior phase done', () => {
    const one = upsertPhase([], 'loading', 10)
    expect(one).toEqual([{ name: 'loading', pct: 10, state: 'active' }])
    expect(upsertPhase(one, 'filtering', 0)).toEqual([
      { name: 'loading', pct: 10, state: 'done' },
      { name: 'filtering', pct: 0, state: 'active' },
    ])
  })

  it('a RE-SEEN phase updates its pct IN PLACE (no duplicate row)', () => {
    const prev = upsertPhase(upsertPhase([], 'loading', 10), 'loading', 60)
    expect(prev).toEqual([{ name: 'loading', pct: 60, state: 'active' }])
  })

  // Pins CURRENT behaviour, which is not obviously the only defensible one: re-seeing an
  // earlier phase reactivates it WITHOUT demoting the later ones (the `i < idx` clause only
  // reaches phases before it). No shipping processor re-emits a completed phase, so this is
  // recorded rather than argued with — a change here should be deliberate, not accidental.
  it('a re-seen EARLIER phase reactivates it; later phases keep their state', () => {
    const prev = upsertPhase(upsertPhase([], 'loading', 100), 'filtering', 20)
    expect(upsertPhase(prev, 'loading', 100)).toEqual([
      { name: 'loading', pct: 100, state: 'active' },
      { name: 'filtering', pct: 20, state: 'active' },
    ])
  })

  it('a pct-less re-seen phase KEEPS its last pct (a phase-only progress frame)', () => {
    expect(upsertPhase([{ name: 'loading', pct: 40, state: 'active' }], 'loading')).toEqual([
      { name: 'loading', pct: 40, state: 'active' },
    ])
  })
})

// ---------------------------------------------------------------------------------------
// The chain: raw SSE payload → mapSseFrame → panel onFrame → upsertPhase → console DOM.
// ---------------------------------------------------------------------------------------

describe('AnalysisRunPanel — live SSE progress reaches the DOM (ITEM-22)', () => {
  it('NEGATIVE CONTROL: at the click, with ZERO frames, the console/log/Stop trio is ALREADY there — and nothing frame-driven is', async () => {
    // This is precisely the state `run-pane.spec.ts` was passing in. It is asserted here so
    // the three e2e locators can never again be read as evidence that a frame arrived.
    await mountAndRun()
    expect(screen.getByTestId(`workbench-run-console-${ID}`)).toBeTruthy()
    expect(screen.getByTestId(`workbench-run-logs-${ID}`)).toBeTruthy()
    expect(screen.getByTestId(`workbench-run-stop-${ID}`)).toBeTruthy()

    // …while every frame-DEPENDENT surface is absent.
    expect(screen.queryByTestId(`workbench-run-timeline-${ID}`)).toBeNull()
    expect(screen.queryByTestId(`workbench-run-metric-${ID}`)).toBeNull()
    expect(screen.getByTestId(`workbench-run-live-${ID}`).textContent).toBe('queued')
    expect(screen.getByTestId(`workbench-run-logs-${ID}`).textContent).toContain('No output yet')
  })

  it('a `progress` frame paints the phase timeline, its bar, and the live phase label', async () => {
    await mountAndRun()
    await sse('progress', { phase: 'loading', pct: 10, message: 'reading input' })

    expect(screen.getByTestId(`workbench-run-timeline-${ID}`)).toBeTruthy()
    expect(screen.getByTestId('workbench-run-phase-loading').textContent).toContain('loading')
    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).toContain('10%')
    // The header's live indicator names the ACTIVE phase, not the placeholder.
    expect(screen.getByTestId(`workbench-run-live-${ID}`).textContent).toBe('loading')
  })

  it('a second `progress` for the SAME phase advances its bar in place (one row, not two)', async () => {
    await mountAndRun()
    await sse('progress', { phase: 'loading', pct: 10 })
    await sse('progress', { phase: 'loading', pct: 75 })

    expect(screen.getAllByTestId('workbench-run-phase-loading')).toHaveLength(1)
    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).toContain('75%')
  })

  it('a NEW phase appends a second timeline row and moves the live label onto it', async () => {
    await mountAndRun()
    await sse('progress', { phase: 'loading', pct: 100 })
    await sse('progress', { phase: 'reducing', pct: 40 })

    const rows = screen
      .getByTestId(`workbench-run-timeline-${ID}`)
      .querySelectorAll('[data-testid^="workbench-run-phase-"]')
    // 2 rows + their 2 bars.
    expect(rows.length).toBe(4)
    expect(screen.getByTestId('workbench-run-phase-reducing')).toBeTruthy()
    expect(screen.getByTestId(`workbench-run-live-${ID}`).textContent).toBe('reducing')
  })

  it('`pct: 1` renders 1%, NOT 100% (the fraction-detection heuristic this replaced)', async () => {
    await mountAndRun()
    await sse('progress', { phase: 'loading', pct: 1 })
    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).toContain('1%')
    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).not.toContain('100%')
  })

  it('a `metric` frame paints the resource line from the REAL cpu_pct / mem_bytes keys', async () => {
    await mountAndRun()
    expect(screen.queryByTestId(`workbench-run-metric-${ID}`)).toBeNull()
    await sse('metric', { cpu_pct: 12.5, mem_bytes: 1048576, mem_peak_bytes: 2097152, pids_current: 3 })

    const line = screen.getByTestId(`workbench-run-metric-${ID}`).textContent ?? ''
    expect(line).toContain('CPU 13%')
    expect(line).toContain('Mem 1.0 MB')
    expect(line).toContain('3 proc')
  })

  it('`log` frames replace the empty state with the streamed lines, in order', async () => {
    await mountAndRun()
    await sse('log', { seq: 1, stream: 'stdout', content: 'reading input part 1' })
    await sse('log', { seq: 2, stream: 'stderr', content: 'warning: 3 records dropped' })

    const pane = screen.getByTestId(`workbench-run-logs-${ID}`)
    expect(pane.textContent).not.toContain('No output yet')
    expect(pane.textContent).toContain('reading input part 1')
    expect(pane.textContent).toContain('warning: 3 records dropped')
    expect(pane.textContent?.indexOf('reading input part 1')).toBeLessThan(
      pane.textContent?.indexOf('warning: 3 records dropped') as number,
    )
    // stderr is visually distinguished from stdout. Matched on the LINE's own text (equality,
    // not `includes`) so it resolves the leaf that renders the line rather than the first
    // ancestor that happens to contain it — the log pane is the kit `ScrollArea`, and
    // overlayscrollbars interposes its own wrapper divs, every one of which "contains" the text.
    const stderrLine = [...pane.querySelectorAll('div')].find(
      d => d.textContent?.trim() === 'warning: 3 records dropped',
    )
    expect(stderrLine, 'the stderr line rendered no element of its own').toBeTruthy()
    expect(stderrLine?.className).toContain('text-destructive')
  })

  it('the three frame families are independent — a metric never clears the timeline or the log', async () => {
    await mountAndRun()
    await sse('progress', { phase: 'loading', pct: 30 })
    await sse('log', { seq: 1, stream: 'stdout', content: 'hello' })
    await sse('metric', { cpu_pct: 4, mem_bytes: 2048 })

    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).toContain('30%')
    expect(screen.getByTestId(`workbench-run-logs-${ID}`).textContent).toContain('hello')
    expect(screen.getByTestId(`workbench-run-metric-${ID}`).textContent).toContain('CPU 4%')
  })

  // THE DISTINCTION THE E2E DEPENDS ON. `onFrame`'s fall-through turns any non-terminal
  // `status` frame into a timeline phase, so a TIMELINE alone proves nothing about the
  // `progress` family — measured: an e2e that asserted "a timeline appeared" stayed green
  // with the whole `progress` arm deleted, because the jobs SSE emits `status{running}` on
  // every job. A `pct` is the part `status` cannot fake (`mapSseFrame`'s status arm has no
  // pct field), and `workbench-run-phase-bar-*` renders only for a phase that has one. This
  // pins that asymmetry so the e2e's discriminator cannot rot without a red here.
  it('a non-terminal `status` frame makes a timeline row but NO percentage bar', async () => {
    await mountAndRun()
    await sse('status', { status: 'running' })

    expect(screen.getByTestId(`workbench-run-timeline-${ID}`)).toBeTruthy()
    expect(screen.getByTestId('workbench-run-phase-running')).toBeTruthy()
    expect(document.querySelectorAll('[data-testid^="workbench-run-phase-bar-"]')).toHaveLength(0)

    // A `progress` frame is what puts a bar on the board — the positive control.
    await sse('progress', { phase: 'loading', pct: 30 })
    expect(document.querySelectorAll('[data-testid^="workbench-run-phase-bar-"]')).toHaveLength(1)
    expect(screen.getByTestId('workbench-run-phase-bar-loading').textContent).toContain('30%')
  })

  // REWRITTEN, not deleted. This case used to read "unmounting disposes the stream
  // subscription (no leaked SSE reader)" and it was certifying the defect: a region renders
  // only its ACTIVE tab, so unmount means "the user looked at a sibling tab", not "the run
  // is over" — and disposing there is exactly what dropped a live run's progress and left
  // the pane reading `idle` on return. The no-leak property it was reaching for is real,
  // but its trigger is the pane CLOSING, which is now where it is asserted
  // (`runSession.liveness.test.tsx`).
  //
  // What survives here is the half of the old contract that was always right: a host with
  // NO durable identity — no `sessionKey`, which is what this suite renders — has no life
  // beyond its render, so ITS stream still ends with it.
  it('an UNKEYED host (no durable identity) still disposes its stream on unmount', async () => {
    await mountAndRun()
    expect(disposed).toBe(false)
    cleanup()
    expect(disposed).toBe(true)
  })
})
