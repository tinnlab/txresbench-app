// jobTiming — small PURE presentation helpers for a job's timing.
//
// A job carries `created_at` (always), `started_at?`, `finished_at?`, and
// `exit_code?` on the wire (`Job`), but the two job-monitor detail surfaces
// (the global drawer `JobDetail` and the workbench `JobsPane`) rendered NONE of
// them — a completed run showed only a status badge, never "ran 2m 13s / finished
// 12:03 / exit 0". These helpers humanize that timing the way `datasets/lib/format.ts`
// humanizes bytes/dates: coarse, guarded against NaN/absent, deterministic.

/** A job, as much of one as timing needs. Structural so `Job`/`JobDetail['job']`/a test row all fit. */
export interface TimedJobLike {
  readonly status: string
  readonly created_at: string
  readonly started_at?: string | null
  readonly finished_at?: string | null
  readonly exit_code?: number | null
}

/** Parse an ISO instant to epoch ms, or `null` if absent/unparseable (never NaN). */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * Humanize a millisecond span into one or two coarse units — never raw ms.
 *   <1s → "820ms" · <60s → "42s" · <60m → "2m 13s" · ≥1h → "1h 04m".
 * A negative/NaN span degrades to "—" (clock skew / bad data must not print "NaN").
 */
export function formatDurationMs(span: number): string {
  if (!Number.isFinite(span) || span < 0) return '—'
  // Round FIRST, then gate — otherwise a span in [999.5, 1000) rounds to 1000 and
  // prints "1000ms" instead of rolling over to "1s".
  const roundedMs = Math.round(span)
  if (roundedMs < 1000) return `${roundedMs}ms`
  const totalSec = Math.round(span / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) {
    const s = totalSec % 60
    return s ? `${totalMin}m ${s}s` : `${totalMin}m`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/**
 * The elapsed run time of a job, in ms, or `null` when there is nothing to time.
 *  - not yet started (queued, or a job refused before spawn) → `null`
 *  - running → now − started_at (live; the caller passes `now` so it can tick)
 *  - finished with a start → finished_at − started_at
 *  - finished without ever starting → `null` (it never ran)
 */
export function jobElapsedMs(job: TimedJobLike, now: number = Date.now()): number | null {
  const start = ms(job.started_at)
  if (start === null) return null
  const end = ms(job.finished_at) ?? (job.status === 'running' ? now : null)
  if (end === null) return null
  return end - start
}

/** The humanized elapsed duration, or `null` when there is nothing to time. */
export function formatJobDuration(job: TimedJobLike, now: number = Date.now()): string | null {
  const span = jobElapsedMs(job, now)
  return span === null ? null : formatDurationMs(span)
}

/**
 * An absolute, locale-formatted local datetime for a timestamp label — never the
 * raw ISO string. `Intl.DateTimeFormat` reads the client's locale + timezone
 * (auto-detected, read-only — the input-economy rule). Returns "—" for an absent
 * or unparseable instant.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  const t = ms(iso)
  if (t === null) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t))
}

/**
 * A concise relative hint via `Intl.RelativeTimeFormat` with `numeric: 'auto'`, so
 * the engine picks the idiomatic phrasing for each bucket: "now" / "12 seconds ago"
 * / "3 minutes ago" / "in 2 hours" / "2 days ago". Returns "" for an absent/
 * unparseable instant so a caller can omit it cleanly.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const t = ms(iso)
  if (t === null) return ''
  const diffSec = Math.round((t - now) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 45) return rtf.format(diffSec, 'second')
  if (abs < 45 * 60) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 22 * 3600) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86400), 'day')
}

/**
 * How a job's exit code reads for a human, or `null` when there is no exit code to
 * show (still running / queued / a job that never produced one). "exit 0" / "exit 1".
 */
export function exitCodeLabel(job: TimedJobLike): string | null {
  if (job.exit_code === null || job.exit_code === undefined) return null
  return `exit ${job.exit_code}`
}

/**
 * The label for a job's PRIMARY timestamp — the most informative single instant
 * for its lifecycle state: finished (terminal), started (running), or created
 * (queued). Returns `{ label, iso }` so a surface can show "Finished · Aug 19, 12:03".
 */
export function primaryTimestamp(job: TimedJobLike): { label: string; iso: string } {
  if (job.finished_at) return { label: 'Finished', iso: job.finished_at }
  if (job.started_at) return { label: 'Started', iso: job.started_at }
  return { label: 'Queued', iso: job.created_at }
}
