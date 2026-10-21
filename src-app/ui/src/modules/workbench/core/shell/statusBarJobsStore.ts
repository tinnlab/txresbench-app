// StatusBarJobsStore — a lightweight, PROJECT-scoped count of RUNNING jobs for the
// workbench status-bar indicator. Distinct from the per-pane `JobsPaneStore` (the full
// Jobs monitor) and the global `Jobs` drawer (owner-wide): this holds ONLY the
// running count, refreshed on `sync:job`, so the ALWAYS-mounted status bar stays cheap.
// `defineLocalStore` gives it clean mount/teardown — the store-kit auto-unsubscribes the
// `sync:job` listener when the status bar unmounts (same lifecycle discipline as `JobsPaneStore`).
//
// Counting: `GET /api/jobs` has NO status filter (`JobsListQuery = {page,per_page,
// project_id}`), so we count `running` client-side from the FIRST page (newest-first, ≤50
// rows) — bounded + cheap, never fetch-all. LIMITATION: a job STILL running while ≥50
// newer jobs pile up ahead of it falls off page 1 and is under-counted; an EXACT count
// needs a backend `status` filter (follow-up). Live via notify-and-refetch: the jobs
// backend emits `SyncEntity::Job` on every list-status transition, so a `sync:job` (and
// `sync:reconnect`) refetch drives the running count + the completion toast — no poll.

import { defineLocalStore } from '@ziee/framework/store-kit'
import { toast } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import { type Job, type JobListItem } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { rememberJobNames } from '@/modules/jobs/jobNames'
import { JOBS_LIST_MAX_PER_PAGE } from '../../extensions/jobs/jobsScope'
import { revealPane } from './regions/openPane'
import { Jobs } from '@/modules/jobs/Jobs.store'

/** declarative-canvas-plots ITEM-36 — a job's terminal statuses (the toast-firing set). */
const TERMINAL = new Set(['completed', 'failed'])

/** The class the sticky ack's own SURFACE carries: it renders and it reads, and it never takes a
 *  pointer event. See the rule pair in `src/index.css` for why. */
export const JOB_TOAST_PASSTHROUGH_CLASS = 'job-toast-passthrough'
/** The class each control the ack OWNS carries — the exception to the surface's pass-through, so
 *  "View job" and the close button still answer a pointer normally. */
export const JOB_TOAST_CONTROL_CLASS = 'job-toast-control'
/** One stable test id per acked job. */
export const jobToastTestId = (jobId: string): string => `job-toast-${jobId}`

/**
 * Fire the STICKY job-completion toast (ITEM-36, DEC-16): a kit toast with `duration: Infinity`
 * (no auto-dismiss). Variant by outcome (success vs error+reason). Its "View job" action opens the
 * Jobs pane deep-linked to THIS job's details (`revealPane('jobs', job.id)`). NOT the notification
 * module — an immediate local "your run finished" ack.
 *
 * ── WHY IT ALSO HAS A CLOSE BUTTON AND TAKES NO POINTER EVENTS ────────────────────────────────
 *
 * DEC-16 chose a permanent ack so a user who stepped away still learns their run finished. That
 * is kept: `duration: Infinity` is unchanged and nothing here expires it. What DEC-16 did not
 * decide — and what shipped by omission — is that the ONLY exit was "View job", and that the ack
 * owned the pointer over its whole footprint for as long as it lived. Measured on the workbench:
 * the ack parks bottom-right, directly over the per-analysis run list, and a mouse click on a run
 * row underneath never reached the row; taking the one exit selected the Jobs tab and unmounted
 * the pane the user was reading. A permanent ack is a decision; a permanent click-blocker whose
 * only escape costs you your place is a trap.
 *
 * Two additions, both through sonner's OWN options — never by reaching into the toast layer's DOM
 * (a test helper once removed those nodes by hand and the next render threw `NotFoundError` out
 * of the root error boundary; `tests/e2e/14-declarative-qc/_seed.ts` records it at length):
 *
 *   • `closeButton` — a dismissal that is not a navigation. After it the user is still where
 *     they were.
 *   • the pass-through class pair — the ack renders and reads but does not intercept; its own
 *     controls opt back in. So the content it happens to sit over stays usable, which is what
 *     makes a permanent overlay tolerable at all.
 *
 * Cost, stated: with the surface pointer-transparent, sonner's swipe-to-dismiss and
 * hover-to-pause no longer apply to this toast, and its text cannot be selected. Swipe and pause
 * are both moot for something that never expires and now has an explicit close; the error text a
 * failed run reports in full is in the job detail the ack links to.
 */
export function fireJobToast(job: Job): void {
  const ok = job.status === 'completed'
  const toastId = `wb-job-${job.id}`
  toast(ok ? `${job.name || job.job_type} finished` : `${job.name || job.job_type} failed`, {
    id: toastId,
    testId: jobToastTestId(job.id),
    duration: Infinity,
    closeButton: true,
    classNames: {
      toast: JOB_TOAST_PASSTHROUGH_CLASS,
      actionButton: JOB_TOAST_CONTROL_CLASS,
      closeButton: JOB_TOAST_CONTROL_CLASS,
    },
    description: ok ? 'Click to view the artifacts.' : (job.error ?? 'Click to view the error.'),
    action: {
      label: 'View job',
      onClick: () => {
        revealPane('jobs', job.id)
        toast.dismiss(toastId)
      },
    },
  })
}

/**
 * Should THIS refetch frame raise the ack for this job?
 *
 * Pure so the rule is testable without a refetch, an ApiClient or a clock. TWO transitions count:
 *
 *   • the OBSERVED one — the job was non-terminal in the previous frame and is terminal now;
 *   • the MISSED one — the job is terminal the FIRST time we see it AND it is newer than
 *     anything the previous frame held, so it was created *and* finished between two refetches.
 *
 * The second is not a nicety. A refetch reads a full page, so a job that was created and
 * finished between two `sync:job` frames landing (a small analysis finishes in about a
 * second) is seen only in its terminal state — without this branch it produces NO ack at
 * all, and the user launches a job and never learns what happened to it, which is the very
 * thing DEC-16 asked for. Measured: `tests/e2e/14-declarative-qc/job-toast.spec.ts`, the
 * DEC-16 spec itself, fails on a host where compute is fast, with an empty Notifications
 * region and both runs having completed before the first post-create refetch observed them
 * as running.
 *
 * It stays conservative in the two ways that matter. `seeded` keeps the FIRST frame silent, so a
 * project's existing history never acks on arrival. And "newer than anything the previous frame
 * held" compares a SERVER timestamp with a SERVER timestamp — never against the client clock —
 * so a row that merely became VISIBLE (a deleted job shifting the newest-first page-1 window down
 * onto an older one) is not mistaken for a run that just finished. An unreadable `created_at`
 * cannot establish "this ran while we were watching", so it does not ack.
 */
export function shouldFireJobToast(args: {
  status: string
  createdAtMs: number
  prior: string | undefined
  seeded: boolean
  newestSeenMs: number
}): boolean {
  const { status, createdAtMs, prior, seeded, newestSeenMs } = args
  if (!seeded || !TERMINAL.has(status)) return false
  if (prior !== undefined) return !TERMINAL.has(prior)
  return Number.isFinite(createdAtMs) && createdAtMs > newestSeenMs
}

export const StatusBarJobsStore = defineLocalStore({
  // immer: the `set(s => { s.x = y })` mutations below are draft mutations (matches
  // `JobsPaneStore`). WITHOUT this flag a mutating callback returns `undefined` and wipes
  // the state → `get().projectId` throws "reading 'projectId'".
  immer: true,
  state: {
    projectId: '' as string,
    running: 0,
    /** The current page of this project's jobs, as last refetched — LIST ROWS
     *  (`JobListItem = { job, can_stop }`), not bare jobs, because that is the wire shape of
     *  `GET /api/jobs`: the server states per row whether THIS caller may stop THAT job, so no
     *  surface has to re-derive the rule (see `modules/jobs/stopAuthority`). This store renders
     *  no Stop control itself; consumers that only want the jobs unwrap `row.job`.
     *
     *  Exposed so the per-analysis run list can read the page this store ALREADY fetches instead
     *  of standing up a second fetcher against the same endpoint. Two independent fetchers would
     *  disagree with each other transiently, and the disagreement would surface as a run that
     *  appears in one place and not the other. BOUNDED by the same `per_page` the refetch requests. */
    jobs: [] as JobListItem[],
  },
  actions: (set, get) => {
    // ITEM-36: per-job prior status (off reactive state), so a refetch can detect a job TRANSITIONING
    // into a terminal status and fire the sticky toast exactly once. `seeded` suppresses toasts on
    // the FIRST refetch (already-terminal jobs are history, not a just-finished transition).
    // BOUNDED: each refetch REBUILDS the map from ONLY the current page's jobs (≤ per_page entries), so
    // it can never grow unbounded — a job that falls off page 1 is dropped (consistent with the
    // documented pagination LIMITATION; an exact off-page-1 count needs a backend status filter).
    let prevStatus = new Map<string, string>()
    let seeded = false
    // The newest `created_at` any frame has held so far, as a SERVER timestamp. It is what lets
    // `shouldFireJobToast` tell "this ran entirely between two refetches" (the fast-run case, which
    // is otherwise never acked) from "an older row just became visible". See that function.
    let newestSeenMs = Number.NEGATIVE_INFINITY
    // In-flight guard + TRAILING-EDGE coalesce: overlapping refetches are serialized, not run
    // concurrently (a burst of `sync:job` frames — several jobs transitioning at once — would
    // otherwise fire two loads both reading `prevStatus` before either writes, double-evaluating a
    // transition; masked only by the toast-id de-dup). But a frame that lands DURING a load must
    // not simply be dropped: the old 3 s poll recovered a dropped frame within a tick, and that
    // safety net is gone. So a frame arriving while `loading` sets `pending`, and the in-flight
    // load re-runs ONCE on completion — the follow-up sees the now-committed terminal states, so a
    // concurrent-completion burst still fires every toast and settles the running count to 0. The
    // re-run coalesces a whole burst into a single extra load, not one per frame.
    let loading = false
    let pending = false

    const load = async () => {
      const projectId = get().projectId
      // The permission check is guarded because it READS A GLOBAL — `hasPermissionNow` throws
      // when no auth view has been registered, which is every harness that mounts a workbench
      // surface without booting the app. An unresolvable permission is treated as ABSENT: a
      // refetch that cannot establish it must not run. (Before the per-analysis run list started
      // driving this load, only the status bar did, and the status bar never mounts in those
      // harnesses — so the throw was there all along and nothing had reached it.)
      let allowed = false
      try {
        allowed = hasPermissionNow(Permissions.JobsUse)
      } catch {
        allowed = false
      }
      if (!projectId || !allowed) return
      // A frame arriving mid-load is not dropped: record it and let the in-flight load re-run once
      // when it finishes (trailing edge), so the last transition of a burst is never lost.
      if (loading) {
        pending = true
        return
      }
      loading = true
      try {
        const res = await ApiClient.Jobs.list({
          project_id: projectId,
          page: 1,
          per_page: JOBS_LIST_MAX_PER_PAGE,
        })
        // A concurrent project switch invalidated this response — drop it (the new project's
        // refetch owns the state now).
        if (get().projectId !== projectId) return
        // This store is the workbench's ALWAYS-ON view of its project's jobs (the status bar is
        // mounted for as long as the workbench is), so it is what lets a jobs TAB name its job
        // whether or not any jobs pane is open. See `jobNames`.
        rememberJobNames(res.jobs)
        const running = res.jobs.filter(r => r.job.status === 'running').length
        set(s => {
          s.running = running
          s.jobs = res.jobs
        })
        // ITEM-36 — fire the sticky toast on a terminal transition, observed or missed (skip the
        // first refetch). Rebuild the map from the current page only (prunes fallen-off ids → bounded).
        const next = new Map<string, string>()
        let newest = newestSeenMs
        for (const row of res.jobs) {
          const job = row.job
          const createdAtMs = Date.parse(String(job.created_at ?? ''))
          if (
            shouldFireJobToast({
              status: job.status,
              createdAtMs,
              prior: prevStatus.get(job.id),
              seeded,
              newestSeenMs,
            })
          ) {
            fireJobToast(job)
          }
          next.set(job.id, job.status)
          if (Number.isFinite(createdAtMs)) newest = Math.max(newest, createdAtMs)
        }
        prevStatus = next
        newestSeenMs = newest
        seeded = true
      } catch {
        /* keep the last known count on a transient failure */
      } finally {
        loading = false
        // Trailing edge: a frame (or burst) arrived while this load was in flight — run once more
        // so the transition it carried is evaluated against the state this load just wrote.
        if (pending) {
          pending = false
          void load()
        }
      }
    }

    /** Bind (or re-bind) the store to `projectId` and fetch its list once. Liveness is the
     *  `sync:job` subscription wired in `init` — not a timer — so this is just the initial seed
     *  and the project-switch re-seed; it's idempotent (a second caller costs one deduped load). */
    const start = (projectId: string) => {
      // A project switch resets the transition tracker so we neither toast the new project's
      // pre-existing terminal jobs nor carry the old project's ids (unbounded-growth guard).
      if (get().projectId !== projectId) {
        prevStatus = new Map()
        seeded = false
        newestSeenMs = Number.NEGATIVE_INFINITY
        pending = false // drop any queued trailing refetch for the project we're leaving
        set(s => {
          s.running = 0
        })
      }
      set(s => {
        s.projectId = projectId
      })
      void load()
    }

    return { load, start }
  },
  init: ({ on, actions }) => {
    // The consumer (re)binds to the current project via `start(projectId)` — the status bar
    // stays mounted across an in-place project switch, so binding can't be a one-shot at mount.
    // Liveness is notify-and-refetch (§7): the jobs backend emits `SyncEntity::Job` on every
    // list-status transition, so a `sync:job` (and `sync:reconnect`) refetch drives the running
    // count + the completion toast. `load()` self-gates on `JobsUse` + a bound project, so a frame
    // arriving before `start` (or without the perm) is a no-op. The store-kit auto-unsubscribes on
    // destroy — no manual teardown.
    on('sync:job', () => void actions.load())
    on('sync:reconnect', () => void actions.load())
  },
})
