// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

// ITEM-7 REGRESSION GUARD — the Parameters section.
//
// `artifacts.params` was dropped and the artifact-side fallback went with it, leaving a
// section that NO in-tree caller could populate: a user who could previously read what a
// run was given saw nothing at all. The parameters live on the RUN, so this suite drives
// the wired path — `artifact.run_id` → `Provenance.run` → `RunNodeDto.params` — and pins
// the four answers apart (INV-2): produced-by-no-run, unreadable, none recorded, present.
//
// Only the ApiClient boundary is mocked; the view, its hooks and the kit render for real.

const getArtifact = vi.fn()
const runNode = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Workstore: { getArtifact: (...a: unknown[]) => getArtifact(...a) },
    Provenance: { run: (...a: unknown[]) => runNode(...a) },
  },
}))

const { ProvenanceView } = await import('./ProvenanceView')

beforeAll(() => {
  // jsdom lacks it; the kit's Descriptions measures its own container at mount.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

const ARTIFACT = {
  id: 'a1',
  datatype: 'table',
  content_hash: 'hash-a1',
  created_at: '2026-01-01T00:00:00Z',
  run_id: 'run-1',
}

beforeEach(() => {
  cleanup()
  getArtifact.mockReset().mockResolvedValue(ARTIFACT)
  runNode.mockReset().mockResolvedValue({ id: 'run-1', params: {} })
})

describe('ProvenanceView — the run parameters (ITEM-7)', () => {
  it('renders the RUN’s parameters, read from the run the artifact names', async () => {
    runNode.mockResolvedValue({ id: 'run-1', params: { threshold: 10, mode: 'strict' } })

    render(<ProvenanceView artifactId="a1" />)

    // The section that ITEM-7 left permanently absent is present, with the run's values.
    const rows = await screen.findByTestId('workbench-artifact-provenance-params')
    expect(rows.textContent).toContain('threshold')
    expect(rows.textContent).toContain('10')
    expect(rows.textContent).toContain('mode')
    expect(rows.textContent).toContain('strict')
    // …and it came from the RUN endpoint, keyed by the artifact's `run_id`.
    expect(runNode).toHaveBeenCalledWith({ id: 'run-1' })
  })

  it('nests an object-valued parameter as JSON rather than "[object Object]"', async () => {
    runNode.mockResolvedValue({ id: 'run-1', params: { window: { lo: 1, hi: 2 } } })
    render(<ProvenanceView artifactId="a1" />)
    const rows = await screen.findByTestId('workbench-artifact-provenance-params')
    expect(rows.textContent).toContain('{"lo":1,"hi":2}')
  })

  it('an artifact with NO run reads as an absence — and issues no run request', async () => {
    getArtifact.mockResolvedValue({ ...ARTIFACT, run_id: undefined })

    render(<ProvenanceView artifactId="a1" />)

    const none = await screen.findByTestId('workbench-artifact-provenance-params-no-run')
    expect(none.textContent).toContain('Not produced by a run')
    // An absence, not an empty object: no rows are rendered…
    expect(screen.queryByTestId('workbench-artifact-provenance-params')).toBeNull()
    // …and a source/upload artifact costs nothing to display.
    expect(runNode).not.toHaveBeenCalled()
  })

  it('a run that recorded no parameters says THAT, not "not produced by a run"', async () => {
    runNode.mockResolvedValue({ id: 'run-1', params: null })

    render(<ProvenanceView artifactId="a1" />)

    const empty = await screen.findByTestId('workbench-artifact-provenance-params-empty')
    expect(empty.textContent).toContain('recorded no parameters')
    expect(screen.queryByTestId('workbench-artifact-provenance-params-no-run')).toBeNull()
  })

  it('a FAILED run read is surfaced, never shown as "no parameters"', async () => {
    runNode.mockRejectedValue(new Error('403 forbidden'))

    render(<ProvenanceView artifactId="a1" />)

    const err = await screen.findByTestId('workbench-artifact-provenance-params-error')
    expect(err.textContent).toContain('403 forbidden')
    // The distinction that matters: "we could not read it" is not "there were none".
    expect(screen.queryByTestId('workbench-artifact-provenance-params-empty')).toBeNull()
    // The rest of the provenance still renders — one failed read is not a dead panel.
    expect(screen.getByTestId('workbench-artifact-provenance-prov')).toBeTruthy()
  })

  it('a caller that already holds the run supplies it, and no second read is issued', async () => {
    render(
      <ProvenanceView
        artifactId="a1"
        run={{ id: 'run-1', params: { threshold: 42 } } as never}
      />,
    )

    const rows = await screen.findByTestId('workbench-artifact-provenance-params')
    expect(rows.textContent).toContain('42')
    // `ArtifactLineage` reads the node to draw its chain and hands it down; the detail
    // view must not re-fetch the same run underneath it.
    await waitFor(() => expect(getArtifact).toHaveBeenCalled())
    expect(runNode).not.toHaveBeenCalled()
  })
})
