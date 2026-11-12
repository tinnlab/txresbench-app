// jobsLifecycle (DRIFT-4.4) — the shared jobs list / detail / SSE-stream / stop /
// SYNC-refetch lifecycle, hoisted out of the two near-identical stores it used to be
// copied across: the global singleton `Jobs.store` (the sidebar Jobs drawer) and the
// per-pane, project-scoped workbench `JobsPaneStore`. Every line of the select /
// stream / stop machinery lived TWICE; it now lives here ONCE.
//
// LIVENESS is notify-and-refetch (§7), NOT a poll. The jobs backend emits
// `SyncEntity::Job` on every list-status transition — create (queued), claim
// (running), stop, out-of-scheduler close, and finalize (terminal) — addressed to
// everyone the job is visible to (`RealJobSyncSink`, `modules/jobs/seams.rs`). So each
// surface `subscribeSync(on)`s to `sync:job` (+ `sync:reconnect`) and REFETCHES the
// list, self-gated by the read-perm the refetch endpoint enforces. There is no 3 s
// `setInterval` bridge any more — it was the DESCOPE-32 stopgap for while `sync:job`
// was inert, and both are now live (the seam is installed REAL in `JobsModule::init`).
// The per-job live LOG/METRIC/STATUS stream (`select` → `ApiClient.Jobs.stream`) is a
// SEPARATE channel and is untouched: sync tells the LIST a row changed; the stream
// carries an OPEN job's live progress.
//
// Project scoping is the ONLY axis on which the two callers differ, so it's the ONE
// thing injected — `opts.buildListQuery`. The drawer passes the project-less
// `{ page, per_page }` (byte-identical to the pre-hoist `ApiClient.Jobs.list`); the
// pane passes the `?project_id=X` `job_scope` query (and `null` to skip an unseeded
// fetch). Nothing else varies.
//
// `createJobsLifecycle` is called ONCE per store instance (the singleton builds one
// closure at `create()` time; each mounted pane builds its own via `defineLocalStore`),
// so the non-reactive `streamAbort` ref it closes over is correctly per-instance — a
// popped-out or closed pane can't leak another's stream.

import { ApiClient } from '@/api-client'
import {
  type JobDetail,
  type JobListItem,
  type JobLog,
  type JobMetric,
  type JobsListQuery,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import type { StoreSet } from '@txresbench/framework/store-kit'
import { rememberJobNames } from './jobNames'

/**
 * The reactive state every jobs list/detail surface shares. Both the singleton
 * `Jobs.store` and the workbench `JobsPaneStore` declare (at least) these fields —
 * each may add its own extras (the drawer's `creating`, the pane's `projectId`) —
 * so both can compose `createJobsLifecycle` over this common shape.
 */
export interface JobsLifecycleState {
  /**
   * The page of list ROWS, not bare jobs: `GET /api/jobs` returns
   * `JobListItem = { job, can_stop }`. `can_stop` is the SERVER'S answer to "may THIS caller
   * stop THIS job" (creator / scope owner / admin) — the surfaces render it directly rather
   * than re-deriving the rule from a role they can see (see `stopAuthority`). So the row is
   * carried whole through the store; unwrap to `row.job` only where a job is what is meant.
   */
  jobs: JobListItem[]
  total: number
  page: number
  perPage: number
  loading: boolean
  error: string | null
  // Detail view (selected job).
  selectedId: string | null
  detail: JobDetail | null
  detailLoading: boolean
  streaming: boolean
}

/**
 * The store-kit `on` this lifecycle needs to wire its live refetch — narrowed to the
 * two sync events it listens on. The init-context `on` (generic over every AppEvent)
 * is structurally assignable here, so a store passes its own `on` straight through.
 */
export type JobsSyncOn = (event: 'sync:job' | 'sync:reconnect', handler: () => void) => void

export interface JobsLifecycleOptions {
  /**
   * Build the `GET /api/jobs` list query for a page — the SINGLE project-scoping seam
   * (DRIFT-4.4). Return the query to fetch, or `null` to SKIP the fetch (an unseeded
   * project-scoped pane). The global drawer returns the project-less
   * `{ page, per_page }` (byte-identical to the pre-hoist behavior); the workbench
   * pane returns the `?project_id=X` scoped query.
   */
  buildListQuery: (page: number, perPage: number) => JobsListQuery | null
}

/**
 * The shared list / detail / stream / stop / sync-refetch actions. Returns exactly the
 * lifecycle actions both stores need; each store spreads them and adds its own extras
 * (drawer: `create` / `setPerPage`; pane: `setPage` / `start` / `teardown`).
 */
export function createJobsLifecycle<S extends JobsLifecycleState>(
  set: StoreSet<S>,
  get: () => S,
  opts: JobsLifecycleOptions,
) {
  // Non-reactive per-instance ref (kept off reactive state so a per-frame log/metric
  // frame doesn't churn subscribers).
  let streamAbort: AbortController | null = null

  const load = async (page = get().page) => {
    const query = opts.buildListQuery(page, get().perPage)
    // `null` = nothing to fetch (an unseeded project-scoped pane); leave state as-is.
    if (!query) return
    set(s => {
      s.loading = true
      s.error = null
    })
    try {
      const res = await ApiClient.Jobs.list(query)
      // Every jobs fetch feeds the ambient name lookup (`jobNames`), so a surface that holds a
      // job ID but no job ROW — a workbench tab deep-linked by `revealPane('jobs', id)` — can
      // name it without standing up a fetch of its own.
      rememberJobNames(res.jobs)
      set(s => {
        s.jobs = res.jobs
        s.total = res.total
        s.page = res.page
        s.perPage = res.per_page
      })
    } catch (e) {
      set(s => {
        s.error = e instanceof Error ? e.message : 'Failed to load jobs'
      })
    } finally {
      set(s => {
        s.loading = false
      })
    }
  }

  const stop = async (id: string) => {
    const updated = await ApiClient.Jobs.stop({ id })
    set(s => {
      const row = s.jobs.find(r => r.job.id === id)
      if (row) row.job.status = updated.status
      if (s.detail && s.detail.job.id === id) s.detail.job.status = updated.status
    })
    // A queued cancel is immediate; a running stop resolves via the stream's status
    // frame. Refetch to reflect either promptly.
    void load()
  }

  const closeDetail = () => {
    if (streamAbort) {
      streamAbort.abort()
      streamAbort = null
    }
    set(s => {
      s.selectedId = null
      s.detail = null
      s.streaming = false
    })
  }

  const select = async (id: string) => {
    // Tear down any prior stream before switching.
    if (streamAbort) {
      streamAbort.abort()
      streamAbort = null
    }
    set(s => {
      s.selectedId = id
      s.detail = null
      s.detailLoading = true
      s.streaming = false
    })

    const seenLog = new Set<number>()
    try {
      const detail = await ApiClient.Jobs.get({ id })
      // The detail load is the OTHER place a name arrives, and the only one that names a job
      // which has fallen off the list's first page.
      rememberJobNames([detail.job])
      detail.logs.forEach(l => seenLog.add(l.seq))
      set(s => {
        s.detail = detail
        s.detailLoading = false
      })
    } catch (e) {
      set(s => {
        s.detailLoading = false
        s.error = e instanceof Error ? e.message : 'Failed to load job'
      })
      return
    }

    // Open the live logs/metrics/status stream. Not awaited — the promise resolves
    // when the stream ends (job terminal / abort); frames arrive via the callbacks.
    // Deduped by seq (logs) / id (metrics) against the replay.
    void ApiClient.Jobs.stream(
      { id },
      {
        SSE: (event: string, data: unknown) => {
          if (event === '__init') {
            streamAbort = (data as { abortController: AbortController }).abortController
            set(s => {
              s.streaming = true
            })
            return
          }
          // Ignore frames for a job the user has since navigated away from.
          if (get().selectedId !== id) return
          if (event === 'log') {
            const l = data as JobLog
            if (seenLog.has(l.seq)) return
            seenLog.add(l.seq)
            set(s => {
              s.detail?.logs.push(l)
            })
          } else if (event === 'metric') {
            const m = data as JobMetric
            set(s => {
              if (s.detail && !s.detail.metrics.some(x => x.id === m.id)) {
                s.detail.metrics.push(m)
              }
            })
          } else if (event === 'status') {
            const status = (data as { status: string }).status
            set(s => {
              if (s.detail) s.detail.job.status = status
              const row = s.jobs.find(r => r.job.id === id)
              if (row) row.job.status = status
            })
          }
        },
      },
    )
      .catch(() => {
        /* stream ended / aborted */
      })
      .finally(() => {
        if (get().selectedId === id) {
          set(s => {
            s.streaming = false
          })
        }
        // The open job just terminated (or the stream dropped) — refresh the list
        // immediately from the detail stream's own end, rather than waiting on the
        // job's `sync:job` frame to make the same round trip.
        void load()
      })
  }

  /**
   * Wire the live LIST refetch: on every `sync:job` (a job the caller can see changed
   * list-status) and on `sync:reconnect` (the SSE stream re-established — the list may
   * have moved while it was down), refetch. Self-gated by `JobsUse` so a user who lost
   * the read-perm never fires a doomed 403 on reconnect (`sync:reconnect` fans to every
   * store regardless of the frame's server-side audience). Registered via the store's
   * init `on`, so the store-kit auto-unsubscribes it on destroy — no manual teardown.
   *
   * This REPLACES the old `startPolling`/`stopPolling` 3 s `setInterval`: the same cheap
   * list refetch, now driven by the exact transitions instead of a timer, so a
   * running→completed change lands immediately rather than up to 3 s late — and an idle
   * jobs surface issues ZERO requests.
   */
  const subscribeSync = (on: JobsSyncOn) => {
    const refetch = () => {
      // `hasPermissionNow` reads a global auth view and THROWS if none is registered — which is
      // every workbench-component harness that mounts a jobs surface without booting the app. An
      // unresolvable permission is treated as ABSENT (a refetch that cannot establish it must not
      // run), mirroring `statusBarJobsStore.load`.
      let allowed = false
      try {
        allowed = hasPermissionNow(Permissions.JobsUse)
      } catch {
        allowed = false
      }
      if (!allowed) return
      void load()
    }
    on('sync:job', refetch)
    on('sync:reconnect', refetch)
  }

  return { load, stop, closeDetail, select, subscribeSync }
}
