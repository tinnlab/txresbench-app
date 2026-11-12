import { ApiClient } from '@/api-client'
import {
  type CreateDatasetRequest,
  type Dataset,
  type DatasetFolder,
  type DatasetListItem,
  type DatasetShare,
  type ShareDatasetRequest,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/** Which library tab is active (owner-scoped ∪ shared-with-me). */
export type DatasetTab = 'mine' | 'shared'

/**
 * The multipart part filename for one picked file (ITEM-7, #160).
 *
 * `webkitRelativePath` is the path of a file RELATIVE to the directory the user
 * picked, and the browser sets it on exactly one input: a `webkitdirectory` picker.
 * For every other path into this store — a click-to-browse dropzone, a drop, a
 * programmatic `File` — it is `''`, so `?? name` means every part filename that goes
 * out today is byte-identical to what went out before this existed.
 *
 * It matters because the server decides which declared member an uploaded part
 * satisfies by comparing as many TRAILING path segments as the member itself
 * declares (`dataset/repository.rs::matches_member`). A declaration of a bare
 * basename is answered by the basename either way; a declaration that carries its own
 * directory can only be answered by a part that still carries one. Sending the
 * basename alone is what made a nested bundle ungroupable — three sibling directories
 * holding the same names arrived as three copies of one basename.
 */
function partName(file: File): string {
  const relative = file.webkitRelativePath
  return relative != null && relative.length > 0 ? relative : file.name
}

/**
 * The user's dataset library — owned (`listMine`) ∪ shared-with-me
 * (`listShared`) + the owner-scoped folder label layer (DEC-22). The two list
 * endpoints return the FULL owner-scoped set (no server paging — see
 * `Dataset.listMine: Dataset[]`), so search / folder-filter / pagination are
 * applied client-side. Self-gated on `projects::use` (datasets reuse it — DEC-23);
 * `sync:dataset` / `sync:dataset_folder` / `sync:reconnect` refresh live.
 */
const DatasetsDef = defineStore('Datasets', {
  state: {
    /** The current server-side PAGE of the ACTIVE tab (search + folder + paging are
     *  all applied on the server, so this scales to any number of datasets). */
    items: [] as DatasetListItem[],
    /** The active tab's FILTERED total (drives the pager). */
    total: 0,
    /** Unfiltered tab-label counts (how many you own / are shared with you). */
    mineTotal: 0,
    sharedTotal: 0,
    /** The most-recent OWNED datasets (unfiltered) for the sidebar feed. */
    recent: [] as DatasetListItem[],
    folders: [] as DatasetFolder[],
    /** dataset_id -> folder_ids it belongs to (built from per-folder membership). */
    folderMembers: {} as Record<string, string[]>,
    tab: 'mine' as DatasetTab,
    activeFolderId: null as string | null,
    search: '',
    page: 1,
    pageSize: 20,
    loading: false,
    mutating: false,
    isInitialized: false,
    error: null as string | null,
    // Overlay open-state (read by the page's overlays).
    uploadOpen: false,
    shareTarget: null as Dataset | null,
    // Existing shares for the open share dialog (the SAME dialog serves the library
    // table + the detail header, so the list lives with the target it's bound to).
    shares: [] as DatasetShare[],
    sharesLoading: false,
    attachTarget: null as Dataset | null,
    folderCreateOpen: false,
    // Upload transient state (kept out of the list load path so a concurrent
    // refetch can't clobber it).
    uploading: false,
    uploadPct: 0,
    uploadError: null as string | null,
  },
  actions: (set, get) => {
    // Superseded-response guards. TWO tokens with different write-sets: `pageEpoch`
    // gates the PAGE (`items`/`total`) — bumped by BOTH `loadPage` and `load`;
    // `fullEpoch` gates the COUNTS/folders/recent — bumped ONLY by `load`. This keeps
    // a page-only refetch (which supersedes an in-flight full `load`'s PAGE) from ALSO
    // dropping that load's counts/folders (a single shared epoch would — HIGH bug).
    let pageEpoch = 0
    let fullEpoch = 0

    /** The ACTIVE tab's page request (server applies search/folder/paging). */
    const fetchActivePage = (s: ReturnType<typeof get>) => {
      const search = s.search.trim() || undefined
      return s.tab === 'mine'
        ? ApiClient.Dataset.listMine({
            page: s.page,
            per_page: s.pageSize,
            search,
            folder_id: s.activeFolderId ?? undefined,
          })
        : ApiClient.Dataset.listShared({ page: s.page, per_page: s.pageSize, search })
    }

    /** Clamp a paged-past-the-end request (e.g. after deletes shrank `total`) back to
     *  the last valid page and re-fetch, so we never strand the user on an empty page.
     *  Returns true if it re-fetched (caller should stop). */
    const clampPage = (total: number, reload: () => Promise<void>): boolean => {
      const s = get()
      const lastPage = Math.max(1, Math.ceil(total / s.pageSize))
      if (s.page > lastPage) {
        set({ page: lastPage })
        void reload()
        return true
      }
      return false
    }

    /** PAGE-ONLY refetch (items/total) — for tab/folder/search/page changes, which do
     *  NOT alter the unfiltered counts, folders, or memberships. Avoids the
     *  4-plus-N-request storm the full `load()` fires on every pagination click. */
    const loadPage = async () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      const epoch = ++pageEpoch
      set({ loading: true, error: null })
      try {
        const pageRes = await fetchActivePage(get())
        if (epoch !== pageEpoch) return // a newer page load superseded
        if (clampPage(pageRes.total, loadPage)) return
        set({ items: pageRes.items, total: pageRes.total, loading: false, isInitialized: true })
      } catch (error) {
        if (epoch !== pageEpoch) return
        set({
          loading: false,
          isInitialized: true,
          error: error instanceof Error ? error.message : 'Failed to load datasets',
        })
      }
    }

    /** FULL load: active page + unfiltered tab counts + folders + memberships. For
     *  mount, mutations (create/delete/share/folder), and sync reloads — the events
     *  that actually change the counts/folders. */
    const load = async () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      const pEpoch = ++pageEpoch
      const fEpoch = ++fullEpoch
      set({ loading: true, error: null })
      try {
        const [pageRes, mineCount, sharedCount, folders] = await Promise.all([
          fetchActivePage(get()),
          // Unfiltered tab-label counts + the sidebar's recent feed (top 8 owned).
          ApiClient.Dataset.listMine({ per_page: 8 }),
          ApiClient.Dataset.listShared({ per_page: 1 }),
          ApiClient.Dataset.listFolders({ per_page: 500 }),
        ])
        // Folder membership (bounded set of folders — one call each, NOT per-dataset).
        // `per_page: 500` (the server max) so a folder with >50 members isn't
        // under-counted in the rail / per-row folder menu.
        const memberships = await Promise.all(
          folders.map(async f => {
            try {
              const rows = await ApiClient.Dataset.listFolderDatasets({ id: f.id, per_page: 500 })
              return rows.map(d => d.id)
            } catch {
              return [] as string[]
            }
          }),
        )
        // Counts/folders are independent of the page filter — apply them unless a
        // NEWER full load started. (A `loadPage` that superseded our PAGE must NOT
        // drop these — that was the shared-epoch HIGH bug.)
        if (fEpoch !== fullEpoch) return
        const folderMembers: Record<string, string[]> = {}
        folders.forEach((f, i) => {
          for (const datasetId of memberships[i]) {
            ;(folderMembers[datasetId] ??= []).push(f.id)
          }
        })
        const counts = {
          mineTotal: mineCount.total,
          sharedTotal: sharedCount.total,
          recent: mineCount.items,
          folders,
          folderMembers,
          loading: false,
          isInitialized: true,
        }
        // Apply our PAGE too, but only if no newer `loadPage` superseded it (else that
        // fresher page stands — we just contribute the counts/folders).
        if (pEpoch === pageEpoch) {
          if (clampPage(pageRes.total, load)) return
          set({ ...counts, items: pageRes.items, total: pageRes.total })
        } else {
          set(counts)
        }
      } catch (error) {
        if (fEpoch !== fullEpoch) return
        set({
          loading: false,
          isInitialized: true,
          error: error instanceof Error ? error.message : 'Failed to load datasets',
        })
      }
    }

    /** Toggle ONE dataset's membership of ONE folder, in place.
     *
     *  Deliberately NOT the full `load()` this used to run. `load()` flips
     *  `loading: true`, and the library's kit `Table` swaps its body to SKELETON rows
     *  while busy — which unmounts the row, and with it the open per-row folder
     *  `Popover`. So the "In folder" confirmation `RowFolderMenu` renders was never
     *  visible to the user, and assigning a second folder meant reopening the menu.
     *  (Uncontrolled or controlled, the popover cannot survive its own row being
     *  unmounted — the fix has to be to stop unmounting it.)
     *
     *  A folder toggle changes exactly ONE server-derived slice, `folderMembers`
     *  (`FolderRail`'s per-folder counts derive from it too), so splice that — the
     *  shape `UserGroups`' `group.member_removed` handler already uses. The PAGE's
     *  rows change only when the library is filtered to the very folder that changed;
     *  refetch just that page, then, and page-only (counts/folders are untouched). */
    const applyFolderMembership = async (
      datasetId: string,
      folderId: string,
      member: boolean,
    ): Promise<void> => {
      set(s => {
        const current = s.folderMembers[datasetId] ?? []
        const next = member
          ? current.includes(folderId)
            ? current
            : [...current, folderId]
          : current.filter(id => id !== folderId)
        return { folderMembers: { ...s.folderMembers, [datasetId]: next } }
      })
      if (get().activeFolderId === folderId) await loadPage()
    }

    /** Debounce the SEARCH refetch so typing doesn't fire a request per keystroke.
     *  Page-only (search changes results, not counts/folders). */
    let searchTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleSearchLoad = () => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void loadPage(), 300)
    }

    /** Stream a prepared multipart form to `POST /datasets/upload`, driving the
     *  transient upload state (pct/error) and reloading the library on success.
     *  Shared by the untyped drop path and the type-first wizard. */
    const performUpload = async (form: FormData): Promise<void> => {
      set({ uploading: true, uploadPct: 0, uploadError: null })
      // The SDK's progress-tracking transport is XMLHttpRequest, and its non-2xx path
      // rejects with `new Error(\`HTTP error! status: ${status}\`)` WITHOUT reading
      // `xhr.responseText` — the body parsing that extracts `{error, error_code}` lives
      // only in its `fetch` branch, which an upload never takes. So every refusal the
      // server words carefully (`MANIFEST_GROUP_INCOMPLETE` naming exactly which members
      // are missing, `FILENAME_TOO_LONG`, `DATASET_CARDINALITY`, `UNKNOWN_DATATYPE`)
      // reached the user as "HTTP error! status: 400".
      //
      // `fileUploadProgress.__init` is the SDK's own documented seam for getting the XHR
      // handle, so the body is recovered here rather than by re-implementing transport or
      // by editing a pinned submodule. Reported upstream as an SDK gap.
      let xhr: XMLHttpRequest | null = null
      try {
        const res = await ApiClient.Dataset.upload(form, {
          fileUploadProgress: {
            __init: (x: XMLHttpRequest) => {
              xhr = x
            },
            onProgress: (_progress: number, _fileIndex: number, overall: number) =>
              set({ uploadPct: Math.round(overall) }),
          },
        })
        set({ uploading: false, uploadPct: 100, uploadOpen: false })
        // `upload_datasets` (routes.rs:845) publishes `Dataset`/`Create` INSIDE its
        // per-created-dataset loop, each with `origin` applied — so one upload of N
        // files withholds N frames from this connection. Echo the same N.
        for (const created of res.datasets) await echoLocalSync('dataset', 'create', created.id)
      } catch (error) {
        set({ uploading: false, uploadError: uploadErrorMessage(error, xhr) })
        throw error
      }
    }

    /** Fetch the existing shares for the dataset the share dialog is bound to.
     *  Supplementary — a failure leaves the dialog usable (you can still add a
     *  share), it just shows no existing-access list. */
    const loadShares = async (id: string) => {
      set({ sharesLoading: true })
      try {
        const shares = await ApiClient.Dataset.listShares({ id })
        if (get().shareTarget?.id === id) set({ shares, sharesLoading: false })
      } catch {
        if (get().shareTarget?.id === id) set({ sharesLoading: false })
      }
    }

    return {
      load,
      // Every list control now drives a SERVER refetch (search/folder/paging are
      // server-side). Switching to Shared drops any owner-folder filter.
      setTab: (tab: DatasetTab) => {
        set({ tab, page: 1, activeFolderId: tab === 'shared' ? null : get().activeFolderId })
        void loadPage()
      },
      setSearch: (search: string) => {
        set({ search, page: 1 })
        scheduleSearchLoad()
      },
      setFolder: (activeFolderId: string | null) => {
        set({ activeFolderId, page: 1 })
        void loadPage()
      },
      setPage: (page: number) => {
        set({ page })
        void loadPage()
      },
      setPageSize: (pageSize: number) => {
        set({ pageSize, page: 1 })
        void loadPage()
      },

      openUpload: () => set({ uploadOpen: true, uploadPct: 0, uploadError: null }),
      closeUpload: () => set({ uploadOpen: false }),
      openShare: (shareTarget: Dataset) => {
        set({ shareTarget, shares: [], sharesLoading: true })
        void loadShares(shareTarget.id)
      },
      closeShare: () => set({ shareTarget: null, shares: [], sharesLoading: false }),
      openAttach: (attachTarget: Dataset) => set({ attachTarget }),
      closeAttach: () => set({ attachTarget: null }),
      openFolderCreate: () => set({ folderCreateOpen: true }),
      closeFolderCreate: () => set({ folderCreateOpen: false }),

      /** Stream-upload one-or-more files as new dataset(s), UNTYPED — the backend
       *  sniffs + groups by FileLayout (ITEM-4). The drop-and-sniff fallback. */
      uploadFiles: async (files: File[]): Promise<void> => {
        if (files.length === 0) return
        const form = new FormData()
        // The `/datasets/upload` endpoint reads repeated multipart parts named
        // `file` (singular) — one per uploaded file (see `upload_datasets`). Using
        // `files` here dropped every part → 400 MISSING_FILE.
        for (const f of files) form.append('file', f, partName(f))
        await performUpload(form)
      },

      /** Type-first upload (ITEM-12 / ITEM-14, DEC-9): send the DECLARED datatype id
       *  so the backend skips sniffing, plus — for a manifest (10x-trio) type — the
       *  slot→filename mapping so the backend groups the members deterministically
       *  (a `.zip`/`.tar` archive is sent as a single file with no `slots`, expanded
       *  server-side). The extra multipart fields (`datatype`, `slots`) ride
       *  alongside the same repeated `file` parts the untyped path uses; a sibling
       *  item wires the backend to read them. */
      uploadTyped: async ({
        datatype,
        files,
        slots,
        supporting,
      }: {
        datatype: string
        files: File[]
        slots?: Record<string, string>
        /** Optional axis-aligned annotation tables folded on as SUPPORTING files
         *  (ITEM-16). Appended AFTER the primary `file` parts and tagged by their
         *  0-based upload-order `index` + `axis` in the `supporting` JSON spec
         *  (`[{index, axis, kind}]` — the `upload_datasets` contract, ITEM-11). */
        supporting?: { file: File; axis: string; kind?: string }[]
      }): Promise<void> => {
        if (files.length === 0 || !datatype) return
        const form = new FormData()
        form.append('datatype', datatype)
        for (const f of files) form.append('file', f, partName(f))
        if (slots && Object.keys(slots).length > 0) form.append('slots', JSON.stringify(slots))
        if (supporting && supporting.length > 0) {
          // Supporting parts occupy the upload-order indices AFTER the primaries.
          const specs = supporting.map((s, i) => ({
            index: files.length + i,
            axis: s.axis,
            kind: s.kind ?? 'annotation_table',
          }))
          for (const s of supporting) form.append('file', s.file, partName(s.file))
          form.append('supporting', JSON.stringify(specs))
        }
        await performUpload(form)
      },

      // ── mutations ────────────────────────────────────────────────────────────────
      //
      // Each echoes the frame(s) `dataset/routes.rs` publishes to the acting user with
      // `origin` applied — the ones the fan-out withheld from this connection — and does
      // NOT reload itself inline. This store's own `sync:dataset` / `sync:dataset_folder`
      // subscriptions below are its refresh path, exactly as they are for the open
      // dataset page (`DatasetDetail`) and the workbench catalog
      // (`useCatalogInvalidation`). Keeping the private `load()` is what hid the missing
      // echo: the grid looked correct, so nothing pointed at the two surfaces that heard
      // nothing. See `core/sync/localEcho.ts`.
      createDataset: async (data: CreateDatasetRequest): Promise<Dataset | undefined> => {
        set({ mutating: true, error: null })
        try {
          const ds = await ApiClient.Dataset.create(data)
          set({ mutating: false })
          await echoLocalSync('dataset', 'create', ds.id)
          return ds
        } catch (error) {
          set({
            mutating: false,
            error: error instanceof Error ? error.message : 'Failed to create dataset',
          })
          throw error
        }
      },

      deleteDataset: async (id: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.delete({ id })
          set({ mutating: false, shareTarget: null, attachTarget: null })
          await echoLocalSync('dataset', 'delete', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      shareDataset: async (id: string, req: ShareDatasetRequest): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.share({ id, ...req })
          set({ mutating: false })
          // There is NO `DatasetShare` sync entity — `share_dataset` (routes.rs:555)
          // tells everyone the DATASET changed. `shares` is dialog-local state no frame
          // covers, so that one read stays inline.
          await echoLocalSync('dataset', 'update', id)
          if (get().shareTarget?.id === id) void loadShares(id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      /** Revoke an existing share on a dataset (owner-only — DEC-3). */
      unshareDataset: async (id: string, shareId: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.unshare({ id, share_id: shareId })
          // Drop it locally so the row disappears immediately, then reconcile.
          set(s => ({ mutating: false, shares: s.shares.filter(sh => sh.id !== shareId) }))
          await echoLocalSync('dataset', 'update', id)
          if (get().shareTarget?.id === id) void loadShares(id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      /** Attach a dataset to a project for later analysis (M:N — DEC-4). */
      attachToProject: async (datasetId: string, projectId: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Project.attachDataset({ id: projectId, dataset_id: datasetId })
          set({ mutating: false })
          // The SAME mutation `ProjectDetail.attachDataset` performs (and echoes) — this
          // copy of it refreshed nothing at all locally. The server publishes
          // `Project`/`Update`, suppressed for this connection, so every project surface
          // in this tab (detail, the sidebar rail, the grid, the workbench catalog) stayed
          // stale until a reload while other devices updated immediately.
          await echoLocalSync('project', 'update', projectId)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      createFolder: async (name: string): Promise<void> => {
        set({ mutating: true })
        try {
          const folder = await ApiClient.Dataset.createFolder({ name })
          set({ mutating: false, folderCreateOpen: false })
          await echoLocalSync('dataset_folder', 'create', folder.id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      renameDataset: async (id: string, name: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.rename({ id, name })
          set({ mutating: false })
          await echoLocalSync('dataset', 'update', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      renameFolder: async (id: string, name: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.renameFolder({ id, name })
          set({ mutating: false })
          await echoLocalSync('dataset_folder', 'update', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      deleteFolder: async (id: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Dataset.deleteFolder({ id })
          set(s => ({
            activeFolderId: s.activeFolderId === id ? null : s.activeFolderId,
            mutating: false,
          }))
          await echoLocalSync('dataset_folder', 'delete', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },

      // ── the ONE named exception to the echo rule ──────────────────────────────────
      //
      // `add_to_folder` / `remove_from_folder` (routes.rs:1980/2003) DO publish
      // `DatasetFolder`/`Update` with `origin`, so by the letter of the rule these would
      // echo. They deliberately do not: the ONLY `sync:dataset_folder` subscriber is
      // THIS store, and its handler is a full `load()` — which flips `loading:true`,
      // swaps the library table to skeleton rows and UNMOUNTS the row, taking the open
      // per-row folder popover with it. `applyFolderMembership` exists precisely to
      // avoid that (see its doc comment). Echoing would reintroduce the bug it fixed,
      // for a surface that is already up to date. Pinned by a case in
      // `datasetFanout.test.ts` so the exception cannot be deleted by accident.
      addToFolder: async (folderId: string, datasetId: string): Promise<void> => {
        try {
          await ApiClient.Dataset.addToFolder({ id: folderId, dataset_id: datasetId })
          await applyFolderMembership(datasetId, folderId, true)
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to add to folder' })
          throw error
        }
      },

      removeFromFolder: async (folderId: string, datasetId: string): Promise<void> => {
        try {
          await ApiClient.Dataset.removeFromFolder({ id: folderId, dataset_id: datasetId })
          await applyFolderMembership(datasetId, folderId, false)
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to remove from folder' })
          throw error
        }
      },
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      void actions.load()
    }
    on('sync:dataset', reload)
    on('sync:dataset_folder', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.ProjectsUse)) void actions.load()
  },
})

export const useDatasetsStore = DatasetsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Datasets'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
/**
 * What to SHOW the user when an upload fails.
 *
 * Prefers the server's own worded refusal, read off the XHR's response body, because the
 * SDK's progress transport discards it (see `performUpload`). Falls back to the thrown
 * error's message, then to a generic line — a body that is absent, empty, not JSON, or
 * JSON without an `error` must never make this throw or render `[object Object]`.
 */
export function uploadErrorMessage(error: unknown, xhr: XMLHttpRequest | null): string {
  const raw = xhr?.responseText
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const msg = (parsed as { error?: unknown }).error
        if (typeof msg === 'string' && msg.trim().length > 0) return msg
      }
    } catch {
      /* not JSON — fall through to the thrown error's own message */
    }
  }
  return error instanceof Error && error.message ? error.message : 'Upload failed'
}

export const Datasets = registerLazyStore(DatasetsDef)
