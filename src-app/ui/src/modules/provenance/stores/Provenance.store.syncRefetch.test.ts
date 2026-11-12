// R3-51 — a BACKGROUND sync refetch must not destroy the capture-failure banner.
//
// `load()` clears `captureError` + `lastCapture` (F2-34, so a project-A failure can't
// accuse project B). But `init` wires `sync:provenance` / `sync:reconnect` →
// `reloadCurrent()` → `load(sameProjectId)`, so ANY background sync tick silently
// erased the "the last committed selection was NOT recorded" warning AND its only
// remediation (the retained `lastCapture` that `retryCapture` re-posts). The pane then
// rendered an unqualified readiness badge — telling the user everything is reproducible
// while their selection was never recorded. That is precisely the class of false
// reproducibility claim this whole surface exists to prevent.
//
// The contract these cases pin: capture state clears ONLY on (a) a genuine project
// switch, (b) a successful capture, (c) an explicit user dismiss — never on a
// same-project refetch, whoever triggered it.
//
// ── R4C-01/02 (round 4b): these cases MUST follow production's ordering ────────────
//
// The round-4 fix keyed "is this a project switch?" on the PREVIOUSLY-LOADED
// `state.projectId`, and the round-4 cases each pre-`load()`ed the project BEFORE
// driving the capture to failure. That ordering does not exist in production. The
// real sequence is:
//
//   1. the user saves a filter in the workbench. `provenance.record-selection`
//      (actions.ts) calls `Provenance.recordCapture(project_id, …)`
//      DIRECTLY — it never loads the store first, and `recordCapture` does not
//      set `projectId`. So on a capture failure `state.projectId` is still `null`
//      whenever the Provenance pane has not been opened this session.
//   2. the user opens the Provenance pane to find out WHY the save complained.
//      `ProvenancePane`'s mount effect calls `load(projectId)` — the FIRST load.
//
// With the guard keyed on the previous `projectId`, step 2 read `null !== 'project-A'`
// as a project SWITCH and destroyed the very banner the user opened the pane to read,
// plus the `lastCapture` behind "Record it again". Every case below therefore starts
// from a capture failure with NO prior load, and the guard is keyed on the project the
// CAPTURE ITSELF was for (`lastCapture.projectId`) — the only fact that can decide
// whether a banner belongs to the project now being loaded.
//
// vitest (node env); the only boundaries mocked are `ApiClient.Provenance.*` and the
// permission gate. The EventBus + the store's own `init` wiring run FOR REAL — the
// cases below emit the actual `sync:*` events the SyncClient emits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { useEventBusStore } = await import('@txresbench/framework/events')
const { useProvenanceStore } = await import('./Provenance.store')
const state = () => useProvenanceStore.getState()

/** Emit the real `sync:*` frame the SyncClient emits, then drain the fire-and-forget
 *  `void actions.reloadCurrent()` the store's handler starts. */
async function emitSync(type: 'sync:provenance' | 'sync:reconnect') {
  const before = runs.mock.calls.length
  await useEventBusStore.getState().emit({ type, data: {} } as never)
  await vi.waitFor(() => expect(runs.mock.calls.length).toBeGreaterThan(before))
  // …and let the trailing `set({ loading: false, … })` land.
  await Promise.resolve()
  await Promise.resolve()
}

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
  // Wire the real `sync:provenance` / `sync:reconnect` listeners.
  state().__init__.__store__()
})

afterEach(() => {
  state().__destroy__()
})

/** The live capture contract: the `subset.filter` action type + the flat criteria recipe
 *  the save path posts (`provenance.record-selection` → `recordCapture`). */
const ACTION_TYPE = 'subset.filter'
const RECIPE = { criteria: [{ column: 'pct_mito', max: '10' }] }

/** Drive a capture to failure — the state every case below starts from.
 *
 *  Deliberately does NOT `load()` first: in production the save path
 *  (`provenance.record-selection` → `Provenance.recordCapture`) runs with the
 *  store at its boot state, `projectId === null`. Pre-loading here is what made the
 *  round-4 cases pass vacuously. */
async function failedCapture(projectId = 'project-A') {
  expect(state().projectId, 'a capture happens BEFORE any pane load in production').toBeNull()
  recordAction.mockRejectedValueOnce(new Error('403 forbidden'))
  await expect(
    state().recordCapture(projectId, 'artifact-1', ACTION_TYPE, RECIPE, 'lowqc'),
  ).rejects.toThrow('403 forbidden')
  expect(state().captureError).toBe('403 forbidden')
}

describe('Provenance capture state vs a background sync refetch (R3-51 / R4C-01)', () => {
  // ── THE DOMINANT PRODUCTION PATH (R4C-01) ───────────────────────────────────────
  // Save → capture fails → the user opens the Provenance pane to read why. That pane
  // mount is the FIRST `load()`, with `projectId` still null. If it clears, the user is
  // shown a pane with no warning and no retry over a run that was never recorded.
  it('the FIRST pane load after a capture failure keeps the banner AND its retry', async () => {
    await failedCapture('project-A')
    expect(state().projectId, 'no pane load has happened yet').toBeNull()

    await state().load('project-A') // ← ProvenancePane's mount effect

    expect(state().projectId).toBe('project-A')
    expect(state().captureError).toBe('403 forbidden')
    expect(state().lastCapture).toMatchObject({
      projectId: 'project-A',
      inputArtifactId: 'artifact-1',
      actionType: ACTION_TYPE,
      label: 'lowqc',
    })
  })

  it('…and `retryCapture` still has a real recipe to re-post after that first load', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    recordAction.mockResolvedValueOnce({})
    await expect(state().retryCapture()).resolves.toBe(true)
    // The retry genuinely re-posted the RETAINED attempt, not an empty shell.
    expect(recordAction).toHaveBeenLastCalledWith({
      project_id: 'project-A',
      input_artifact_id: 'artifact-1',
      action_type: ACTION_TYPE,
      recipe: RECIPE,
      label: 'lowqc',
    })
    expect(state().captureError).toBeNull()
  })

  it('survives a `sync:provenance` tick — banner AND its retry stay', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    await emitSync('sync:provenance')

    expect(state().captureError).toBe('403 forbidden')
    expect(state().lastCapture).toMatchObject({
      projectId: 'project-A',
      inputArtifactId: 'artifact-1',
      label: 'lowqc',
    })
  })

  it('survives a `sync:reconnect` resync (fired for EVERY store on reconnect)', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    await emitSync('sync:reconnect')

    expect(state().captureError).toBe('403 forbidden')
    expect(state().lastCapture).not.toBeNull()
  })

  it('survives the pane`s own load-error "Try again" (`reloadCurrent`, same project)', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    await state().reloadCurrent()

    expect(state().captureError).toBe('403 forbidden')
    expect(state().lastCapture).not.toBeNull()
  })

  it('survives a same-project re-`load()` (a pane remount is not an acknowledgement)', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    await state().load('project-A')

    expect(state().captureError).toBe('403 forbidden')
    expect(state().lastCapture).not.toBeNull()
  })

  // ── The guards against over-fixing: F2-34 must still hold, on BOTH orderings ─────
  //
  // A naive "never clear on the first load" patch would pass every case above and
  // regress this one — the project-A banner would be rendered over project B's graph,
  // accusing B of holding an unrecorded run.
  it('a capture failure for A is DROPPED when the first load is project B (F2-34)', async () => {
    await failedCapture('project-A')
    expect(state().projectId).toBeNull()

    await state().load('project-B') // the user opens a DIFFERENT project's pane first

    expect(state().projectId).toBe('project-B')
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  it('STILL clears on a genuine project switch after a load (F2-34 is not regressed)', async () => {
    await failedCapture('project-A')
    await state().load('project-A')

    await state().load('project-B')

    expect(state().projectId).toBe('project-B')
    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  // …and the two legitimate clearers keep working through a sync tick.
  it('a sync tick after a successful RETRY leaves the banner down', async () => {
    await failedCapture('project-A')
    await state().load('project-A')
    recordAction.mockResolvedValueOnce({})
    await expect(state().retryCapture()).resolves.toBe(true)
    expect(state().captureError).toBeNull()

    await emitSync('sync:provenance')

    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })

  it('a sync tick after an explicit DISMISS does not resurrect the banner', async () => {
    await failedCapture('project-A')
    await state().load('project-A')
    state().clearCaptureError()

    await emitSync('sync:provenance')

    expect(state().captureError).toBeNull()
    expect(state().lastCapture).toBeNull()
  })
})
