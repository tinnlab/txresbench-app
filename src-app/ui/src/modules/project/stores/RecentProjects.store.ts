import { ApiClient } from '@/api-client'
import { type ProjectDto } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** Bounded page size for the sidebar recent-projects feed (DEC-11: a fixed UI
 * pagination default, not an operational tunable — mirrors ziee's recent-chats). */
const RECENT_PROJECTS_PAGE_SIZE = 20

/**
 * The recent-projects cursor backing the expandable left-sidebar widget. A
 * DEDICATED cursor, decoupled from the searchable `/projects` feed (`Projects`
 * store) so a search/sort on the list page never resets the accumulated sidebar
 * (mirrors ziee's `ChatHistory` recent cursor). Load-More paginated, self-gated
 * on `projects::use`, refreshed live by `sync:project` / `sync:reconnect`.
 */
const RecentProjectsDef = defineStore('RecentProjects', {
  state: {
    recentProjects: [] as ProjectDto[],
    recentTotal: 0,
    recentPage: 1,
    recentHasMore: false,
    recentLoading: false,
    recentLoadingMore: false,
    recentInitialized: false,
    recentError: null as string | null,
    // Monotonic load generation — a response for a superseded load is dropped.
    recentLoadSeq: 0,
  },
  actions: (set, get) => {
    const fetchPage = (page: number) =>
      ApiClient.Project.list({ page, per_page: RECENT_PROJECTS_PAGE_SIZE })

    const load = async () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      if (get().recentLoading || get().recentLoadingMore) return
      const seq = get().recentLoadSeq + 1
      set({ recentLoadSeq: seq, recentLoading: true, recentError: null })
      try {
        const res = await fetchPage(1)
        if (get().recentLoadSeq !== seq) return
        set({
          recentProjects: res.projects,
          recentTotal: res.total,
          recentPage: 1,
          recentHasMore: res.projects.length < res.total,
          recentLoading: false,
          recentInitialized: true,
        })
      } catch (error) {
        if (get().recentLoadSeq !== seq) return
        set({
          recentLoading: false,
          recentInitialized: true,
          recentError: error instanceof Error ? error.message : 'Failed to load projects',
        })
      }
    }

    return {
      load,
      loadMoreRecent: async () => {
        if (get().recentLoadingMore || get().recentLoading || !get().recentHasMore) return
        const next = get().recentPage + 1
        set({ recentLoadingMore: true, recentError: null })
        try {
          const res = await fetchPage(next)
          set(s => {
            const seen = new Set(s.recentProjects.map(x => x.id))
            const fresh = res.projects.filter(x => !seen.has(x.id))
            const merged = [...s.recentProjects, ...fresh]
            return {
              recentProjects: merged,
              recentTotal: res.total,
              // Advance monotonically to the page just fetched. (A floor-of-length
              // re-anchor could compute a page <= the current one when dedup
              // shrinks the gain, re-fetching a seen page and STALLING the feed.)
              recentPage: next,
              // A full page was returned AND we haven't reached the total yet.
              recentHasMore: res.projects.length >= RECENT_PROJECTS_PAGE_SIZE && merged.length < res.total,
              recentLoadingMore: false,
            }
          })
        } catch (error) {
          set({
            recentLoadingMore: false,
            recentError: error instanceof Error ? error.message : 'Failed to load more',
          })
        }
      },
      clearRecentError: () => set({ recentError: null }),
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      void actions.load()
    }
    on('sync:project', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.ProjectsUse)) void actions.load()
  },
})

export const useRecentProjectsStore = RecentProjectsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'RecentProjects'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const RecentProjects = registerLazyStore(RecentProjectsDef)
