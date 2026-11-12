// THE OWNER'S BUG: creating a project does not make it appear in the left sidebar.
//
// ── What these cases pin, and why they are shaped like this ─────────────────────────
//
// The realtime channel is notify-and-refetch with SELF-ECHO SUPPRESSION: every mutating
// request carries `X-Sync-Connection-Id`, and the server's fan-out deliberately skips the
// connection that caused the change (`project/handlers.rs` passes `origin` on every emit
// aimed at the acting user). So a project created in tab A is broadcast to every other
// device and every other tab — and is invisible ONLY in tab A, the one place the user is
// looking.
//
// That was survivable for the store that performed the mutation (`Projects`, which
// reloaded itself inline) and fatal for every other consumer of the same fact. The sidebar
// rail is backed by a DIFFERENT store (`RecentProjects`) whose only refresh triggers are
// `sync:project` / `sync:reconnect`, so it never heard about the project the user had just
// created — until a reload.
//
// Every case below therefore asserts the OUTCOME on the NON-ACTING store: what the SIDEBAR
// holds after a mutation the PROJECTS-GRID store performed. An assertion that "an event was
// emitted" would pass against a mechanism that emits onto a key nobody listens to, and
// would have said nothing about the bug that was reported.
//
// The stores' real `init` wiring and the real EventBus run FOR REAL; the only boundary
// mocked is `ApiClient.Project.*` (a small in-memory backend) and the permission gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

// ── the fake backend ────────────────────────────────────────────────────────────────
/** Newest-first, mirroring the server's `ORDER BY created_at DESC`. */
let rows: ProjectDto[] = []
let seq = 0

function makeProject(name: string): ProjectDto {
  seq += 1
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString()
  return {
    id: `p-${seq}`,
    owner_id: 'owner-1',
    name,
    description: '',
    created_at: now,
    updated_at: now,
    effective_permission: 'owner',
    dataset_count: 0,
  } as ProjectDto
}

const list = vi.fn(
  async ({ page = 1, per_page = 20 }: { page?: number; per_page?: number; search?: string }) => {
    const start = (page - 1) * per_page
    return {
      projects: rows.slice(start, start + per_page),
      total: rows.length,
      page,
      per_page,
    }
  },
)
const create = vi.fn(async ({ name }: { name: string }) => {
  const p = makeProject(name)
  rows = [p, ...rows]
  return p
})
const update = vi.fn(async ({ id, name }: { id: string; name?: string }) => {
  const p = rows.find(r => r.id === id)
  if (p && name) p.name = name
  return p
})
const duplicate = vi.fn(async ({ id }: { id: string }) => {
  const src = rows.find(r => r.id === id)
  const copy = makeProject(`${src?.name ?? 'x'} (copy)`)
  rows = [copy, ...rows]
  return copy
})
const del = vi.fn(async ({ id }: { id: string }) => {
  rows = rows.filter(r => r.id !== id)
})
const attachDataset = vi.fn(async () => rows[0])
const listDatasets = vi.fn(async () => ({ datasets: [], total: 0, page: 1, per_page: 20 }))
let shareRows: { id: string; email: string }[] = []
const listShares = vi.fn(async () => ({ shares: shareRows }))
const createShare = vi.fn(async ({ id, email }: { id: string; email: string }) => {
  shareRows = [...shareRows, { id: `s-${shareRows.length + 1}`, email }]
  return {
    id: `s-${shareRows.length}`,
    project_id: id,
    owner_id: 'owner-1',
    recipient_id: 'u-2',
    permission_level: 'editor',
    status: 'accepted',
    created_at: '',
    updated_at: '',
  }
})
const revokeShare = vi.fn(async ({ id }: { id: string }) => {
  shareRows = shareRows.filter(s => s.id !== id)
})
const getProject = vi.fn(async ({ id }: { id: string }) => rows.find(r => r.id === id))
const createTransfer = vi.fn(async ({ id }: { id: string }) => ({
  id: 't-1',
  project_id: id,
  from_user_id: 'owner-1',
  to_user_id: 'u-2',
  status: 'pending',
  created_at: '',
  updated_at: '',
}))
const listMine = vi.fn(async () => ({ items: [], total: 0, page: 1, per_page: 20 }))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Project: {
      list: (...a: unknown[]) => list(...(a as [never])),
      create: (...a: unknown[]) => create(...(a as [never])),
      update: (...a: unknown[]) => update(...(a as [never])),
      duplicate: (...a: unknown[]) => duplicate(...(a as [never])),
      delete: (...a: unknown[]) => del(...(a as [never])),
      get: (...a: unknown[]) => getProject(...(a as [never])),
      listDatasets: () => listDatasets(),
      listShares: () => listShares(),
      createShare: (...a: unknown[]) => createShare(...(a as [never])),
      revokeShare: (...a: unknown[]) => revokeShare(...(a as [never])),
      attachDataset: () => attachDataset(),
      createTransfer: (...a: unknown[]) => createTransfer(...(a as [never])),
    },
    Dataset: { listMine: () => listMine() },
  },
}))

const { useEventBusStore } = await import('@txresbench/framework/events')
const { useProjectsStore } = await import('./Projects.store')
const { useRecentProjectsStore } = await import('./RecentProjects.store')
const { useProjectDetailStore } = await import('./ProjectDetail.store')

const grid = () => useProjectsStore.getState()
const sidebar = () => useRecentProjectsStore.getState()
const detail = () => useProjectDetailStore.getState()

/** The names the SIDEBAR rail is currently rendering — the surface the owner reported. */
const sidebarNames = () => sidebar().recentProjects.map(p => p.name)
/** The names the /projects GRID is rendering (the acting store — a positive control). */
const gridNames = () => grid().projects.map(p => p.name)

/** Record every `sync:*` frame emitted while `fn` runs (the wire-parity cases below). */
const WATCHED = ['sync:project', 'sync:project_share', 'sync:project_transfer', 'sync:dataset'] as const
async function capture<T>(fn: () => Promise<T>): Promise<{
  seen: { type: string; action: string; id: string }[]
  result: T
}> {
  const seen: { type: string; action: string; id: string }[] = []
  const bus = useEventBusStore.getState()
  const offs = WATCHED.map(type =>
    bus.on(type as never, ((e: { type: string; data: { action: string; id: string } }) => {
      seen.push({ type: e.type, action: e.data.action, id: e.data.id })
    }) as never),
  )
  try {
    const result = await fn()
    return { seen, result }
  } finally {
    for (const off of offs) off()
  }
}

beforeEach(async () => {
  rows = []
  shareRows = []
  seq = 0
  for (const m of [list, create, update, duplicate, del, attachDataset, listDatasets, listShares, createShare, revokeShare, getProject, createTransfer, listMine]) {
    m.mockClear()
  }
  useProjectsStore.setState({
    projects: [], total: 0, page: 1, search: '', loading: false, loadingMore: false,
    mutating: false, isInitialized: false, error: null, loadSeq: 0,
  })
  useRecentProjectsStore.setState({
    recentProjects: [], recentTotal: 0, recentPage: 1, recentHasMore: false,
    recentLoading: false, recentLoadingMore: false, recentInitialized: false,
    recentError: null, recentLoadSeq: 0,
  })
  useProjectDetailStore.setState({
    projectId: null, project: null, datasets: [], datasetsTotal: 0, datasetsPage: 1,
    shares: [], availableDatasets: [], loading: false, loadingMore: false,
    mutating: false, error: null,
  })
  // Wire the REAL `sync:*` subscriptions of all three stores (what a mounted page does).
  grid().__init__.__store__()
  sidebar().__init__.__store__()
  detail().__init__.__store__()
  // Both feeds do an initial load on init — let it settle so the counters below start clean.
  await vi.waitFor(() => {
    expect(grid().isInitialized).toBe(true)
    expect(sidebar().recentInitialized).toBe(true)
  })
})

afterEach(() => {
  grid().__destroy__()
  sidebar().__destroy__()
  detail().__destroy__()
})

describe('a local mutation reaches the surfaces it did not perform', () => {
  it('createProject puts the project in the SIDEBAR, with no reload', async () => {
    expect(sidebarNames()).not.toContain('Alpha')

    await grid().createProject({ name: 'Alpha', description: '' })

    // THE REPORTED OUTCOME: the sidebar rail — a different store — now holds it.
    await vi.waitFor(() => expect(sidebarNames()).toContain('Alpha'))
    // …and the acting store's own grid still updates (it now does so through the SAME
    // echo, so this is not a redundant assertion — it is what makes the echo
    // self-policing: drop it and the grid breaks too, loudly).
    await vi.waitFor(() => expect(gridNames()).toContain('Alpha'))
  })

  it('deleteProject removes it from the SIDEBAR, with no reload', async () => {
    const p = await grid().createProject({ name: 'Doomed', description: '' })
    await vi.waitFor(() => expect(sidebarNames()).toContain('Doomed'))

    await grid().deleteProject(p!.id)

    await vi.waitFor(() => expect(sidebarNames()).not.toContain('Doomed'))
  })

  it('updateProject renames it in the SIDEBAR, with no reload', async () => {
    const p = await grid().createProject({ name: 'Before', description: '' })
    await vi.waitFor(() => expect(sidebarNames()).toContain('Before'))

    await grid().updateProject(p!.id, { name: 'After', description: '' })

    await vi.waitFor(() => expect(sidebarNames()).toContain('After'))
    expect(sidebarNames()).not.toContain('Before')
  })

  it('duplicateProject puts the COPY in the SIDEBAR (the new id, not the source)', async () => {
    const p = await grid().createProject({ name: 'Source', description: '' })
    await vi.waitFor(() => expect(sidebarNames()).toContain('Source'))

    await grid().duplicateProject(p!.id)

    await vi.waitFor(() => expect(sidebarNames()).toContain('Source (copy)'))
  })

  it('attaching a dataset from the DATASETS library refreshes the open project detail', async () => {
    const p = await grid().createProject({ name: 'Target', description: '' })
    await detail().loadProject(p!.id)
    const before = getProject.mock.calls.length

    const { useDatasetsStore } = await import('@/modules/datasets/stores/Datasets.store')
    await useDatasetsStore.getState().attachToProject('ds-1', p!.id)

    // The detail store refetched the project it has open — the same reaction a SECOND
    // device already had. Before the fix `Datasets.attachToProject` refreshed nothing at
    // all, while its twin in `ProjectDetail.attachDataset` echoed correctly.
    await vi.waitFor(() => expect(getProject.mock.calls.length).toBeGreaterThan(before))
  })

  it('ProjectDetail.attachDataset reaches the SIDEBAR (dataset_count is shown there)', async () => {
    const p = await grid().createProject({ name: 'Attachy', description: '' })
    await detail().loadProject(p!.id)
    await vi.waitFor(() => expect(sidebarNames()).toContain('Attachy'))
    const before = list.mock.calls.length

    await detail().attachDataset('ds-1')

    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
  })

  it('ProjectDetail.attachDataset still refreshes the OPEN project itself', async () => {
    const p = await grid().createProject({ name: 'Attachy2', description: '' })
    await detail().loadProject(p!.id)
    const before = getProject.mock.calls.length

    await detail().attachDataset('ds-1')

    // The inline `loadProject` was removed in favour of the echo — the detail store's own
    // `sync:project` subscription (id-filtered) is what refetches now. If the echo were
    // dropped, the pane that performed the attach would go stale first.
    await vi.waitFor(() => expect(getProject.mock.calls.length).toBeGreaterThan(before))
  })

  it('createShare repopulates the detail pane`s OWN share list (via the echo)', async () => {
    const p = await grid().createProject({ name: 'Sharey', description: '' })
    await detail().loadProject(p!.id)
    expect(detail().shares).toHaveLength(0)

    await detail().createShare('friend@example.test', 'editor')

    // The inline `loadShares` was removed in favour of the echo: the pane that performed
    // the share is refreshed by its own `sync:project_share` subscription, exactly as a
    // second device is. Dropping the echo leaves the invite invisible to its author.
    await vi.waitFor(() => expect(detail().shares).toHaveLength(1))
  })

  it('revokeShare removes it from the detail pane`s OWN share list (via the echo)', async () => {
    const p = await grid().createProject({ name: 'Revokey', description: '' })
    await detail().loadProject(p!.id)
    await detail().createShare('friend@example.test', 'editor')
    await vi.waitFor(() => expect(detail().shares).toHaveLength(1))

    await detail().revokeShare('s-1')

    await vi.waitFor(() => expect(detail().shares).toHaveLength(0))
  })

  it('createTransfer reaches the projects feed (it previously refreshed nothing)', async () => {
    const p = await grid().createProject({ name: 'Handover', description: '' })
    await detail().loadProject(p!.id)
    const before = list.mock.calls.length

    await detail().createTransfer('someone@example.test')

    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
  })
})

// ── WIRE PARITY ─────────────────────────────────────────────────────────────────────
//
// The outcome cases above prove the sidebar refreshes. They do NOT pin WHICH frame was
// echoed, because today every `sync:project` subscriber reloads unconditionally — so an
// echo carrying the wrong `action`, or a duplicate carrying the SOURCE project's id
// instead of the COPY's, would still make them refetch and still look green.
//
// That latitude is not real. The whole mechanism rests on a subscriber being unable to
// tell a local echo from a remote frame, and `ProjectDetail` ALREADY discriminates on
// `id`. A frame that does not match what `project/handlers.rs` publishes is a frame that
// behaves differently local vs remote — the exact property being bought here. These cases
// pin the payload against the handler's publish list; they are a SUPPLEMENT to the outcome
// cases, never a substitute.
describe('the echoed frame matches what the server publishes to the actor', () => {
  it('createProject → project/create with the NEW id', async () => {
    const frames = await capture(async () => {
      const p = await grid().createProject({ name: 'Framed', description: '' })
      expect(p).toBeTruthy()
      return p!.id
    })
    expect(frames.seen).toEqual([{ type: 'sync:project', action: 'create', id: frames.result }])
  })

  it('updateProject → project/update with that id', async () => {
    const p = await grid().createProject({ name: 'U', description: '' })
    const frames = await capture(async () => {
      await grid().updateProject(p!.id, { name: 'U2', description: '' })
      return p!.id
    })
    expect(frames.seen).toEqual([{ type: 'sync:project', action: 'update', id: p!.id }])
  })

  it('deleteProject → project/delete with that id', async () => {
    const p = await grid().createProject({ name: 'D', description: '' })
    const frames = await capture(() => grid().deleteProject(p!.id))
    expect(frames.seen).toEqual([{ type: 'sync:project', action: 'delete', id: p!.id }])
  })

  it('duplicateProject → project/create with the COPY id, NOT the source id', async () => {
    const src = await grid().createProject({ name: 'Src', description: '' })
    const frames = await capture(() => grid().duplicateProject(src!.id))
    expect(frames.seen).toHaveLength(1)
    expect(frames.seen[0]).toMatchObject({ type: 'sync:project', action: 'create' })
    expect(frames.seen[0]!.id).not.toBe(src!.id)
    expect(rows[0]!.id).toBe(frames.seen[0]!.id) // the copy the backend just made
  })

  it('attach/detach → project/update for the OPEN project', async () => {
    const p = await grid().createProject({ name: 'A', description: '' })
    await detail().loadProject(p!.id)
    const frames = await capture(() => detail().attachDataset('ds-1'))
    expect(frames.seen).toEqual([{ type: 'sync:project', action: 'update', id: p!.id }])
  })

  it('createShare/revokeShare → project_share/create|delete with the SHARE id', async () => {
    const p = await grid().createProject({ name: 'S', description: '' })
    await detail().loadProject(p!.id)
    const made = await capture(() => detail().createShare('f@x.test', 'editor'))
    expect(made.seen).toEqual([{ type: 'sync:project_share', action: 'create', id: 's-1' }])
    const gone = await capture(() => detail().revokeShare('s-1'))
    expect(gone.seen).toEqual([{ type: 'sync:project_share', action: 'delete', id: 's-1' }])
  })

  it('createTransfer → project_transfer/create with the TRANSFER id (not the project id)', async () => {
    const p = await grid().createProject({ name: 'T', description: '' })
    await detail().loadProject(p!.id)
    const frames = await capture(() => detail().createTransfer('x@y.test'))
    expect(frames.seen).toEqual([{ type: 'sync:project_transfer', action: 'create', id: 't-1' }])
  })

  it('Datasets.attachToProject → project/update for the target project', async () => {
    const p = await grid().createProject({ name: 'DS', description: '' })
    const { useDatasetsStore } = await import('@/modules/datasets/stores/Datasets.store')
    const frames = await capture(() => useDatasetsStore.getState().attachToProject('ds-1', p!.id))
    expect(frames.seen).toEqual([{ type: 'sync:project', action: 'update', id: p!.id }])
  })
})

describe('the echo does not storm or loop', () => {
  it('one create = exactly ONE list refetch per interested store (no double-fetch)', async () => {
    const before = list.mock.calls.length

    await grid().createProject({ name: 'Once', description: '' })
    await vi.waitFor(() => expect(sidebarNames()).toContain('Once'))
    await vi.waitFor(() => expect(gridNames()).toContain('Once'))
    // Let any second wave land before counting.
    await new Promise(r => setTimeout(r, 50))

    // Two subscribing stores (grid + sidebar) → exactly two `Project.list` calls. Three
    // would mean the acting store kept a private inline reload ALONGSIDE the echo.
    expect(list.mock.calls.length - before).toBe(2)
  })

  it('the echo settles — it is not re-delivered to itself', async () => {
    await grid().createProject({ name: 'Settle', description: '' })
    await vi.waitFor(() => expect(sidebarNames()).toContain('Settle'))
    const after = list.mock.calls.length

    await new Promise(r => setTimeout(r, 100))

    // A self-re-broadcasting emit would keep the counter climbing forever.
    expect(list.mock.calls.length).toBe(after)
  })
})
