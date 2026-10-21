// JobsPane (ITEM-67) — the project's OPERATIONAL job monitor as a dock pane: ALL jobs
// in the project (queued / running / completed / failed / stopped) with live status,
// per-job logs + CPU/memory charts, and Stop. It is the project-scoped sibling of the
// global Jobs drawer (`modules/jobs`) — it REUSES that module's presentational pieces
// (`JobStatusBadge` + `TimeSeriesChart`) and mirrors its list/detail layout, but scopes
// every fetch to this project via `GET /api/jobs?project_id=X` (the `job_scope` JOIN,
// ITEM-68) through a per-pane `JobsPaneStore`. Distinct from the History pane (ITEM-26),
// which reviews COMPLETED runs for artifacts/lineage; this is the all-status run monitor.
// Gated by the existing `jobs::use` (granted to Users — no new permission).

import { useEffect, type ReactNode } from 'react'
import { Button, Empty, ErrorState, Pagination, ScrollArea, SectionHeader, Spinner, message } from '@ziee/kit'
import { ArrowLeft, Square } from 'lucide-react'
import type { JobDetail, JobListItem } from '@/api-client/types'
import { JobStatusBadge } from '@/modules/jobs/components/JobStatusBadge'
import { JobTimingMeta } from '@/modules/jobs/components/JobTimingMeta'
import { JobMilestoneSteps } from '@/modules/jobs/components/JobMilestoneSteps'
import { jobStopUnavailableReason } from '@/modules/jobs/stopAuthority'
import { TimeSeriesChart } from '@/modules/jobs/components/TimeSeriesChart'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { type WorkbenchPane, PaneScroll } from '../../core/shell/dock/paneModel'
import { JobsPaneStore } from './jobsPaneStore'
import { JobFlowGuidance } from './JobFlowGuidance'
import {
  cpuSeries,
  DEFAULT_JOBS_PER_PAGE,
  isActiveJob,
  jobsCountLabel,
  memSeries,
} from './jobsScope'

// ── Presentational view (backend-free; the gallery mounts this with seeded data) ──

export interface JobsPaneViewProps {
  paneId: string
  /** The page of LIST ROWS (`{ job, can_stop }`) — never bare jobs, because the Stop control
   *  renders the server's `can_stop` rather than re-deriving who may stop what. */
  jobs: JobListItem[]
  total: number
  page: number
  perPage: number
  loading: boolean
  error: string | null
  selectedId: string | null
  detail: JobDetail | null
  detailLoading: boolean
  streaming: boolean
  onSelect: (id: string) => void
  onStop: (id: string) => void
  onBack: () => void
  onPage: (page: number) => void
  onRetry: () => void
  /** ITEM-37 — status-keyed job-details content (rendered after the logs). */
  detailFooter?: ReactNode
}

function JobRow({
  paneId,
  row,
  onSelect,
  onStop,
}: {
  paneId: string
  row: JobListItem
  onSelect: (id: string) => void
  onStop: (id: string) => void
}) {
  const { job, can_stop } = row
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(job.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(job.id)
      }}
      data-testid={`workbench-jobs-row-${job.id}`}
      className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5 hover:bg-muted/50"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{job.name || job.job_type}</div>
        <div className="truncate text-xs text-muted-foreground">{job.job_type}</div>
      </div>
      <JobStatusBadge status={job.status} />
      {/* SIGHT AND STOP ARE DIFFERENT RIGHTS (see `modules/jobs/stopAuthority`). This used to
          be `jobStopVisible(active, canEdit)` — the pane's per-project EDIT role standing in
          for the stop rule, which is neither the same question nor the same answer: an editor
          who did not create the run and does not own its scope is refused by the server, and
          an owner who is not an editor was hidden a control they may in fact use. The server
          states `can_stop` per row; status decides whether the control exists, `can_stop`
          decides whether it fires, and a refusal is SHOWN with its reason rather than hidden. */}
      {isActiveJob(job.status) && (
        <Button
          variant="destructive"
          size="icon"
          tooltip={job.status === 'queued' ? 'Cancel' : 'Stop'}
          unavailableReason={jobStopUnavailableReason(can_stop)}
          onClick={e => {
            e.stopPropagation()
            onStop(job.id)
          }}
          data-testid={`workbench-jobs-stop-${job.id}`}
        >
          <Square className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}

/**
 * Does the terminal `error` still need its own line, or does the log pane already say it?
 *
 * A failed ANALYSIS's `error` is assembled server-side by folding the child's last stderr
 * lines into it (`jobs/scheduler.rs::with_stderr_tail`, joined with " | " and truncated to
 * 800 chars) — so for that job the standalone error block repeated, in a lossy form, text
 * the log pane below already renders in full and in order. That is the duplication.
 *
 * It is NOT safe to simply delete the block: `JobRepository::fail` is also reached on paths
 * that write no log line at all, because no child process ever produced one —
 *   • `arch-incompatible: …`                     (refused BEFORE any spawn)
 *   • `job runner did not start a process within Ns (staging ceiling)` (spawn timed out)
 *   • `dependency_failed`                        (cascade onto a job that never ran)
 *   • `reconcile finalize failed: …` / `interrupted by server restart (…)` (boot reconcile)
 * On those, `error` is the ONLY explanation the job has; `job_logs` is written exclusively
 * by the scheduler's stdout/stderr pump over a LIVE child.
 *
 * So: surface it exactly when the stream does not already carry it. The test is the exact
 * shape `with_stderr_tail` produces — it trims each line, joins with " | ", and truncates
 * from the FRONT, so a folded error ALWAYS ENDS WITH the job's last non-empty stderr line.
 * Anchoring on that (rather than a loose "contains") keeps a server-authored reason that
 * merely quotes the run — `reconcile finalize failed: …` — visible.
 */
function errorNeedsSurfacing(error: string | null | undefined, logs: JobDetail['logs']): boolean {
  if (!error) return false
  const folded = [...logs]
    .reverse()
    .find(l => l.stream === 'stderr' && l.content.trim().length > 0)
  return !(folded !== undefined && error.endsWith(folded.content.trim()))
}

function JobDetailView({
  detail,
  detailLoading,
  streaming,
  onBack,
  onStop,
  detailFooter,
}: {
  detail: JobDetail | null
  detailLoading: boolean
  streaming: boolean
  onBack: () => void
  onStop: (id: string) => void
  detailFooter?: ReactNode
}) {
  if (detailLoading && !detail) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <Spinner label="Loading job…" data-testid="workbench-jobs-detail-loading" />
      </div>
    )
  }
  if (!detail) return null
  // `can_stop` rides the DETAIL wire too, so a job opened by deep link renders its Stop from
  // the same stated answer the list row does.
  const { job, logs, metrics, milestones, can_stop } = detail

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="workbench-jobs-detail"
      // WHICH job this detail is showing. The header renders `job.name`, which is the ANALYSIS
      // title — identical across every run of one analysis, so it cannot answer "did this open
      // the run I clicked?". Additive rather than a changed testid, so existing specs are
      // untouched.
      data-job-id={job.id}
    >
      {/* Back-then-title: the escape hatch reads BEFORE the name it escapes from. */}
      <Button
        variant="ghost"
        icon={<ArrowLeft className="size-4" />}
        onClick={onBack}
        className="self-start"
        data-testid="workbench-jobs-detail-back"
      >
        All jobs
      </Button>
      <SectionHeader
        title={job.name || job.job_type}
        description={job.job_type}
        data-testid="workbench-jobs-detail-header"
        actions={
          <div className="flex items-center gap-2">
            <JobStatusBadge status={job.status} />
            {isActiveJob(job.status) && (
              <Button
                variant="destructive"
                unavailableReason={jobStopUnavailableReason(can_stop)}
                onClick={() => onStop(job.id)}
                data-testid="workbench-jobs-detail-stop"
              >
                Stop
              </Button>
            )}
          </div>
        }
      />

      {/* When it queued / started / finished, how long it ran, and its exit code. */}
      <JobTimingMeta job={job} />

      {errorNeedsSurfacing(job.error, logs) && (
        <div className="text-sm text-destructive" data-testid="workbench-jobs-detail-error">
          {job.error}
        </div>
      )}

      {/* The manifest-declared step ticker (what step it's on / what it found). */}
      <JobMilestoneSteps milestones={milestones} />

      <div className="grid gap-3">
        <TimeSeriesChart data={cpuSeries(metrics)} label="CPU" unit="%" data-testid="workbench-jobs-cpu-chart" />
        <TimeSeriesChart data={memSeries(metrics)} label="Memory" unit="MB" data-testid="workbench-jobs-mem-chart" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">Logs</span>
          {streaming && (
            <span className="text-xs text-muted-foreground" data-testid="workbench-jobs-logs-live">
              live
            </span>
          )}
        </div>
        <ScrollArea
          axis="y"
          data-testid="workbench-jobs-logs"
          className="max-h-64 min-h-0 flex-1 rounded-md bg-muted/40"
        >
          <div className="whitespace-pre-wrap p-2 font-mono text-xs">
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
        </ScrollArea>
      </div>

      {/* ITEM-37 — processor-contributed, status-keyed content (done → next steps; failed → retry). */}
      {detailFooter}
    </div>
  )
}

export function JobsPaneView(props: JobsPaneViewProps) {
  const { paneId, jobs, total, page, perPage, loading, error, selectedId } = props

  // Detail mode — a selected job's followable stream.
  if (selectedId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid={`workbench-jobs-pane-${paneId}`}>
        <PaneScroll axis="y" className="min-h-0 flex-1">
          <div className="flex flex-col">
            <JobDetailView
              detail={props.detail}
              detailLoading={props.detailLoading}
              streaming={props.streaming}
              onBack={props.onBack}
              onStop={props.onStop}
              detailFooter={props.detailFooter}
            />
          </div>
        </PaneScroll>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid={`workbench-jobs-pane-${paneId}`}>
      <div className="px-1 text-xs text-muted-foreground" data-testid={`workbench-jobs-count-${paneId}`}>
        {jobsCountLabel(page, perPage, total)}
      </div>

      {error ? (
        <ErrorState
          resource="jobs"
          description="The project's jobs could not be loaded."
          details={error}
          onRetry={props.onRetry}
          data-testid={`workbench-jobs-error-${paneId}`}
        />
      ) : loading && jobs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner label="Loading jobs…" data-testid={`workbench-jobs-loading-${paneId}`} />
        </div>
      ) : jobs.length === 0 ? (
        <Empty
          data-testid={`workbench-jobs-pane-empty-${paneId}`}
          title="No jobs yet"
          description="Analysis jobs for this project will appear here as they queue and run."
        />
      ) : (
        <PaneScroll axis="y" className="min-h-0 flex-1" data-testid={`workbench-jobs-list-${paneId}`}>
          <div className="flex flex-col gap-1">
            {jobs.map(row => (
              <JobRow
                key={row.job.id}
                paneId={paneId}
                row={row}
                onSelect={props.onSelect}
                onStop={props.onStop}
              />
            ))}
          </div>
        </PaneScroll>
      )}

      {!error && total > perPage && (
        <Pagination
          total={total}
          pageSize={perPage}
          current={page}
          onChange={props.onPage}
          aria-label="Project jobs pages"
          previousLabel="Previous page"
          nextLabel="Next page"
          pageLabel={p => `Page ${p}`}
          data-testid={`workbench-jobs-pagination-${paneId}`}
        />
      )}
    </div>
  )
}

// ── Data wrapper (the registered pane) ────────────────────────────────────────────

export function JobsPane({ pane }: { pane: WorkbenchPane }) {
  const { projectId } = useWorkbench()
  const store = JobsPaneStore.use({ projectId, perPage: DEFAULT_JOBS_PER_PAGE })
  const { jobs, total, page, perPage, loading, error, selectedId, detail, detailLoading, streaming } = store

  // ITEM-36 deep-link: when the pane is opened with a job_id `ref` (the completion-toast click),
  // auto-open THAT job's details. Runs when the ref changes (a second toast re-selects).
  const deepLinkRef = pane.ref
  useEffect(() => {
    if (deepLinkRef && deepLinkRef !== store.$.selectedId) void store.select(deepLinkRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkRef])

  const onStop = (id: string) => {
    const status = store.$.jobs.find(r => r.job.id === id)?.job.status ?? 'running'
    void store.stop(id).catch((e: unknown) => {
      message.error(e instanceof Error ? e.message : `Failed to ${status === 'queued' ? 'cancel' : 'stop'} job`)
    })
  }

  return (
    <JobsPaneView
      paneId={pane.id}
      jobs={jobs}
      total={total}
      page={page}
      perPage={perPage}
      loading={loading}
      error={error}
      selectedId={selectedId}
      detail={detail}
      detailLoading={detailLoading}
      streaming={streaming}
      onSelect={id => void store.select(id)}
      onStop={onStop}
      onBack={() => store.closeDetail()}
      onPage={p => store.setPage(p)}
      onRetry={() => void store.load()}
      detailFooter={<JobFlowGuidance job={detail?.job} />}
    />
  )
}
