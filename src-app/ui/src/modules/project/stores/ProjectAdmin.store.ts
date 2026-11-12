import { ApiClient } from '@/api-client'
import {
  type AdminProjectDetail,
  type AdminProjectRow,
  type AdminProjectStats,
  type BatchResult,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

const SEARCH_DEBOUNCE_MS = 250
let searchTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Admin cross-user project governance (the `/settings/projects` admin twin). Lists
 * ALL projects with owner identity + counts + status; drives change-owner /
 * share-on-behalf / revoke / delete / reassign (single + bulk). Numbered
 * pagination (settings idiom, page size 10). Self-gated on `project::admin::read`;
 * `sync:project*` / `sync:reconnect` refresh live.
 */
const ProjectAdminDef = defineStore('ProjectAdmin', {
  state: {
    rows: [] as AdminProjectRow[],
    total: 0,
    page: 1,
    pageSize: 10,
    search: '',
    ownerFilter: null as string | null,
    ownerFilterName: null as string | null,
    statusFilter: null as string | null,
    sort: 'updated',
    stats: null as AdminProjectStats | null,
    loading: false,
    mutating: false,
    isInitialized: false,
    error: null as string | null,
    loadSeq: 0,
    // multi-select
    selectedIds: [] as string[],
    // drawers (id = open target; null = closed)
    detailId: null as string | null,
    detail: null as AdminProjectDetail | null,
    detailLoading: false,
    detailError: false,
    changeOwnerId: null as string | null,
    shareId: null as string | null,
    deleteId: null as string | null,
    // reassign drawer: bulk (explicit ids) OR all-of-owner
    reassignOpen: false,
    reassignProjectIds: [] as string[],
    reassignFromOwner: null as { id: string; name: string } | null,
  },
  actions: (set, get) => {
    const load = async () => {
      if (!hasPermissionNow(Permissions.ProjectAdminRead)) return
      const s = get()
      const seq = s.loadSeq + 1
      set({ loadSeq: seq, loading: true, error: null })
      const search = s.search.trim()
      try {
        const res = await ApiClient.ProjectAdmin.list({
          page: s.page,
          per_page: s.pageSize,
          sort: s.sort,
          ...(search ? { search } : {}),
          ...(s.ownerFilter ? { owner_id: s.ownerFilter } : {}),
          ...(s.statusFilter ? { status: s.statusFilter } : {}),
        })
        if (get().loadSeq !== seq) return
        set({
          rows: res.rows,
          total: res.total,
          stats: res.stats,
          loading: false,
          isInitialized: true,
        })
      } catch (error) {
        if (get().loadSeq !== seq) return
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load projects',
        })
      }
    }
    const reloadDetail = async () => {
      const id = get().detailId
      if (!id) return
      try {
        const detail = await ApiClient.ProjectAdmin.detail({ id })
        if (get().detailId === id) set({ detail })
      } catch {
        /* keep the drawer; the list reload surfaces errors */
      }
    }
    const afterMutation = async () => {
      await load()
      await reloadDetail()
    }
    return {
      load,
      setSearch: (search: string) => {
        // Clear the selection when the result set changes — a bulk action must
        // never span rows that are no longer visible.
        set({ search, page: 1, selectedIds: [] })
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS)
      },
      setOwnerFilter: (ownerFilter: string | null, ownerFilterName?: string | null) => {
        set({ ownerFilter, ownerFilterName: ownerFilter ? (ownerFilterName ?? null) : null, page: 1, selectedIds: [] })
        void load()
      },
      setStatusFilter: (statusFilter: string | null) => {
        set({ statusFilter, page: 1, selectedIds: [] })
        void load()
      },
      setSort: (sort: string) => {
        set({ sort, page: 1, selectedIds: [] })
        void load()
      },
      changePage: (page: number, size?: number) => {
        set({
          page: size && size !== get().pageSize ? 1 : page,
          pageSize: size ?? get().pageSize,
          selectedIds: [],
        })
        void load()
      },
      // ---- multi-select ----
      toggleSelect: (id: string) =>
        set(s => ({
          selectedIds: s.selectedIds.includes(id)
            ? s.selectedIds.filter(x => x !== id)
            : [...s.selectedIds, id],
        })),
      selectAllOnPage: () => set(s => ({ selectedIds: s.rows.map(r => r.id) })),
      clearSelection: () => set({ selectedIds: [] }),
      // ---- drawers ----
      openDetail: (id: string) => {
        set({ detailId: id, detail: null, detailLoading: true, detailError: false })
        void ApiClient.ProjectAdmin.detail({ id })
          .then(detail => {
            if (get().detailId === id) set({ detail, detailLoading: false })
          })
          .catch(() => {
            if (get().detailId === id) set({ detailLoading: false, detailError: true })
          })
      },
      closeDetail: () => set({ detailId: null, detail: null, detailError: false }),
      // Opening an action closes the detail drawer first — never stack a second
      // drawer / a Confirm on top of the detail drawer (equal z-index defeats the
      // inert-beneath guard; a Confirm-over-Drawer has focus-trap issues).
      openChangeOwner: (id: string) => set({ changeOwnerId: id, detailId: null, detail: null }),
      closeChangeOwner: () => set({ changeOwnerId: null }),
      openShare: (id: string) => set({ shareId: id, detailId: null, detail: null }),
      closeShare: () => set({ shareId: null }),
      openDelete: (id: string) => set({ deleteId: id, detailId: null, detail: null }),
      closeDelete: () => set({ deleteId: null }),
      openReassignBulk: (ids: string[]) =>
        set({ reassignOpen: true, reassignProjectIds: ids, reassignFromOwner: null }),
      openReassignAll: (id: string, name: string) =>
        set({ reassignOpen: true, reassignProjectIds: [], reassignFromOwner: { id, name } }),
      closeReassign: () => set({ reassignOpen: false, reassignProjectIds: [], reassignFromOwner: null }),
      // ---- mutations ----
      changeOwner: async (id: string, newOwnerId: string, keepOldAsEditor: boolean) => {
        set({ mutating: true, error: null })
        try {
          await ApiClient.ProjectAdmin.changeOwner({
            id,
            new_owner_id: newOwnerId,
            keep_old_as_editor: keepOldAsEditor,
          })
          await afterMutation()
        } finally {
          set({ mutating: false })
        }
      },
      shareOnBehalf: async (id: string, recipientId: string, level: string) => {
        set({ mutating: true, error: null })
        try {
          await ApiClient.ProjectAdmin.share({ id, recipient_id: recipientId, permission_level: level })
          await afterMutation()
        } finally {
          set({ mutating: false })
        }
      },
      revokeShare: async (projectId: string, shareId: string) => {
        set({ mutating: true })
        try {
          await ApiClient.ProjectAdmin.revokeShare({ id: projectId, share_id: shareId })
          await afterMutation()
        } finally {
          set({ mutating: false })
        }
      },
      deleteProject: async (id: string) => {
        set({ mutating: true })
        try {
          await ApiClient.ProjectAdmin.delete({ id })
          set(s => ({
            selectedIds: s.selectedIds.filter(x => x !== id),
            // if the detail drawer is showing the just-deleted project, close it
            ...(s.detailId === id ? { detailId: null, detail: null } : {}),
          }))
          await load()
        } finally {
          set({ mutating: false })
        }
      },
      reassignAll: async (fromOwnerId: string, toOwnerId: string): Promise<BatchResult> => {
        set({ mutating: true })
        try {
          const res = await ApiClient.ProjectAdmin.reassignOwner({
            from_owner_id: fromOwnerId,
            to_owner_id: toOwnerId,
          })
          await load()
          return res
        } finally {
          set({ mutating: false })
        }
      },
      batchReassign: async (ids: string[], toOwnerId: string): Promise<BatchResult> => {
        set({ mutating: true })
        try {
          const res = await ApiClient.ProjectAdmin.batchReassign({
            project_ids: ids,
            to_owner_id: toOwnerId,
          })
          set({ selectedIds: [] })
          await load()
          return res
        } finally {
          set({ mutating: false })
        }
      },
      batchDelete: async (ids: string[]): Promise<BatchResult> => {
        set({ mutating: true })
        try {
          const res = await ApiClient.ProjectAdmin.batchDelete({ project_ids: ids })
          set({ selectedIds: [] })
          await load()
          return res
        } finally {
          set({ mutating: false })
        }
      },
    }
  },
  init: ({ on, actions, onCleanup }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProjectAdminRead)) return
      void actions.load()
    }
    on('sync:project', reload)
    on('sync:project_share', reload)
    on('sync:project_transfer', reload)
    on('sync:reconnect', reload)
    onCleanup(() => {
      if (searchTimer) clearTimeout(searchTimer)
    })
    if (hasPermissionNow(Permissions.ProjectAdminRead)) void actions.load()
  },
})

export const useProjectAdminStore = ProjectAdminDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProjectAdmin'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProjectAdmin = registerLazyStore(ProjectAdminDef)
