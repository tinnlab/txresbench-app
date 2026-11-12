import { ApiClient } from '@/api-client'
import { type JobDetail, type JobListItem } from '@/api-client/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import { createJobsLifecycle } from './jobsLifecycle'

const DEFAULT_PER_PAGE = 10

const JobsDef = defineStore('Jobs', {
  immer: true,
  state: {
    // List ROWS (`{ job, can_stop }`) — the server states per row whether this caller may
    // stop it; the Stop control renders that answer (see `stopAuthority`).
    jobs: [] as JobListItem[],
    total: 0,
    page: 1,
    perPage: DEFAULT_PER_PAGE,
    loading: false,
    creating: false,
    error: null as string | null,
    // Detail view (selected job).
    selectedId: null as string | null,
    detail: null as JobDetail | null,
    detailLoading: false,
    streaming: false,
  },
  actions: (set, get) => {
    // The global Jobs drawer lists the owner's jobs across EVERY scope — the
    // project-less query, byte-identical to the pre-DRIFT-4.4 `Jobs.list` call.
    // Project scoping is the workbench pane's concern; its own store passes a
    // `?project_id=X` builder to this same shared lifecycle (see jobsLifecycle.ts).
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
    })

    const create = async (jobType: string, name: string) => {
      set(s => {
        s.creating = true
      })
      try {
        await ApiClient.Jobs.create({ job_type: jobType, name })
        await lifecycle.load(1) // jump to the first page so the new job is visible
      } finally {
        set(s => {
          s.creating = false
        })
      }
    }

    const setPerPage = (size: number) => {
      set(s => {
        s.perPage = size
        s.page = 1
      })
      void lifecycle.load(1)
    }

    return { ...lifecycle, create, setPerPage }
  },
  init: ({ on, actions, onCleanup }) => {
    // Notify-and-refetch (§7): the jobs backend emits `SyncEntity::Job` on every
    // list-status transition, so the drawer stays live off the sync stream — no poll.
    // The shared lifecycle owns the (self-gated) `sync:job` + `sync:reconnect` wiring.
    actions.subscribeSync(on)
    onCleanup(() => {
      actions.closeDetail()
    })
  },
})

export const useJobsStore = JobsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Jobs'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Jobs = registerLazyStore(JobsDef)
