import { ApiClient } from '@/api-client'
import {
  type CreateProjectRequest,
  type ProjectDto,
  type UpdateProjectRequest,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 250

// Debounce timer for search-driven reloads (module-scope — one feed store).
let searchTimer: ReturnType<typeof setTimeout> | undefined

/**
 * The user's projects (owned ∪ accepted-shares), the top-level `/projects` feed.
 * Load-More pagination (bounded first page); debounced ILIKE search with a
 * response-generation guard (out-of-order responses are discarded); self-gated
 * on `projects::use`; `sync:project` / `sync:reconnect` subscriptions refresh live.
 */
const ProjectsDef = defineStore('Projects', {
  state: {
    projects: [] as ProjectDto[],
    total: 0,
    page: 1,
    search: '',
    loading: false,
    loadingMore: false,
    mutating: false,
    isInitialized: false,
    error: null as string | null,
    // Monotonic load generation — a response for a superseded query is dropped.
    loadSeq: 0,
  },
  actions: (set, get) => {
    const fetchPage = async (page: number) => {
      const search = get().search.trim()
      return ApiClient.Project.list({
        page,
        per_page: PAGE_SIZE,
        ...(search ? { search } : {}),
      })
    }
    const load = async () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      const seq = get().loadSeq + 1
      set({ loadSeq: seq, loading: true, error: null })
      try {
        const res = await fetchPage(1)
        // Discard a stale response (a newer load/search superseded this one).
        if (get().loadSeq !== seq) return
        set({
          projects: res.projects,
          total: res.total,
          page: 1,
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
    return {
      load,
      loadMore: async () => {
        if (get().loadingMore) return
        const next = get().page + 1
        set({ loadingMore: true })
        try {
          const res = await fetchPage(next)
          set(s => {
            // Dedup by id — an item shifted between offset-paginated fetches
            // must not duplicate (which would collide React keys).
            const seen = new Set(s.projects.map(x => x.id))
            const fresh = res.projects.filter(x => !seen.has(x.id))
            return {
              projects: [...s.projects, ...fresh],
              total: res.total,
              page: next,
              loadingMore: false,
            }
          })
        } catch {
          set({ loadingMore: false })
        }
      },
      setSearch: (search: string) => {
        // Update the field immediately (controlled input), debounce the reload.
        set({ search })
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS)
      },
      // ── mutations ────────────────────────────────────────────────────────────────
      //
      // Each one echoes the frame the server WITHHELD from this connection
      // (`project/handlers.rs` publishes `Project`/… to the owner passing `origin`) and
      // does NOT reload itself inline. The echo is this store's refresh path as much as
      // the sidebar's: one emit, one refetch per interested store, and an omitted echo
      // breaks the actor's own list first. See `core/sync/localEcho.ts`.
      createProject: async (data: CreateProjectRequest): Promise<ProjectDto | undefined> => {
        if (get().mutating) return
        set({ mutating: true, error: null })
        try {
          const project = await ApiClient.Project.create(data)
          set({ mutating: false })
          await echoLocalSync('project', 'create', project.id)
          return project
        } catch (error) {
          set({
            mutating: false,
            error: error instanceof Error ? error.message : 'Failed to create project',
          })
          throw error
        }
      },
      updateProject: async (id: string, data: UpdateProjectRequest): Promise<void> => {
        set({ mutating: true, error: null })
        try {
          await ApiClient.Project.update({ id, ...data })
          set({ mutating: false })
          await echoLocalSync('project', 'update', id)
        } catch (error) {
          set({
            mutating: false,
            error: error instanceof Error ? error.message : 'Failed to update project',
          })
          throw error
        }
      },
      duplicateProject: async (id: string): Promise<void> => {
        set({ mutating: true })
        try {
          // The server publishes `Create` for the COPY, not an update of the original.
          const copy = await ApiClient.Project.duplicate({ id })
          set({ mutating: false })
          await echoLocalSync('project', 'create', copy.id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
      deleteProject: async (id: string): Promise<void> => {
        set({ mutating: true })
        try {
          await ApiClient.Project.delete({ id })
          set({ mutating: false })
          await echoLocalSync('project', 'delete', id)
        } catch (error) {
          set({ mutating: false })
          throw error
        }
      },
    }
  },
  init: ({ on, actions, onCleanup }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      void actions.load()
    }
    on('sync:project', reload)
    on('sync:project_share', reload)
    on('sync:project_transfer', reload)
    on('sync:reconnect', reload)
    // Cancel any pending debounced search reload on store teardown (no stale
    // load() firing into a disposed store).
    onCleanup(() => {
      if (searchTimer) clearTimeout(searchTimer)
    })
    if (hasPermissionNow(Permissions.ProjectsUse)) void actions.load()
  },
})

export const useProjectsStore = ProjectsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Projects'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Projects = registerLazyStore(ProjectsDef)
