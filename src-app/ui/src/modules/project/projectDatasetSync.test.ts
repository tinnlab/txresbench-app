// The project page renders dataset rows but heard nothing about datasets.
//
// `ProjectDetail` subscribed to `sync:project`, `sync:project_share` and
// `sync:project_transfer` — the three entities that describe the project ENVELOPE. It
// renders the dataset ROWS inside it (name, type, processing status), and there was no
// `sync:dataset` subscription at all. Attaching or detaching publishes `Project`, so
// the LIST changed correctly; changing a dataset's own fields publishes `Dataset`, and
// nothing on this page was listening, so a rename performed anywhere else — the
// datasets page, another tab, another device, a collaborator — left the old name
// sitting in the project's list until a reload.
//
// The case below asserts the OUTCOME (the names the page is rendering) after a frame
// that arrives exactly as `core/sync/SyncClient` delivers a remote one.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Dataset, ProjectDto } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

let datasetRows: Dataset[] = []
const project: ProjectDto = {
  id: 'p-1',
  owner_id: 'owner-1',
  name: 'A project',
  description: '',
  created_at: '',
  updated_at: '',
  effective_permission: 'owner',
  dataset_count: 1,
} as unknown as ProjectDto

// Fresh clones on every read: a fake returning the SAME mutable row the store already
// holds would make "the page refreshed" unfalsifiable.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const getProject = vi.fn(async () => clone(project))
const listDatasets = vi.fn(async () => ({
  datasets: clone(datasetRows),
  total: datasetRows.length,
  page: 1,
  per_page: 20,
}))
const listShares = vi.fn(async () => ({ shares: [] }))
const listMine = vi.fn(async () => ({ items: [], total: 0, page: 1, per_page: 20 }))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Project: {
      get: () => getProject(),
      listDatasets: () => listDatasets(),
      listShares: () => listShares(),
    },
    Dataset: { listMine: () => listMine() },
  },
}))

const { EventBus } = await import('@txresbench/framework/stores')
const { useProjectDetailStore } = await import('./stores/ProjectDetail.store')

const detail = () => useProjectDetailStore.getState()
/** The dataset names the project page is rendering. */
const shownDatasetNames = () => detail().datasets.map(d => d.name)

beforeEach(async () => {
  datasetRows = [{ id: 'd-1', name: 'raw counts', owner_id: 'owner-1' } as unknown as Dataset]
  getProject.mockClear()
  listDatasets.mockClear()
  listShares.mockClear()
  listMine.mockClear()
  useProjectDetailStore.setState({
    projectId: null, project: null, datasets: [], datasetsTotal: 0, datasetsPage: 1,
    shares: [], availableDatasets: [], loading: false, loadingMore: false,
    mutating: false, error: null,
  })
  detail().__init__.__store__()
  await detail().loadProject('p-1')
  await vi.waitFor(() => expect(shownDatasetNames()).toEqual(['raw counts']))
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('re-reads its dataset rows when a dataset changes elsewhere', async () => {
  // Somebody renames the dataset on another surface. The server publishes
  // `Dataset`/`Update` to the dataset's audience; `SyncClient` re-emits it here.
  datasetRows = [{ id: 'd-1', name: 'raw counts (renamed)', owner_id: 'owner-1' } as unknown as Dataset]
  await EventBus.emit({ type: 'sync:dataset', data: { action: 'update', id: 'd-1' } } as never)

  await vi.waitFor(() => expect(shownDatasetNames()).toEqual(['raw counts (renamed)']))
})

it('ignores dataset frames when no project is open', async () => {
  // The page is not mounted on a project; a dataset frame must not fire a refetch of
  // nothing. (The store's `reloadCurrent` is a no-op without a `projectId`, and this
  // pins that the subscription does not reach around it.)
  useProjectDetailStore.setState({ projectId: null })
  const before = listDatasets.mock.calls.length
  await EventBus.emit({ type: 'sync:dataset', data: { action: 'update', id: 'd-1' } } as never)
  await new Promise(r => setTimeout(r, 20))
  expect(listDatasets.mock.calls.length).toBe(before)
})
