import { useState } from 'react'
import { Button, Empty, Input, Spin, message } from '@ziee/kit'
import { Jobs } from '@/modules/jobs/Jobs.store'
import { ListPagination } from '@/components/common/ListPagination'
import { JobStatusBadge } from './JobStatusBadge'
import { jobStopUnavailableReason } from '../stopAuthority'

/** Active (still-controllable) states: queued → cancel, running → stop. */
function isActive(status: string) {
  return status === 'queued' || status === 'running'
}

/**
 * The Jobs drawer LIST view: a create affordance + the owner's jobs with status
 * badges, a Stop/Cancel action on active jobs (NEVER a start action — the queue
 * runs automatically), and click-through to a job's detail.
 */
export function JobList() {
  const { jobs, total, page, perPage, loading, creating } = Jobs
  const [name, setName] = useState('')

  const createJob = async () => {
    try {
      await Jobs.create('stub', name.trim() || 'Analysis job')
      setName('')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create job')
    }
  }

  const stopJob = async (id: string, status: string) => {
    try {
      await Jobs.stop(id)
    } catch (e) {
      message.error(
        e instanceof Error ? e.message : `Failed to ${status === 'queued' ? 'cancel' : 'stop'} job`,
      )
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Create affordance (stub enqueue — real analysis jobs come from analysis
          modules). A job name + a one-click enqueue. */}
      <div className="flex items-center gap-2" data-testid="job-create-row">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Job name"
          aria-label="New job name"
          data-testid="job-create-name"
          onKeyDown={e => {
            if (e.key === 'Enter') void createJob()
          }}
          className="flex-1"
        />
        <Button
          onClick={createJob}
          loading={creating}
          data-testid="job-create-button"
        >
          New job
        </Button>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading jobs" />
        </div>
      ) : jobs.length === 0 ? (
        <Empty
          description="No jobs yet — create one to watch it queue and run."
          data-testid="job-list-empty"
        />
      ) : (
        <ul className="flex flex-col gap-1" data-testid="job-list">
          {jobs.map(({ job, can_stop }) => (
            <li key={job.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => void Jobs.select(job.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') void Jobs.select(job.id)
                }}
                data-testid={`job-row-${job.id}`}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-muted/50 cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {job.name || job.job_type}
                  </div>
                  <div className="text-xs text-muted-foreground">{job.job_type}</div>
                </div>
                <JobStatusBadge status={job.status} />
                {/* Two SEPARATE questions, deliberately not folded together. Whether the
                    control EXISTS is the job's status (only a queued/running job has anything
                    to stop). Whether it FIRES is the server's `can_stop` — the creator / scope
                    owner / admin rule, stated on the wire and never re-derived here. A caller
                    who may not stop still SEES the control, refusing with its reason: an
                    editor who can watch a run but not end it needs to learn that from the UI,
                    not from a 403. */}
                {isActive(job.status) && (
                  <Button
                    variant="destructive"
                    size="icon"
                    tooltip={job.status === 'queued' ? 'Cancel' : 'Stop'}
                    unavailableReason={jobStopUnavailableReason(can_stop)}
                    onClick={e => {
                      e.stopPropagation()
                      void stopJob(job.id, job.status)
                    }}
                    data-testid={`job-stop-${job.id}`}
                  >
                    ✕
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > perPage && (
        <ListPagination
          current={page}
          total={total}
          pageSize={perPage}
          onChange={p => void Jobs.load(p)}
          onPageSizeChange={size => Jobs.setPerPage(size)}
          itemNoun="job"
          data-testid="job-list-pagination"
        />
      )}
    </div>
  )
}
