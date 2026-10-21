// @vitest-environment jsdom
//
// R4C-05 — the Provenance pane must be PERMISSION-GATED, and must not answer a denied
// user with a factually false empty state.
//
// Commit 6d231748 retired the project section-nav and moved Reproducibility from a
// `detail_panels` project-extension section into a workbench PANE. The section nav was
// permission-filtered (`useProjectNavEntries` → `evaluatePermission`) and the section
// panel was too (`useProjectDetailPanels`); the replacement pane is registered directly
// (`panes.tsx` → `registerPaneRenderer('reproducibility', ProvenancePane)`), bypassing
// `SectionPane` and therefore the project-extension registry's filtering. The move DROPPED
// the UI permission gate.
//
// The consequence measured against a real backend: a user holding `projects::use` but NOT
// `provenance::read` could open the pane, and — because `Provenance` correctly
// self-gates its own fetch (`hasPermissionNow(ProvenanceRead)` → `load()` returns without
// calling the API) — the store stayed at its empty boot state and the pane rendered
//
//     "No provenance yet — Run an analysis to build a provenance graph…"
//
// That is a FALSE statement. The project may well have provenance; the user simply is not
// allowed to see it. The backend gate holds (`GET /api/provenance/runs` answers 403), so
// this is a UI-HONESTY defect, not a data leak — but "no provenance exists" and "you may
// not view the provenance" are different facts and the surface whose entire job is
// truthful reproducibility claims must not conflate them.
//
// These cases render the REAL pane; only the workbench context, the framework store
// registry, and the permission primitive are mocked (the three things a jsdom unit cannot
// supply). The permitted case is the positive control — without it a gate that simply
// hid the pane from everyone would pass.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const load = vi.fn()

/** Whether the simulated session holds `provenance::read`. Flipped per test. */
let allowed = true
/** Whether it holds the SEPARATE `provenance::export` (R6-E1). Flipped per test. */
let allowedExport = true

vi.mock('@/core/permissions', () => ({
  usePermission: (perm: unknown) => (perm === 'provenance::export' ? allowedExport : allowed),
}))

const provenance = {
  graph: null as unknown,
  loading: false,
  error: null as string | null,
  captureError: null as string | null,
  lastCapture: null as unknown,
  recording: false,
  readiness: null as unknown,
  $: { loadedProjectId: null as string | null },
  load,
  reloadCurrent: vi.fn(),
  retryCapture: vi.fn(),
  clearCaptureError: vi.fn(),
}

// `LineagePane.tsx` imports each store's DIRECT handle (the `registerLazyStore`
// proxy), not a global registry — so the mocks must intercept the STORE MODULE
// specifiers. Mocking the old `@/core/stores` shim here would be a silent no-op.
vi.mock('@/modules/provenance/stores/Provenance.store', () => ({ Provenance: provenance }))
vi.mock('@/modules/provenance/stores/ProvenanceExport.store', () => ({
  ProvenanceExport: { openFor: vi.fn() },
}))

vi.mock('../../core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({ projectId: 'proj-1', canEdit: true }),
}))

const { ProvenancePane } = await import('./LineagePane')

const PANE = { id: 'p1' } as Parameters<typeof ProvenancePane>[0]['pane']

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

beforeEach(() => {
  allowed = true
  allowedExport = true
  load.mockReset()
  Object.assign(provenance, {
    graph: null,
    loading: false,
    error: null,
    captureError: null,
    lastCapture: null,
    recording: false,
    $: { loadedProjectId: null },
  })
})

afterEach(cleanup)

describe('ProvenancePane permission gate (R4C-05)', () => {
  it('a user WITHOUT provenance::read gets the 403 surface, never the empty state', () => {
    allowed = false
    render(<ProvenancePane pane={PANE} />)

    expect(
      screen.queryByTestId('workbench-provenance-pane-empty-p1'),
      'a denied user must not be told "No provenance yet" — the project may well have ' +
        'provenance; they are simply not allowed to see it',
    ).toBeNull()
    expect(screen.getByTestId('workbench-provenance-pane-forbidden-p1')).toBeTruthy()
    expect(screen.getByText(/not authorized/i)).toBeTruthy()
  })

  it('…and does not even attempt the load (the store self-gate is a backstop, not the gate)', () => {
    allowed = false
    render(<ProvenancePane pane={PANE} />)
    expect(load).not.toHaveBeenCalled()
  })

  // POSITIVE CONTROL — without this a gate that hid the pane from EVERYONE would pass.
  it('a user WITH provenance::read still gets the real pane and its mount load', () => {
    allowed = true
    render(<ProvenancePane pane={PANE} />)

    expect(screen.queryByTestId('workbench-provenance-pane-forbidden-p1')).toBeNull()
    expect(screen.getByTestId('workbench-provenance-pane-empty-p1')).toBeTruthy()
    expect(load).toHaveBeenCalledWith('proj-1')
  })
})

// R6-E1 / R6-E4 — `provenance::export` is a SEPARATE backend permission
// (`server/src/modules/provenance/permissions.rs` → "provenance::export", enforced by
// `RequirePermissions<(ProvenanceExport,)>` on `export` / `download_export` / `verify`,
// handlers.rs:242/:300/:329). A holder of `provenance::read` alone was still offered an
// ENABLED "Export bundle" button in BOTH pane branches, which can only 403. The
// permitted cases are also the E4 coverage: the EMPTY-graph export affordance (a
// capability this branch deliberately restored, R4C-06) was asserted by no unit test, so
// deleting the Button left the suite green.
describe('Export bundle is gated on provenance::export (R6-E1 / R6-E4)', () => {
  /** Minimal non-empty closure: a1 → run r1 → a2 (shape per LineagePane.test.ts). */
  const GRAPH = {
    roots: [
      { id: 'a1', datatype: 'anndata', output_id: 'o1', content_hash: 'h1' },
      { id: 'a2', datatype: 'embedding', output_id: 'o2', content_hash: 'h2', run_id: 'r1' },
    ],
    runs: [
      {
        run_id: 'r1',
        kind: 'analysis',
        generator_id: 'demo.leiden',
        generator_version: '1',
        status: 'completed',
        params: {},
        project_id: 'proj-1',
        captured_at: '2026-07-19T00:00:00Z',
        inputs: [{ content_hash: 'h1', kind: 'artifact', ref_id: 'a1', slot: 'input' }],
      },
    ],
  }

  it('EMPTY graph + provenance::export held → the Export bundle button is offered', () => {
    render(<ProvenancePane pane={PANE} />)
    expect(screen.getByTestId('workbench-provenance-pane-empty-p1')).toBeTruthy()
    expect(
      screen.getByTestId('provenance-export-bundle-p1'),
      'a project with no captured runs still exports a valid bundle (R4C-06) — the ' +
        'empty-state affordance must exist, and be pane-scoped (R6-E2)',
    ).toBeTruthy()
  })

  it('EMPTY graph + provenance::export NOT held → no button that could only 403', () => {
    allowedExport = false
    render(<ProvenancePane pane={PANE} />)
    expect(screen.getByTestId('workbench-provenance-pane-empty-p1')).toBeTruthy()
    expect(screen.queryByTestId('provenance-export-bundle-p1')).toBeNull()
  })

  it('NON-EMPTY graph → the header button follows the same gate (both branches)', () => {
    provenance.graph = GRAPH
    render(<ProvenancePane pane={PANE} />)
    expect(screen.queryByTestId('workbench-provenance-pane-empty-p1')).toBeNull()
    expect(screen.getByTestId('provenance-export-bundle-p1')).toBeTruthy()
    cleanup()

    allowedExport = false
    render(<ProvenancePane pane={PANE} />)
    expect(screen.queryByTestId('provenance-export-bundle-p1')).toBeNull()
  })
})
