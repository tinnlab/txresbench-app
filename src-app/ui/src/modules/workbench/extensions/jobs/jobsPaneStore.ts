// jobsPaneStore (ITEM-67) — a PER-PANE, project-scoped jobs store. The workbench
// Jobs pane is the operational monitor for ONE project's jobs (all statuses), so it
// cannot use the global singleton `Jobs` (that lists the owner's jobs across
// every scope, AND the sidebar drawer already owns that singleton — scoping it here
// would clobber the drawer's state; multiple open panes would clobber each other too).
// So it's a `defineLocalStore` (per-instance): `init` runs on the pane's mount and its
// `sync:job` listener + any live stream tear down on unmount, so a popped-out or closed
// pane never leaks a subscription or an SSE connection.
//
// The list/detail/SSE-stream/stop/sync-refetch lifecycle is the SHARED `createJobsLifecycle`
// (`modules/jobs`, DRIFT-4.4) — the SAME machinery the singleton drawer uses. Project
// scoping is the ONLY thing owned here: every list fetch carries `project_id` (the
// `?project_id=X` `job_scope` JOIN, ITEM-68) via `buildJobsListQuery`. The
// PRESENTATIONAL pieces (`JobStatusBadge`, `TimeSeriesChart`) are likewise reused from
// `modules/jobs`.

import { defineLocalStore } from '@txresbench/framework/store-kit'
import type { JobDetail, JobListItem } from '@/api-client/types'
import { createJobsLifecycle } from '@/modules/jobs/jobsLifecycle'
import { buildJobsListQuery, DEFAULT_JOBS_PER_PAGE } from './jobsScope'
import { Jobs } from '@/modules/jobs/Jobs.store'

export const JobsPaneStore = defineLocalStore({
  immer: true,
  state: {
    projectId: '' as string,
    // List ROWS (`{ job, can_stop }`) — see `modules/jobs/stopAuthority`.
    jobs: [] as JobListItem[],
    total: 0,
    page: 1,
    perPage: DEFAULT_JOBS_PER_PAGE,
    loading: false,
    error: null as string | null,
    // Detail view (selected job).
    selectedId: null as string | null,
    detail: null as JobDetail | null,
    detailLoading: false,
    streaming: false,
  },
  actions: (set, get) => {
    // The ONE project-scoping seam: every list carries `?project_id=X` (the
    // `job_scope` JOIN). A `null` query short-circuits the fetch before the pane is
    // seeded (pre-`start`); everything else is the shared lifecycle.
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => {
        const projectId = get().projectId
        return projectId ? buildJobsListQuery(projectId, page, perPage) : null
      },
    })

    const setPage = (page: number) => {
      void lifecycle.load(page)
    }

    /** Bind the pane to its project + fetch its list once (mount entrypoint). Liveness
     *  is the `sync:job` subscription wired in `init` — not a poll. */
    const start = (projectId: string) => {
      set(s => {
        s.projectId = projectId
      })
      void lifecycle.load(1)
    }

    /** Full teardown (unmount): abort any live stream. The `sync:job` subscription is
     *  auto-unsubscribed by the store-kit on destroy. */
    const teardown = () => {
      lifecycle.closeDetail()
    }

    return { ...lifecycle, setPage, start, teardown }
  },
  init: ({ get, on, actions, onCleanup }) => {
    // `projectId` is seeded via `use({ projectId })` before init runs on mount.
    actions.start(get().projectId)
    // Notify-and-refetch (§7): stay live off the jobs backend's `SyncEntity::Job`
    // frames (self-gated by `JobsUse`); `lifecycle.load` re-reads the pane's current
    // `project_id`, so a project-scoped refetch always fetches the bound project.
    actions.subscribeSync(on)
    onCleanup(() => actions.teardown())
  },
})
