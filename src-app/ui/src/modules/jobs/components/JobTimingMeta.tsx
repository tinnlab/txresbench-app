import {
  exitCodeLabel,
  formatJobDuration,
  formatRelative,
  formatTimestamp,
  primaryTimestamp,
  type TimedJobLike,
} from '../jobTiming'

/**
 * A compact, wrapping meta row for a job's TIMING: its primary lifecycle timestamp
 * (Queued / Started / Finished · a locale datetime), the elapsed/total duration
 * ("Ran 2m 13s" or, live, "Running 42s"), and the exit code when the run produced
 * one. Presentational + prop-driven — the drawer detail and the workbench pane both
 * render it from the same `Job`. Every value is humanized (never a raw ISO string,
 * raw ms, or a bare id); an absent field is simply omitted.
 */
export function JobTimingMeta({ job }: { job: TimedJobLike }) {
  const duration = formatJobDuration(job)
  const primary = primaryTimestamp(job)
  const relative = formatRelative(primary.iso)
  const exit = exitCodeLabel(job)
  const running = job.status === 'running'

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      data-testid="job-timing-meta"
    >
      <span data-testid="job-timing-primary">
        <span className="text-foreground/70">{primary.label}</span> {formatTimestamp(primary.iso)}
        {relative ? <span className="text-muted-foreground"> · {relative}</span> : null}
      </span>
      {duration ? (
        <span className="tabular-nums" data-testid="job-timing-duration">
          <span className="text-foreground/70">{running ? 'Running' : 'Ran'}</span> {duration}
        </span>
      ) : null}
      {exit ? (
        <span className="tabular-nums" data-testid="job-timing-exit">
          {exit}
        </span>
      ) : null}
    </div>
  )
}
