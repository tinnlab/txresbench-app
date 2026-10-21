// @vitest-environment jsdom
//
// R3-119 — the WIRING of the DEC-19 capture-failure banner into the pane that renders it.
//
// `LineagePane.captureBanner.test.tsx` renders `CaptureFailureBanner` with a HAND-INJECTED
// `onRetry` mock, so it asserts only that the button calls whatever prop it is given. It
// says nothing about what `ProvenancePane` actually passes. Round-3 mutation testing
// proved the gap is real: rewriting `LineagePane.tsx`'s
//
//     onRetry={() => void Provenance.retryCapture()}
//
// into `onRetry={() => Provenance.clearCaptureError()}` — VERBATIM the F2-31 defect
// ("clicking Try again read as a successful retry while the run stayed unrecorded") — left
// the entire 692-test UI suite green, because NO test rendered `ProvenancePane` at all.
//
// This file renders the real pane. Only the two things a jsdom unit test cannot supply are
// mocked: the workbench context (a provider the shell owns) and the framework store
// registry. Everything between the store and the button — the `captureError`/`lastCapture`/
// `recording` reads, the conditional render, the two callbacks — is the production code.
//
// The graph is deliberately EMPTY so the pane takes its `Empty` branch: the banner sits
// ABOVE the graph area and must render regardless of graph state (that separation is the
// F2-31 fix itself — a capture failure must not blank the lineage view), and it keeps
// xyflow out of jsdom.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const retryCapture = vi.fn()
const clearCaptureError = vi.fn()
const reloadCurrent = vi.fn()
const load = vi.fn()
const openFor = vi.fn()

/** The `Provenance` slice the pane reads. Mutated per test, then re-rendered. */
const provenance = {
  graph: null as unknown,
  loading: false,
  error: null as string | null,
  captureError: null as string | null,
  lastCapture: null as unknown,
  recording: false,
  readiness: null as unknown,
  $: { loadedProjectId: 'proj-1' },
  load,
  reloadCurrent,
  retryCapture,
  clearCaptureError,
}

// `LineagePane.tsx` imports each store's DIRECT handle (the `registerLazyStore`
// proxy), not a global registry — so the mocks must intercept the STORE MODULE
// specifiers. Mocking the old `@/core/stores` shim here would be a silent no-op:
// the real stores would run and this file's wiring assertions would go vacuous.
vi.mock('@/modules/provenance/stores/Provenance.store', () => ({ Provenance: provenance }))
vi.mock('@/modules/provenance/stores/ProvenanceExport.store', () => ({
  ProvenanceExport: { openFor: (...a: unknown[]) => openFor(...a) },
}))

vi.mock('../../core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({ projectId: 'proj-1', canEdit: true }),
}))

// This file's subject is the capture-banner WIRING, so it fixes the session at PERMITTED
// (`provenance::read` held) — the pane's own `provenance::read` gate (R4C-05) would
// otherwise render the 403 surface in place of any banner. The gate itself, including its
// denied branch AND its positive control, is covered by `LineagePane.permission.test.tsx`.
vi.mock('@/core/permissions', () => ({ usePermission: () => true }))

const { ProvenancePane } = await import('./LineagePane')

const PANE = { id: 'p1' } as Parameters<typeof ProvenancePane>[0]['pane']
const TESTID = 'workbench-provenance-capture-error-p1'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

beforeEach(() => {
  retryCapture.mockReset()
  clearCaptureError.mockReset()
  reloadCurrent.mockReset()
  load.mockReset()
  Object.assign(provenance, {
    graph: null,
    loading: false,
    error: null,
    captureError: null,
    lastCapture: null,
    recording: false,
  })
})

afterEach(cleanup)

describe('ProvenancePane ↔ capture-failure banner wiring (R3-119)', () => {
  it('renders the capture banner when a save-time capture failed', () => {
    provenance.captureError = '403 forbidden'
    provenance.lastCapture = { projectId: 'proj-1' }
    render(<ProvenancePane pane={PANE} />)

    const banner = screen.getByTestId(TESTID)
    expect(banner.textContent).toContain('Selection provenance was not recorded')
    // …and the lineage view is NOT blanked by it (the F2-31 separation): the graph
    // area still renders its own state rather than the failed-LOAD error surface.
    expect(screen.queryByTestId('workbench-provenance-error-p1')).toBeNull()
    expect(screen.getByTestId('workbench-provenance-pane-empty-p1')).toBeTruthy()
  })

  it('the banner’s primary action RE-RUNS the capture — the pane wires retryCapture, not a dismiss', () => {
    provenance.captureError = '403 forbidden'
    provenance.lastCapture = { projectId: 'proj-1' }
    render(<ProvenancePane pane={PANE} />)

    fireEvent.click(screen.getByTestId(`${TESTID}-retry`))
    expect(
      retryCapture,
      'the pane must pass Provenance.retryCapture — a dismiss dressed as a retry ' +
        'tells the user the run was recorded when it never was (F2-31)',
    ).toHaveBeenCalledTimes(1)
    expect(clearCaptureError).not.toHaveBeenCalled()
  })

  it('the SEPARATE dismiss is the only thing that clears the banner', () => {
    provenance.captureError = '403 forbidden'
    provenance.lastCapture = { projectId: 'proj-1' }
    render(<ProvenancePane pane={PANE} />)

    fireEvent.click(screen.getByTestId(`${TESTID}-close`))
    expect(clearCaptureError).toHaveBeenCalledTimes(1)
    expect(retryCapture).not.toHaveBeenCalled()
  })

  it('offers no retry when nothing was retained to re-run, and disables it mid-flight', () => {
    provenance.captureError = 'boom'
    provenance.lastCapture = null
    const { unmount } = render(<ProvenancePane pane={PANE} />)
    expect(screen.queryByTestId(`${TESTID}-retry`)).toBeNull()
    unmount()

    provenance.lastCapture = { projectId: 'proj-1' }
    provenance.recording = true
    render(<ProvenancePane pane={PANE} />)
    expect((screen.getByTestId(`${TESTID}-retry`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed graph LOAD is a different surface, and its retry reloads the graph', () => {
    provenance.error = 'graph 500'
    render(<ProvenancePane pane={PANE} />)

    // No capture banner — the two failures no longer share one slot.
    expect(screen.queryByTestId(TESTID)).toBeNull()
    const err = screen.getByTestId('workbench-provenance-error-p1')
    expect(err).toBeTruthy()
    // …and THAT retry is the graph reload, not the capture re-run.
    fireEvent.click(screen.getByTestId('workbench-provenance-error-p1-retry'))
    expect(reloadCurrent).toHaveBeenCalledTimes(1)
    expect(retryCapture).not.toHaveBeenCalled()
  })
})
