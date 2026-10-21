import { ApiClient } from '@/api-client'
import {
  type Dataset,
  type DatasetListItem,
  type ProjectDto,
  type ProjectShareDto,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import { isOwnerRole } from '@/modules/project/context/ProjectScope'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const PAGE_SIZE = 20

/**
 * One project's detail: the project, its datasets (Load-More server pagination), and
 * (owner-only) its shares. Attach/detach + share/revoke + transfer act here.
 * Reloads on `sync:project` / `sync:project_share` for the open project.
 */
const ProjectDetailDef = defineStore('ProjectDetail', {
  state: {
    projectId: null as string | null,
    project: null as ProjectDto | null,
    datasets: [] as Dataset[],
    datasetsTotal: 0,
    datasetsPage: 1,
    shares: [] as ProjectShareDto[],
    // `DatasetListItem`, not `Dataset` — it is filled from `Dataset.listMine().items`, whose rows
    // carry the derived `processing_status`/`processing_error` on top of the dataset. Declaring
    // the narrower type typechecked (a list item flattens a dataset) and the status still
    // travelled at runtime, which is the only reason the attach picker's readiness worked at all —
    // but nothing would have failed if a refactor stopped returning it, and the badge would have
    // silently gone dark.
    availableDatasets: [] as DatasetListItem[],
    loading: false,
    loadingMore: false,
    mutating: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const loadDatasets = async (id: string, page: number) =>
      ApiClient.Project.listDatasets({ id, page, per_page: PAGE_SIZE })

    const loadShares = async (id: string, isOwner: boolean) => {
      if (!isOwner) {
        set({ shares: [] })
        return
      }
      try {
        const res = await ApiClient.Project.listShares({ id })
        set({ shares: res.shares })
      } catch {
        /* viewer/editor can't list shares — leave empty */
      }
    }

    // Refresh the attach-picker's candidate list (all datasets). Called on
    // mount AND after attach/detach so moved datasets don't linger as options.
    const refreshAvailable = async () => {
      try {
        set({ availableDatasets: (await ApiClient.Dataset.listMine({ per_page: 500 })).items })
      } catch {
        /* ignore */
      }
    }

    const loadProject = async (id: string) => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      set({ projectId: id, loading: true, error: null })
      try {
        const project = await ApiClient.Project.get({ id })
        const ds = await loadDatasets(id, 1)
        set({
          project,
          datasets: ds.datasets,
          datasetsTotal: ds.total,
          datasetsPage: 1,
          loading: false,
        })
        await loadShares(id, isOwnerRole(project.effective_permission))
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load project',
        })
      }
    }

    return {
      loadProject,
      reloadCurrent: async () => {
        const id = get().projectId
        if (id) await loadProject(id)
      },
      loadMoreDatasets: async () => {
        const id = get().projectId
        if (!id || get().loadingMore) return
        const next = get().datasetsPage + 1
        set({ loadingMore: true })
        try {
          const ds = await loadDatasets(id, next)
          set(s => ({
            datasets: [...s.datasets, ...ds.datasets],
            datasetsTotal: ds.total,
            datasetsPage: next,
            loadingMore: false,
          }))
        } catch {
          set({ loadingMore: false })
        }
      },
      loadAvailableDatasets: refreshAvailable,
      // ── mutations ────────────────────────────────────────────────────────────────
      //
      // Each echoes the frame(s) `project/handlers.rs` publishes to the acting user with
      // `origin` applied — the ones the fan-out withheld from this connection — and does
      // NOT reload itself inline: this store's own `sync:*` subscriptions below are the
      // refresh path, exactly as they are for the projects grid, the sidebar rail and the
      // workbench catalog. `refreshAvailable()` stays inline because it reads
      // `Dataset.listMine`, which no `sync:` frame covers here (attach/detach publish
      // `Project`/Update only).
      attachDataset: async (datasetId: string) => {
        const id = get().projectId
        if (!id) return
        set({ mutating: true })
        try {
          await ApiClient.Project.attachDataset({ id, dataset_id: datasetId })
          await refreshAvailable()
          set({ mutating: false })
          // Attaching changes the project's ARTIFACT set (the workbench catalog unions the
          // project's own artifacts with those of its attached datasets), and the server
          // publishes `Project`/`Update` for it — but suppresses that frame for THIS
          // connection. Re-emit it locally so sibling surfaces in this tab (the workbench's
          // input pickers) react exactly as another device already does.
          await echoLocalSync('project', 'update', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
      detachDataset: async (datasetId: string) => {
        const id = get().projectId
        if (!id) return
        set({ mutating: true })
        try {
          await ApiClient.Project.detachDataset({ id, dataset_id: datasetId })
          await refreshAvailable()
          set({ mutating: false })
          // Same as attach: the detached dataset's artifacts leave this project's catalog,
          // and this tab is the one connection the server withholds the frame from.
          await echoLocalSync('project', 'update', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
      createShare: async (email: string, permissionLevel: string) => {
        const id = get().projectId
        if (!id) return
        set({ mutating: true })
        try {
          const share = await ApiClient.Project.createShare({
            id,
            email,
            permission_level: permissionLevel,
          })
          set({ mutating: false })
          // `ProjectShare`/`Create` to the owner, suppressed for this connection. The
          // recipient's copy already carries `origin: None` and reaches their devices.
          await echoLocalSync('project_share', 'create', share.id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
      revokeShare: async (shareId: string) => {
        set({ mutating: true })
        try {
          await ApiClient.Project.revokeShare({ id: shareId })
          set({ mutating: false })
          await echoLocalSync('project_share', 'delete', shareId)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
      createTransfer: async (email: string) => {
        const id = get().projectId
        if (!id) return
        set({ mutating: true })
        try {
          const transfer = await ApiClient.Project.createTransfer({ id, email })
          set({ mutating: false })
          // Previously this refreshed NOTHING locally — the pending-transfer state was
          // invisible in the acting tab until a reload, while every other device saw it.
          await echoLocalSync('project_transfer', 'create', transfer.id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
    }
  },
  init: ({ on, actions, get }) => {
    const reload = (ev: { data: { id: string } }) => {
      // sync:project carries the project id → only refetch when it's the OPEN project.
      if (get().projectId && ev.data.id === get().projectId) {
        void actions.reloadCurrent()
      }
    }
    on('sync:project', reload)
    on('sync:project_share', () => void actions.reloadCurrent())
    on('sync:project_transfer', () => void actions.reloadCurrent())
    // This page RENDERS dataset rows (name, type, processing status) but subscribed to
    // none of the entity that owns them, so a dataset renamed anywhere else — the
    // datasets page, another device, a collaborator — left a stale name sitting in the
    // project's list until the page was reloaded. Attach/detach came through
    // `sync:project`; a change to the ROW's own fields never did.
    on('sync:dataset', () => {
      if (get().projectId) void actions.reloadCurrent()
    })
    on('sync:reconnect', () => void actions.reloadCurrent())
  },
})

export const useProjectDetailStore = ProjectDetailDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProjectDetail'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProjectDetail = registerLazyStore(ProjectDetailDef)
