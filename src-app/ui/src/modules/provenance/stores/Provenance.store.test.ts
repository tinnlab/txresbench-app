// F2-34 / F2-31 — the per-project lifecycle of the capture-failure state, and the
// banner action that has to be a REAL retry.
//
// vitest (node env); the only boundaries mocked are `ApiClient.Provenance.*` and the
// permission gate — the store's own logic runs for real.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

const runs = vi.fn()
const graph = vi.fn()
const recordAction = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Provenance: {
      runs: (...a: unknown[]) => runs(...a),
      graph: (...a: unknown[]) => graph(...a),
      recordAction: (...a: unknown[]) => recordAction(...a),
    },
  },
}))

const { useProvenanceStore } = await import('./Provenance.store')
const state = () => useProvenanceStore.getState()

beforeEach(() => {
  runs.mockReset().mockResolvedValue({ runs: [], total: 0, page: 1, per_page: 10 })
  graph.mockReset().mockResolvedValue({ roots: [], runs: [], readiness: null })
  recordAction.mockReset().mockResolvedValue({})
  useProvenanceStore.setState({
    projectId: null,
    loadedProjectId: null,
    runs: [],
    total: 0,
    page: 1,
    graph: null,
    readiness: null,
    loading: false,
    recording: false,
    error: null,
    captureError: null,
    lastCapture: null,
  })
})

/** The live capture contract: the `subset.filter` action type + the flat criteria recipe
 *  the save path posts (`provenance.record-selection` → `recordCapture`). */
const ACTION_TYPE = 'subset.filter'
const RECIPE = { criteria: [{ column: 'pct_mito', max: '10' }] }

/** Drive a capture to failure — the state every case below starts from. */
async function failedCapture(projectId = 'project-A') {
  await state().load(projectId)
  recordAction.mockRejectedValueOnce(new Error('403 forbidden'))
  await expect(
    state().recordCapture(projectId, 'artifact-1', ACTION_TYPE, RECIPE, 'lowqc'),
  ).rejects.toThrow('403 forbidden')
}

describe('Provenance capture-failure lifecycle', () => {
  it('parks the failure + retains the attempt (so the failure is reportable AND retryable)', async () => {
    await failedCapture()
    expect(state().captureError).toBe('403 forbidden')
    expect(state().recording).toBe(false)
    expect(state().lastCapture).toMatchObject({
      projectId: 'project-A',
      inputArtifactId: 'artifact-1',
      actionType: ACTION_TYPE,
      label: 'lowqc',
    })
  })

  // F2-34: `captureError` is a PER-PROJECT fact. It used to survive `load()`, so a
  // capture failure in project A rendered its "the last committed selection was NOT
  // recorded" banner over project B's graph — accusing a clean project of holding an
  // irreproducible run.
  it('clears the capture failure when the project changes', async () => {
    await failedCapture('project-A')
    expect(state().captureError).toBe('403 forbidden')

    await state().load('project-B')

    expect(state().projectId).toBe('project-B')
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  // F2-31: the banner's action used to be `clearCaptureError` behind a "Try again"
  // label — a pure dismiss that read as a successful retry while the run stayed
  // unrecorded.
  it('retryCapture RE-POSTS the retained recipe and clears the banner on success', async () => {
    await failedCapture()
    recordAction.mockResolvedValueOnce({})

    await expect(state().retryCapture()).resolves.toBe(true)

    expect(recordAction).toHaveBeenCalledTimes(2)
    // The retry re-posts the SAME action type, not merely the same recipe: the action
    // type selects the server's `emit_code` arm, so a retry that changed it would record
    // a run whose emitted script is not the script for the action that ran.
    expect(recordAction).toHaveBeenLastCalledWith({
      project_id: 'project-A',
      input_artifact_id: 'artifact-1',
      action_type: ACTION_TYPE,
      recipe: RECIPE,
      label: 'lowqc',
    })
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  it('a FAILED retry keeps the banner up (and does not reject out of a click handler)', async () => {
    await failedCapture()
    recordAction.mockRejectedValueOnce(new Error('still 403'))

    await expect(state().retryCapture()).resolves.toBe(false)

    expect(state().captureError).toBe('still 403')
    // …and the attempt is still retained, so the user can try once more.
    expect(state().lastCapture).not.toBeNull()
  })

  it('retryCapture is a no-op when nothing was retained (never fabricates a post)', async () => {
    await state().load('project-A')
    await expect(state().retryCapture()).resolves.toBe(false)
    expect(recordAction).not.toHaveBeenCalled()
  })

  it('clearCaptureError DISMISSES — it drops the banner and its pending retry, and posts nothing', async () => {
    await failedCapture()
    state().clearCaptureError()
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
    expect(recordAction).toHaveBeenCalledTimes(1)
  })

  it('a successful capture retains nothing to retry', async () => {
    await state().load('project-A')
    await expect(
      state().recordCapture('project-A', 'artifact-1', ACTION_TYPE, RECIPE),
    ).resolves.toBeUndefined()
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  // The route + action type the capture actually goes out on. `POST /provenance/actions`
  // (`recordAction`) is the ONLY entry point that takes the action type as a field;
  // `POST /provenance/selections` hardcodes a `selection.` prefix and derives the rest
  // from the recipe's `kind`, which for a criteria recipe lands on the `selection.column`
  // emitter — the arm that demands string `col`/`op`/`val` and answers `MalformedRecipe`.
  it('posts the caller`s action type verbatim through `recordAction`', async () => {
    await state().load('project-A')
    await expect(
      state().recordCapture('project-A', 'artifact-1', ACTION_TYPE, RECIPE, 'lowqc'),
    ).resolves.toBeUndefined()
    expect(recordAction).toHaveBeenCalledWith({
      project_id: 'project-A',
      input_artifact_id: 'artifact-1',
      action_type: 'subset.filter',
      recipe: RECIPE,
      label: 'lowqc',
    })
  })
})
