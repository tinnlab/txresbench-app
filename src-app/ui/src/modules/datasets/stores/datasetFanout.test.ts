// The DATASET lane's half of the self-echo-suppression hole `localEcho.ts` documents.
//
// ── The mechanism, restated so these cases can be read on their own ─────────────────
//
// Every mutating request carries `X-Sync-Connection-Id`, and the server's fan-out
// deliberately SKIPS the connection that caused the change. So the acting tab is the ONE
// client that never hears about its own mutation, and any store that displays the result
// of a mutation performed by a DIFFERENT store goes stale until a reload.
//
// `c4ce3b4e` fixed that for the PROJECT lane. The dataset lane was left with the same
// shape: `Datasets` (the library grid) privately reloaded ITSELF after every mutation,
// which is exactly the compensation that hides a missing echo from its author — the grid
// looked right, so nothing pointed at `DatasetDetail` (the open dataset page) or at the
// workbench's `useCatalogInvalidation`, both of which listen for `sync:dataset` and
// therefore heard NOTHING.
//
// ── What each case asserts ──────────────────────────────────────────────────────────
//
// The OUTCOME cases assert state on the NON-ACTING store — what `DatasetDetail` holds
// after a mutation the `Datasets` grid performed, and vice versa. An "an event was
// emitted" assertion would pass against a mechanism emitting onto a key nobody listens
// to, and would say nothing about the reported class of bug.
//
// The WIRE-PARITY block then pins each echoed frame against the publish list in
// `src-app/server/src/modules/dataset/routes.rs`, because every `sync:dataset` subscriber
// currently reloads unconditionally — so a frame carrying the wrong `action`, or the
// SOURCE id where the handler publishes the NEW id, would still make them refetch and
// still look green.
//
// The stores' real `init` wiring and the real EventBus run FOR REAL; the only boundary
// mocked is `ApiClient.Dataset.*` (a small in-memory backend) and the permission gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dataset } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

// ── the fake backend ────────────────────────────────────────────────────────────────
let rows: Dataset[] = []
let folders: { id: string; name: string }[] = []
let seq = 0

function makeDataset(name: string): Dataset {
  seq += 1
  return {
    id: `ds-${seq}`,
    owner_id: 'owner-1',
    name,
    datatype: 'tabular',
    created_at: '',
    updated_at: '',
  } as Dataset
}

// Every read hands back a COPY, exactly as a real HTTP response does. Returning the
// stored object would let a mutation appear on a surface that never refetched (the
// detail page and the grid would share one object), and every case below would pass
// against a store that refreshes nothing at all.
const page = <T,>(items: T[]) => ({
  items: items.map(i => ({ ...i })),
  total: items.length,
  page: 1,
  per_page: 20,
})

const listMine = vi.fn(async () => page(rows))
const listShared = vi.fn(async () => page([] as Dataset[]))
// `listFolders` / `listFolderDatasets` return BARE ARRAYS on the wire, not a page —
// mirroring `'Dataset.listFolders': DatasetFolder[]` in `api-client/types.ts`.
const listFolders = vi.fn(async () => folders.map(f => ({ ...f })))
const listFolderDatasets = vi.fn(async () => [] as Dataset[])
const getDataset = vi.fn(async ({ id }: { id: string }) => {
  const row = rows.find(r => r.id === id)
  return row ? { ...row } : undefined
})
const createDataset = vi.fn(async ({ name }: { name: string }) => {
  const d = makeDataset(name)
  rows = [d, ...rows]
  return d
})
const deleteDataset = vi.fn(async ({ id }: { id: string }) => {
  rows = rows.filter(r => r.id !== id)
})
const renameDataset = vi.fn(async ({ id, name }: { id: string; name: string }) => {
  const d = rows.find(r => r.id === id)
  if (d) d.name = name
  return d
})
const shareDataset = vi.fn(async () => ({ id: 'sh-1' }))
const unshareDataset = vi.fn(async () => undefined)
const listShares = vi.fn(async () => [] as unknown[])
const upload = vi.fn(async () => {
  const a = makeDataset('Uploaded A')
  const b = makeDataset('Uploaded B')
  rows = [a, b, ...rows]
  return { datasets: [a, b] }
})
const promote = vi.fn(async ({ name }: { name?: string }) => {
  const d = makeDataset(name ?? 'Promoted')
  rows = [d, ...rows]
  return d
})
const addSupportingFile = vi.fn(async () => ({ file_id: 'f-1' }))
const createFolder = vi.fn(async ({ name }: { name: string }) => {
  const f = { id: `fo-${folders.length + 1}`, name }
  folders = [...folders, f]
  return f
})
const renameFolder = vi.fn(async ({ id, name }: { id: string; name: string }) => {
  const f = folders.find(x => x.id === id)
  if (f) f.name = name
  return f
})
const deleteFolder = vi.fn(async ({ id }: { id: string }) => {
  folders = folders.filter(f => f.id !== id)
})
const addToFolder = vi.fn(async () => undefined)
const removeFromFolder = vi.fn(async () => undefined)
const listDatatypes = vi.fn(async () => [])

vi.mock('@/api-client', () => ({
  ApiClient: {
    Dataset: {
      listMine: () => listMine(),
      listShared: () => listShared(),
      listFolders: () => listFolders(),
      listFolderDatasets: () => listFolderDatasets(),
      get: (...a: unknown[]) => getDataset(...(a as [never])),
      create: (...a: unknown[]) => createDataset(...(a as [never])),
      delete: (...a: unknown[]) => deleteDataset(...(a as [never])),
      rename: (...a: unknown[]) => renameDataset(...(a as [never])),
      share: () => shareDataset(),
      unshare: () => unshareDataset(),
      listShares: () => listShares(),
      upload: () => upload(),
      promote: (...a: unknown[]) => promote(...(a as [never])),
      addSupportingFile: () => addSupportingFile(),
      createFolder: (...a: unknown[]) => createFolder(...(a as [never])),
      renameFolder: (...a: unknown[]) => renameFolder(...(a as [never])),
      deleteFolder: (...a: unknown[]) => deleteFolder(...(a as [never])),
      addToFolder: () => addToFolder(),
      removeFromFolder: () => removeFromFolder(),
    },
    Datatype: { list: () => listDatatypes() },
    Provenance: { forward: async () => ({}) },
  },
}))

const { useEventBusStore } = await import('@ziee/framework/events')
const { useDatasetsStore } = await import('./Datasets.store')
const { useDatasetDetailStore } = await import('./DatasetDetail.store')

const library = () => useDatasetsStore.getState()
const detail = () => useDatasetDetailStore.getState()

/** The names the LIBRARY grid is rendering. */
const libraryNames = () => library().items.map(d => d.name)
/** The dataset the DETAIL page has open — the surface the library never named. */
const openDetailName = () => detail().dataset?.name
/** How many FULL `Datasets.load()` passes have run. `listFolders` is called exactly
 *  once per full load (and by nothing else), so it counts loads without having to know
 *  how many `listMine` requests one load fans into. */
const libraryLoads = () => listFolders.mock.calls.length

/** Record every `sync:*` frame emitted while `fn` runs (the wire-parity cases below). */
const WATCHED = ['sync:dataset', 'sync:dataset_folder'] as const
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
  folders = []
  seq = 0
  for (const m of [
    listMine, listShared, listFolders, listFolderDatasets, getDataset, createDataset,
    deleteDataset, renameDataset, shareDataset, unshareDataset, listShares, upload,
    promote, addSupportingFile, createFolder, renameFolder, deleteFolder, addToFolder,
    removeFromFolder, listDatatypes,
  ]) {
    m.mockClear()
  }
  useDatasetsStore.setState({
    items: [], total: 0, page: 1, pageSize: 20, search: '', tab: 'mine',
    activeFolderId: null, folders: [], folderMembers: {}, recent: [],
    mineTotal: 0, sharedTotal: 0, loading: false, isInitialized: false, error: null,
    mutating: false, uploading: false, uploadOpen: false, uploadPct: 0, uploadError: null,
    shareTarget: null, shares: [], sharesLoading: false, attachTarget: null,
    folderCreateOpen: false,
  })
  useDatasetDetailStore.setState({ dataset: null, error: null, tab: 'contents' })
  // Wire the REAL `sync:*` subscriptions of both stores (what a mounted page does).
  library().__init__.__store__()
  detail().__init__.__store__()
  await vi.waitFor(() => expect(library().isInitialized).toBe(true))
})

afterEach(() => {
  library().__destroy__()
  detail().__destroy__()
})

/** Open a dataset in the DETAIL store — the non-acting surface most cases assert on. */
async function openDetail(id: string): Promise<void> {
  await detail().loadDataset(id)
  await vi.waitFor(() => expect(detail().dataset?.id).toBe(id))
}

describe('a dataset mutation reaches the surfaces it did not perform', () => {
  it('renameDataset renames it on the OPEN DETAIL PAGE, with no reload', async () => {
    const d = await library().createDataset({ name: 'Before' })
    await openDetail(d!.id)
    expect(openDetailName()).toBe('Before')

    await library().renameDataset(d!.id, 'After')

    // THE OUTCOME: the detail page — a different store — now shows the new name. Before
    // the fix `Datasets.renameDataset` privately reloaded its own grid and nothing else.
    await vi.waitFor(() => expect(openDetailName()).toBe('After'))
    // …and the acting store's own grid still updates, now through the SAME echo. This is
    // what makes the mechanism self-policing: drop the echo and the grid breaks too.
    await vi.waitFor(() => expect(libraryNames()).toContain('After'))
  })

  it('deleteDataset reaches the workbench catalog channel the acting tab shares', async () => {
    const d = await library().createDataset({ name: 'Doomed' })
    await openDetail(d!.id)
    const before = getDataset.mock.calls.length

    await library().deleteDataset(d!.id)

    // `useCatalogInvalidation.ts:30-33` names this exact case: deleting a dataset drops
    // its artifacts from every project it was attached to, and that path publishes ONLY
    // `Dataset`/`Delete`. A `sync:dataset` subscriber (here, the open detail page) must
    // react in the acting tab too.
    await vi.waitFor(() => expect(getDataset.mock.calls.length).toBeGreaterThan(before))
    await vi.waitFor(() => expect(libraryNames()).not.toContain('Doomed'))
  })

  it('createDataset reaches the detail-page channel (the frame the fan-out withheld)', async () => {
    const first = await library().createDataset({ name: 'Anchor' })
    await openDetail(first!.id)
    const before = getDataset.mock.calls.length

    await library().createDataset({ name: 'Second' })

    await vi.waitFor(() => expect(getDataset.mock.calls.length).toBeGreaterThan(before))
    await vi.waitFor(() => expect(libraryNames()).toContain('Second'))
  })

  it('shareDataset / unshareDataset reach the detail-page channel', async () => {
    const d = await library().createDataset({ name: 'Shared' })
    await openDetail(d!.id)

    const beforeShare = getDataset.mock.calls.length
    await library().shareDataset(d!.id, { principal_type: 'user', principal_id: 'u-2', role: 'view' } as never)
    await vi.waitFor(() => expect(getDataset.mock.calls.length).toBeGreaterThan(beforeShare))

    const beforeUnshare = getDataset.mock.calls.length
    await library().unshareDataset(d!.id, 'sh-1')
    await vi.waitFor(() => expect(getDataset.mock.calls.length).toBeGreaterThan(beforeUnshare))
  })

  it('DatasetDetail.promote puts the NEW dataset in the LIBRARY (it refreshed nothing)', async () => {
    const anchor = await library().createDataset({ name: 'Anchor' })
    await openDetail(anchor!.id)
    expect(libraryNames()).not.toContain('Promoted')

    await detail().promote('artifact-1')

    // `promote` previously did NOT refresh a single surface — not even its own. The
    // dataset the user just created out of a run artifact was invisible in the acting
    // tab's library until a reload, while every other device showed it immediately.
    await vi.waitFor(() => expect(libraryNames()).toContain('Promoted'))
  })

  it('DatasetDetail.addSupportingFile reaches the LIBRARY grid', async () => {
    const d = await library().createDataset({ name: 'Supported' })
    await openDetail(d!.id)
    const before = libraryLoads()

    await detail().addSupportingFile(d!.id, { file: new File([''], 'a.csv'), axis: 'axis-1' })

    // The library row's status/badge for that dataset comes from `Dataset.listMine`; the
    // detail pane's private `loadDataset` never refreshed it.
    await vi.waitFor(() => expect(libraryLoads()).toBeGreaterThan(before))
  })

  it('DatasetDetail.addSupportingFile still refreshes the OPEN dataset itself', async () => {
    const d = await library().createDataset({ name: 'Supported2' })
    await openDetail(d!.id)
    const before = getDataset.mock.calls.length

    await detail().addSupportingFile(d!.id, { file: new File([''], 'a.csv'), axis: 'axis-1' })

    // The inline `loadDataset` was removed in favour of the echo — this store's own
    // `sync:dataset` subscription is the refresh path now. Dropping the echo breaks the
    // pane that performed the upload FIRST, which is the point.
    await vi.waitFor(() => expect(getDataset.mock.calls.length).toBeGreaterThan(before))
  })

  it('uploadFiles puts every created dataset in the grid via the echo', async () => {
    await library().uploadFiles([new File([''], 'a.csv')])

    await vi.waitFor(() => expect(libraryNames()).toContain('Uploaded A'))
    expect(libraryNames()).toContain('Uploaded B')
  })

  it('folder create / rename / delete refresh the grid via the echo', async () => {
    await library().createFolder('Inbox')
    await vi.waitFor(() => expect(library().folders.map(f => f.name)).toContain('Inbox'))

    await library().renameFolder('fo-1', 'Archive')
    await vi.waitFor(() => expect(library().folders.map(f => f.name)).toContain('Archive'))

    await library().deleteFolder('fo-1')
    await vi.waitFor(() => expect(library().folders).toHaveLength(0))
  })
})

// ── WIRE PARITY ─────────────────────────────────────────────────────────────────────
//
// The outcome cases prove a refetch happens. They do NOT pin WHICH frame was echoed,
// because every `sync:dataset` subscriber reloads unconditionally today — so an echo
// carrying the wrong `action`, or the SOURCE dataset's id where the handler publishes
// the NEW one, would still look green. The whole mechanism rests on a subscriber being
// unable to tell a local echo from a remote frame, so these cases pin each payload
// against `dataset/routes.rs`'s publish list.
describe('the echoed frame matches what dataset/routes.rs publishes to the actor', () => {
  it('createDataset → dataset/create with the NEW id (routes.rs:396)', async () => {
    const f = await capture(async () => (await library().createDataset({ name: 'F' }))!.id)
    expect(f.seen).toEqual([{ type: 'sync:dataset', action: 'create', id: f.result }])
  })

  it('renameDataset → dataset/update with that id (routes.rs:465)', async () => {
    const d = await library().createDataset({ name: 'R' })
    const f = await capture(() => library().renameDataset(d!.id, 'R2'))
    expect(f.seen).toEqual([{ type: 'sync:dataset', action: 'update', id: d!.id }])
  })

  it('deleteDataset → dataset/delete with that id (routes.rs:493)', async () => {
    const d = await library().createDataset({ name: 'D' })
    const f = await capture(() => library().deleteDataset(d!.id))
    expect(f.seen).toEqual([{ type: 'sync:dataset', action: 'delete', id: d!.id }])
  })

  it('share/unshare → dataset/update, NOT a share-scoped frame (routes.rs:555,582)', async () => {
    // There is no `DatasetShare` sync entity: the server tells everyone the DATASET
    // changed. An echo inventing one would be a frame no server ever sends.
    const d = await library().createDataset({ name: 'S' })
    const shared = await capture(() =>
      library().shareDataset(d!.id, { principal_type: 'user', principal_id: 'u-2', role: 'view' } as never),
    )
    expect(shared.seen).toEqual([{ type: 'sync:dataset', action: 'update', id: d!.id }])
    const unshared = await capture(() => library().unshareDataset(d!.id, 'sh-1'))
    expect(unshared.seen).toEqual([{ type: 'sync:dataset', action: 'update', id: d!.id }])
  })

  it('promote → dataset/create with the CREATED id, not the artifact id (routes.rs:1764)', async () => {
    const f = await capture(() => detail().promote('artifact-1', 'P'))
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]).toMatchObject({ type: 'sync:dataset', action: 'create' })
    expect(f.seen[0]!.id).not.toBe('artifact-1')
    expect(rows[0]!.id).toBe(f.seen[0]!.id) // the dataset the backend just made
  })

  it('addSupportingFile → dataset/update for the OPEN dataset (routes.rs:1525)', async () => {
    const d = await library().createDataset({ name: 'A' })
    await openDetail(d!.id)
    const f = await capture(() =>
      detail().addSupportingFile(d!.id, { file: new File([''], 'a.csv'), axis: 'axis-1' }),
    )
    expect(f.seen).toEqual([{ type: 'sync:dataset', action: 'update', id: d!.id }])
  })

  it('upload → one dataset/create PER created dataset (routes.rs:845 emits in a loop)', async () => {
    const f = await capture(() => library().uploadFiles([new File([''], 'a.csv')]))
    expect(f.seen).toEqual([
      { type: 'sync:dataset', action: 'create', id: 'ds-1' },
      { type: 'sync:dataset', action: 'create', id: 'ds-2' },
    ])
  })

  it('folder ops → dataset_folder/{create,update,delete} with the FOLDER id', async () => {
    const made = await capture(() => library().createFolder('Inbox'))
    expect(made.seen).toEqual([{ type: 'sync:dataset_folder', action: 'create', id: 'fo-1' }])
    const renamed = await capture(() => library().renameFolder('fo-1', 'Archive'))
    expect(renamed.seen).toEqual([{ type: 'sync:dataset_folder', action: 'update', id: 'fo-1' }])
    const gone = await capture(() => library().deleteFolder('fo-1'))
    expect(gone.seen).toEqual([{ type: 'sync:dataset_folder', action: 'delete', id: 'fo-1' }])
  })

  it('addToFolder / removeFromFolder echo NOTHING — a NAMED exception', async () => {
    // `add_to_folder`/`remove_from_folder` (routes.rs:1980/2003) DO publish
    // `DatasetFolder`/`Update` with `origin`, so by the letter of the rule these would
    // echo. They deliberately do not, and this case exists so the exception cannot be
    // deleted by accident:
    //
    //   the ONLY `sync:dataset_folder` subscriber is `Datasets.store` itself, and its
    //   handler is a full `load()`, which flips `loading:true`, swaps the library table
    //   to skeleton rows, and UNMOUNTS the row — taking the open per-row folder popover
    //   with it. `applyFolderMembership` exists precisely to avoid that (see its doc
    //   comment). Echoing would reintroduce the bug it fixed, for a surface that is
    //   already up to date.
    const d = await library().createDataset({ name: 'M' })
    await library().createFolder('Inbox')
    const added = await capture(() => library().addToFolder('fo-1', d!.id))
    expect(added.seen).toEqual([])
    const removed = await capture(() => library().removeFromFolder('fo-1', d!.id))
    expect(removed.seen).toEqual([])
    // …and the membership still lands, in place.
    expect(library().folderMembers[d!.id] ?? []).toEqual([])
  })
})

describe('the echo does not storm or loop', () => {
  it('one create = exactly ONE library reload (no double-fetch)', async () => {
    const before = libraryLoads()

    await library().createDataset({ name: 'Once' })
    await vi.waitFor(() => expect(libraryNames()).toContain('Once'))
    // Let any second wave land before counting.
    await new Promise(r => setTimeout(r, 50))

    // The library is the ONE `sync:dataset` list subscriber here → exactly one full
    // `load()`. Two would mean the acting store kept a private inline reload ALONGSIDE
    // the echo, which is the double-fetch `localEcho.ts` exists to prevent.
    expect(libraryLoads() - before).toBe(1)
  })

  it('the echo settles — it is not re-delivered to itself', async () => {
    await library().createDataset({ name: 'Settle' })
    await vi.waitFor(() => expect(libraryNames()).toContain('Settle'))
    const after = libraryLoads()

    await new Promise(r => setTimeout(r, 100))

    // A self-re-broadcasting emit would keep the counter climbing forever.
    expect(libraryLoads()).toBe(after)
  })
})
