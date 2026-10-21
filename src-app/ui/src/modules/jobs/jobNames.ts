// jobNames — the AMBIENT "what is this job called" lookup.
//
// ── WHY IT IS NOT A STORE, AND NOT PANE STATE ───────────────────────────────────────────────
//
// A workbench tab has to be able to name a job it is not rendering. A region renders only its
// ACTIVE tab, so anything a job pane learns on mount does not exist for the panes the user is
// not looking at — the same defect `paneModel`'s entity resolvers were moved out of the pane
// components to remove. And the two stores that DO hold jobs are both wrong to read from here:
// `JobsPaneStore` is a `defineLocalStore` (one instance per MOUNTED pane) and `Jobs` is the
// owner-wide drawer singleton that is only loaded while the drawer is open.
//
// So the name is remembered where every jobs fetch already passes: `createJobsLifecycle`'s list
// + detail loads (the drawer AND every jobs pane) and the workbench status bar's project poll
// (`statusBarJobsStore`, mounted for as long as the workbench is). Whatever those saw, this
// knows — and it knows it without owning a fetch of its own, which is the point: this module
// must never become a third poller against `/api/jobs`.
//
// ── BOUNDED ────────────────────────────────────────────────────────────────────────────────
//
// A session that watches many jobs would otherwise grow this map forever (the same
// unbounded-growth hazard `statusBarJobsStore`'s per-job status map calls out). `Map` iterates in
// INSERTION order, and `remember` re-inserts every id it is told about, so the ids the live polls
// keep seeing stay at the young end and eviction takes the oldest — which is exactly the set no
// open tab is naming.

/** A job, as much of one as naming needs. Structural, so `Job`/`JobDetail['job']`/a test row all fit. */
export interface NamedJobLike {
  readonly id: string
  readonly name?: string | null
  readonly job_type?: string | null
}

/**
 * What a fetch hands over: either a job, or a LIST ROW wrapping one.
 *
 * `GET /api/jobs` returns `JobListItem = { job, can_stop }` rather than a bare `Job` (the
 * server states per row whether THIS caller may stop it — see `stopAuthority`), while the
 * detail load still hands over `detail.job` directly. Both name a job, and naming is the only
 * thing this module does, so it accepts either shape and unwraps rather than making every
 * fetch site map first — a `.map(r => r.job)` at four call sites is four places to forget.
 */
export type NamedJobRow = NamedJobLike | { readonly job: NamedJobLike }

/** The job inside a row, whichever of the two shapes arrived. */
function jobOf(row: NamedJobRow): NamedJobLike | null {
  if (!row || typeof row !== 'object') return null
  const inner = (row as { readonly job?: NamedJobLike }).job
  if (inner && typeof inner === 'object') return inner
  return row as NamedJobLike
}

/** How many job names are retained. Bounded on purpose — see the header. */
export const JOB_NAME_CACHE_MAX = 500

const names = new Map<string, string>()
const listeners = new Set<() => void>()

/**
 * What a job is CALLED, for a human.
 *
 * `name` first, `job_type` when it is blank — the same two-step `fireJobToast` already uses for
 * the completion ack, so a job reads the same in the toast and on the tab. A job with neither is
 * unnameable and yields `null` rather than an empty string, so a caller can tell "no name" from
 * "named the empty string" and print its own honest fallback.
 */
function displayNameOf(job: NamedJobLike): string | null {
  const name = typeof job.name === 'string' ? job.name.trim() : ''
  if (name) return name
  const type = typeof job.job_type === 'string' ? job.job_type.trim() : ''
  return type || null
}

/** Learn (or refresh) the names in a fetched batch. Notifies subscribers only when something
 *  a reader could observe actually changed — a 3 s poll that returns the same page must not
 *  re-render every tab strip in the app. */
export function rememberJobNames(rows: readonly NamedJobRow[]): void {
  let changed = false
  for (const row of rows) {
    const job = jobOf(row)
    if (!job || typeof job.id !== 'string' || !job.id) continue
    const next = displayNameOf(job)
    if (next === null) continue
    if (names.get(job.id) !== next) changed = true
    // delete-then-set moves the id to the YOUNG end of the insertion order, so the jobs the
    // live polls keep seeing are the last ones eviction would reach.
    names.delete(job.id)
    names.set(job.id, next)
  }
  while (names.size > JOB_NAME_CACHE_MAX) {
    const oldest = names.keys().next()
    if (oldest.done) break
    names.delete(oldest.value)
    changed = true
  }
  if (changed) for (const l of [...listeners]) l()
}

/** The job's display name, or `null` when no fetch has named it yet. NEVER the id: a caller
 *  that cannot name the job must say so in its own words rather than print a uuid. */
export function jobDisplayName(id: string | undefined): string | null {
  return id ? (names.get(id) ?? null) : null
}

/** Subscribe to "a name was learned or dropped". Returns the unsubscribe. */
export function subscribeJobNames(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test-only reset (mirrors `__resetPaneState`). */
export function __resetJobNames(): void {
  names.clear()
}
