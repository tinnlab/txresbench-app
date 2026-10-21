// @vitest-environment jsdom
//
// The workbench must learn that THE PROJECT'S ARTIFACT SET CHANGED from the realtime
// `sync:` channel — from whatever caused the change, including another device — with no
// mutation site opting in.
//
// ── Why this file exists ─────────────────────────────────────────────────────────────
//
// `catalogEpoch` was advanced ONLY by hand-maintained `refreshCatalog()` call sites (three
// of them: the run-complete hook, the delete-artifact button, the run panel). Every future
// mutation had to remember to add a fourth, and the one that forgot produced a stale input
// picker with NO error — the reported symptom: attach or detach a dataset and every
// `artifact_ref` picker keeps offering the old list. Attach/detach never called it, so the
// project's artifact set changed (the workbench catalog SQL unions `project_id = $1` with
// the artifacts of the project's ATTACHED datasets) while the pickers showed the old rows.
//
// The fix is not a fourth call site. It is that the epoch is DERIVED from the sync channel,
// which the server already publishes on: attach/detach emit `SyncEntity::Project`/`Update`
// to the project audience, ingest + artifact-delete emit `SyncEntity::Artifact`, and dataset
// delete/split emit `SyncEntity::Dataset`/`Delete` (its artifacts leave every attached
// project's catalog by FK cascade). One subscription, four entity keys, no opt-in.
//
// The cases below drive the REAL `WorkbenchProvider` and the REAL `useArtifactCatalog`
// (the hook the declarative pickers read through) over a REAL EventBus, emitting the exact
// frames the SyncClient re-emits. Only what jsdom cannot supply is faked: the `data`
// capability's backend, the datatype lattice, and the permission gate.

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createCapabilityBroker } from '../capabilities/broker'
import type { ArtifactRow, WorkbenchAPI } from '@/modules/workbench/core'

/** Toggleable permission gate — the subscription must SELF-GATE on the read-perm of the
 *  endpoint it refetches through (`projects::use`, the catalog handler's
 *  `RequirePermissions<(ProjectsUse,)>`), because `sync:reconnect` fires for every
 *  subscriber regardless of audience. */
let permitted = true
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => permitted }))

// The provider pulls its lattice from the host-wiring module, which drags the whole
// extensions layer (deck.gl, the kit) in with it. Only the lattice is under test here.
vi.mock('../host/createHost', async () => {
  const m = await import('../datatypes/lattice')
  return { workbenchLattice: m.identityLattice }
})

/** The rows the faked `data` capability serves — MUTABLE, so a case can change the
 *  project's artifact set exactly as a real attach/detach/ingest would, then assert the
 *  workbench re-read it. */
let rows: ArtifactRow[] = []
/** How many times the catalog was actually READ — the coalescing assertion's subject. */
let catalogReads = 0

const broker = createCapabilityBroker()
broker.publish('data', '1.0.0', {
  catalog: async () => {
    catalogReads++
    return { project_id: 'p1', axes: [], artifacts: rows }
  },
  artifacts: { query: async () => rows },
} as never)

const api = { capabilities: broker } as unknown as WorkbenchAPI

const { WorkbenchProvider, useWorkbench } = await import('./WorkbenchContext')
const { useArtifactCatalog } = await import('../render/useArtifactCatalog')
const { EventBus } = await import('@ziee/framework/stores')

function row(id: string): ArtifactRow {
  return { id, project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' }
}

/** The picker's-eye view: the rows a declarative `artifact_ref` control would offer. */
function Probe() {
  const { api: a, catalogEpoch } = useWorkbench()
  const catalog = useArtifactCatalog(a, catalogEpoch)
  return <div data-testid="rows">{catalog.map(r => r.id).join(',')}</div>
}

function mount(projectId = 'p1') {
  return render(
    <WorkbenchProvider api={api} projectId={projectId} viewId="v1" canEdit>
      <Probe />
    </WorkbenchProvider>,
  )
}

const shown = () => screen.getByTestId('rows').textContent

beforeEach(() => {
  permitted = true
  rows = [row('art-1')]
  catalogReads = 0
})
afterEach(cleanup)

describe('the workbench derives its catalog epoch from the sync channel', () => {
  it('refetches on sync:project for THIS project (attach/detach from another device)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    // A dataset was attached elsewhere: the project's artifact set grew.
    rows = [row('art-1'), row('art-2')]
    await EventBus.emit({ type: 'sync:project', data: { action: 'update', id: 'p1' } })
    await waitFor(() => expect(shown()).toBe('art-1,art-2'))
  })

  it('IGNORES sync:project for a different project (the negative control)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    const before = catalogReads
    rows = [row('art-1'), row('art-2')]
    await EventBus.emit({ type: 'sync:project', data: { action: 'update', id: 'other-project' } })
    // Give any (wrongly) scheduled refetch more than the coalesce window to land.
    await new Promise(r => setTimeout(r, 300))
    expect(shown()).toBe('art-1')
    expect(catalogReads).toBe(before)
  })

  it('refetches on sync:artifact (a run ingested outputs / an artifact was deleted)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    rows = []
    await EventBus.emit({ type: 'sync:artifact', data: { action: 'delete', id: 'art-1' } })
    await waitFor(() => expect(shown()).toBe(''))
  })

  it('refetches on sync:dataset (a dataset delete cascades its artifacts out of the project)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    rows = []
    await EventBus.emit({ type: 'sync:dataset', data: { action: 'delete', id: 'ds-1' } })
    await waitFor(() => expect(shown()).toBe(''))
  })

  it('refetches on sync:reconnect (frames missed while the stream was down)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    rows = [row('art-1'), row('art-2')]
    await EventBus.emit({ type: 'sync:reconnect', data: {} })
    await waitFor(() => expect(shown()).toBe('art-1,art-2'))
  })

  it('SELF-GATES on the refetch endpoint read-perm (no 403 storm on reconnect)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    permitted = false
    const before = catalogReads
    rows = [row('art-1'), row('art-2')]
    await EventBus.emit({ type: 'sync:reconnect', data: {} })
    await new Promise(r => setTimeout(r, 300))
    expect(catalogReads).toBe(before)
  })

  it('COALESCES a burst of frames into one refetch (a run ingesting N artifacts)', async () => {
    mount()
    await waitFor(() => expect(shown()).toBe('art-1'))
    const before = catalogReads
    rows = [row('art-1'), row('art-2')]
    for (let i = 0; i < 8; i++) {
      await EventBus.emit({ type: 'sync:artifact', data: { action: 'create', id: `art-${i}` } })
    }
    await waitFor(() => expect(shown()).toBe('art-1,art-2'))
    await new Promise(r => setTimeout(r, 300))
    // ONE epoch bump ⇒ the provider's produced-types read + the pane's catalog read, and
    // nothing per-frame. Eight frames must not become eight round trips.
    expect(catalogReads - before).toBeLessThanOrEqual(2)
  })
})
