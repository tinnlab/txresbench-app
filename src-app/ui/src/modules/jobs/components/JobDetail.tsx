import { useEffect, useRef } from 'react'
import { Button, Spin, message } from '@ziee/kit'
import { IoIosArrowBack } from 'react-icons/io'
import { Jobs } from '@/modules/jobs/Jobs.store'
import { JobStatusBadge } from './JobStatusBadge'
import { JobTimingMeta } from './JobTimingMeta'
import { JobMilestoneSteps } from './JobMilestoneSteps'
import { TimeSeriesChart } from './TimeSeriesChart'
import { jobStopUnavailableReason } from '../stopAuthority'

function isActive(status: string) {
  return status === 'queued' || status === 'running'
}

/**
 * The Jobs drawer DETAIL view: a followable result stream — live logs + a CPU
 * chart + a memory chart + Stop — for the selected job.
 */
export function JobDetail() {
  const { detail, detailLoading, streaming } = Jobs
  const logRef = useRef<HTMLDivElement>(null)
  const logCount = detail?.logs.length ?? 0

  // Auto-scroll the log pane to the newest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logCount])

  if (detailLoading && !detail) {
    return (
      <div className="flex justify-center py-12">
        <Spin size="lg" label="Loading job" />
      </div>
    )
  }
  if (!detail) return null

  // `can_stop` rides the detail wire alongside the job (`GET /api/jobs/{id}`), so a job
  // opened directly — a deep link, a reload — renders its Stop from the same server-stated
  // answer the list uses. See `modules/jobs/stopAuthority`.
  const { job, logs, metrics, milestones, can_stop } = detail
  const cpu = metrics.map(m => ({ t: m.sampled_at, v: m.cpu_pct }))
  const mem = metrics.map(m => ({ t: m.sampled_at, v: m.mem_bytes / 1048576 }))

  const stopJob = async () => {
    try {
      await Jobs.stop(job.id)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to stop job')
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="job-detail">
      {/* Header: back to list · name · status · stop */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          tooltip="Back to jobs"
          onClick={() => Jobs.closeDetail()}
          data-testid="job-detail-back"
        >
          <IoIosArrowBack aria-hidden="true" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {job.name || job.job_type}
          </div>
          <div className="text-xs text-muted-foreground">{job.job_type}</div>
        </div>
        <JobStatusBadge status={job.status} />
        {/* Status decides whether Stop EXISTS; `can_stop` decides whether it FIRES. A
            caller the server would refuse sees it, unavailable, with the reason. */}
        {isActive(job.status) && (
          <Button
            variant="destructive"
            unavailableReason={jobStopUnavailableReason(can_stop)}
            onClick={stopJob}
            data-testid="job-detail-stop"
          >
            Stop
          </Button>
        )}
      </div>

      {/* When it queued / started / finished, how long it ran, and its exit code. */}
      <JobTimingMeta job={job} />

      {job.error && (
        <div className="text-sm text-destructive" data-testid="job-detail-error">
          {job.error}
        </div>
      )}

      {/* The manifest-declared step ticker (what step it's on / what it found) — the
          progress a running multi-step job otherwise showed only as scrolling logs. */}
      <JobMilestoneSteps milestones={milestones} />

      {/* CPU + memory time-series. */}
      <div className="grid gap-4">
        <TimeSeriesChart data={cpu} label="CPU" unit="%" data-testid="job-cpu-chart" />
        <TimeSeriesChart data={mem} label="Memory" unit="MB" data-testid="job-mem-chart" />
      </div>

      {/* Streamed logs. */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-foreground">Logs</span>
          {streaming && (
            <span className="text-xs text-muted-foreground" data-testid="job-logs-live">
              live
            </span>
          )}
        </div>
        <div
          ref={logRef}
          data-testid="job-logs"
          className="font-mono text-xs bg-muted/40 rounded-md p-2 max-h-64 overflow-auto whitespace-pre-wrap"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">No output yet</span>
          ) : (
            logs.map(l => (
              <div key={l.id} className={l.stream === 'stderr' ? 'text-destructive' : ''}>
                {l.content}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
