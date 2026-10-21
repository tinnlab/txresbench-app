// @vitest-environment jsdom
//
// The project's datasets panel held THREE server-derived reads in local `useState` with
// NO sync subscription at all:
//
//     ApiClient.Project.datasetSummary   deps [projectId, datasetsTotal]
//     ApiClient.Dataset.listShared       deps [projectId, canEdit]
//     ApiClient.Dataset.artifactSummaries deps [projectId, datasetsTotal]
//
// `datasetsTotal` is a COUNT off `ProjectDetail`. It moves when a dataset is attached or
// detached and at no other time, so it stands in for "the linked set changed" and for
// nothing else. Everything else that changes what this panel draws — a dataset renamed
// or shared elsewhere, a run producing artifacts for a linked dataset — leaves the count
// identical and the panel showing stale rows, in the acting tab AND on every other
// device. The panel is not on the sync channel, so this is not even the
// origin-suppression bug: NOTHING refreshes it, ever.
//
// The cases below mount the REAL panel and assert what a reader SEES change. Only the
// four network reads and the project-scope/action seams a unit mount cannot supply are
// faked; the real `holdingsFor`, the real preview registry and the real kit render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { EventBus } from '@ziee/framework/stores'
import type { DatasetArtifactSummary } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))
vi.mock('@/modules/project/context/ProjectScope', () => ({ useCanEdit: () => true }))
// `useAction`/`useAffordance` register this pane with the AI action engine; irrelevant
// here and they drag the whole engine in.
vi.mock('@/core/actions/useAction', () => ({ useAction: () => undefined }))
vi.mock('@/core/actions/affordances', () => ({
  useAffordance: () => ({ current: null }),
  getAffordance: () => undefined,
}))

let artifactRows: DatasetArtifactSummary[] = []
let sharedRows: { id: string; name: string; datatype: string }[] = []
let linkedCount = 1

const datasetSummary = vi.fn(async () => ({ dataset_count: linkedCount }))
const listShared = vi.fn(async () => ({ items: sharedRows.map(r => ({ ...r })), total: sharedRows.length, page: 1, per_page: 500 }))
const artifactSummaries = vi.fn(async () => ({ summaries: artifactRows.map(r => ({ ...r })) }))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Project: { datasetSummary: () => datasetSummary() },
    Dataset: {
      listShared: () => listShared(),
      artifactSummaries: () => artifactSummaries(),
    },
  },
}))

const { useProjectDetailStore } = await import('@/modules/project/stores/ProjectDetail.store')
const { DatasetsPanel } = await import('./DatasetsPanel')

const LINKED = { id: 'ds-1', name: 'Donor A', datatype: 'probe/matrix' }

beforeEach(() => {
  datasetSummary.mockClear()
  listShared.mockClear()
  artifactSummaries.mockClear()
  artifactRows = []
  sharedRows = []
  linkedCount = 1
  useProjectDetailStore.setState({
    projectId: 'p-1',
    project: { id: 'p-1', name: 'P' } as never,
    datasets: [LINKED] as never,
    datasetsTotal: 1,
    availableDatasets: [],
    shares: [],
    loading: false,
    loadingMore: false,
    mutating: false,
    error: null,
  })
})

afterEach(() => {
  cleanup()
})

/** Push a wire frame exactly as `SyncClient` re-emits one. */
const frame = (entity: 'dataset' | 'artifact', action: string, id: string) =>
  EventBus.emit({ type: `sync:${entity}`, data: { action, id } } as never)

describe('the project datasets panel is on the sync channel', () => {
  it('re-reads what each dataset HOLDS when an artifact frame arrives', async () => {
    render(<DatasetsPanel />)
    // The panel starts with no artifact summary for the linked dataset, so no holdings
    // line is drawn at all.
    await waitFor(() => expect(artifactSummaries).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('project-dataset-holdings-ds-1')).toBeNull()

    // A run finishes and ingests outputs for that dataset. The server publishes
    // `Artifact`/`Create` (`workstore/ingest.rs:198`, `origin: None` — it reaches every
    // device), and the panel must re-read.
    artifactRows = [
      {
        dataset_id: 'ds-1',
        artifact_count: 3,
        total_logical_bytes: 2048,
        groups: [{ datatype: 'probe/matrix', count: 3, logical_bytes: 2048 }],
      } as DatasetArtifactSummary,
    ]
    await frame('artifact', 'create', 'a-1')

    // THE OUTCOME a reader sees: the holdings line appears, with no reload and no
    // attach/detach to move `datasetsTotal`.
    await waitFor(() => expect(screen.getByTestId('project-dataset-holdings-ds-1')).toBeTruthy())
  })

  it('re-reads the linked-dataset COUNT on a dataset frame, without an attach', async () => {
    render(<DatasetsPanel />)
    await waitFor(() => expect(screen.getByTestId('project-datasets-summary').textContent).toContain('1 dataset'))

    // A collaborator (or this user on another device) links a second dataset. The count
    // is a SERVER read; `datasetsTotal` in this tab has not moved yet.
    linkedCount = 2
    await frame('dataset', 'update', 'ds-2')

    await waitFor(() =>
      expect(screen.getByTestId('project-datasets-summary').textContent).toContain('2 datasets'),
    )
  })

  it('re-reads the SHARED-with-me picker source on a dataset frame', async () => {
    render(<DatasetsPanel />)
    await waitFor(() => expect(listShared).toHaveBeenCalledTimes(1))

    // Someone shares a dataset with this user. `listShared` was fetched ONCE per project
    // and never again, so the picker could not offer it until a reload.
    sharedRows = [{ id: 'ds-9', name: 'Donor Z', datatype: 'probe/matrix' }]
    await frame('dataset', 'update', 'ds-9')

    await waitFor(() => expect(listShared).toHaveBeenCalledTimes(2))
  })

  it('coalesces a burst of frames into ONE re-read per source', async () => {
    render(<DatasetsPanel />)
    await waitFor(() => expect(artifactSummaries).toHaveBeenCalledTimes(1))

    // One run ingesting N artifacts publishes N frames (`ingest.rs` emits inside the
    // insert loop). Each must not cost the panel three requests.
    for (let i = 0; i < 5; i++) await frame('artifact', 'create', `a-${i}`)
    await new Promise(r => setTimeout(r, 300))

    expect(artifactSummaries).toHaveBeenCalledTimes(2)
    expect(datasetSummary).toHaveBeenCalledTimes(2)
  })
})
