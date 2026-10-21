import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { Job, JobDetail as JobDetailWire, JobListItem, JobMilestone } from '@/api-client/types'
import { useJobsStore } from '@/modules/jobs/Jobs.store'
import { JobList } from '@/modules/jobs/components/JobList'
import { JobDetail } from '@/modules/jobs/components/JobDetail'

/**
 * Populated gallery for the global Jobs DRAWER surfaces (`JobList` + `JobDetail`).
 * Before this pass these surfaces had NO gallery coverage — so the human-usability
 * review (durations/timestamps/exit-code, the milestone step ticker, the humanized
 * status badge) had never been through a populated render at desktop + 390px. Each
 * story seeds the real `Jobs` store offline (no backend); the shared viewport matrix
 * renders every story at 390px too.
 */

const OWNER = '00000000-0000-4000-8000-000000000001'

type JobsState = ReturnType<typeof useJobsStore.getState>

function job(
  id: string,
  name: string,
  status: string,
  timing: { started_at?: string; finished_at?: string; exit_code?: number; error?: string } = {},
): Job {
  return {
    id,
    name,
    job_type: 'analysis',
    status,
    owner_id: OWNER,
    created_at: '2026-07-19T12:00:00Z',
    params: null,
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
    ...timing,
  }
}

function row(j: Job, canStop = true): JobListItem {
  return { job: j, can_stop: canStop }
}

// A realistic run across every lifecycle state — human analysis names, never ids.
const LIST_ROWS: JobListItem[] = [
  row(job('00000000-0000-4000-8000-0000000000a1', 'Graph clustering', 'running', {
    started_at: new Date(Date.now() - 42_000).toISOString(),
  })),
  row(job('00000000-0000-4000-8000-0000000000a2', 'Quality filter', 'queued')),
  row(job('00000000-0000-4000-8000-0000000000a3', 'Dimension reduction', 'completed', {
    started_at: '2026-07-19T12:00:01Z',
    finished_at: '2026-07-19T12:02:05Z',
    exit_code: 0,
  })),
  row(job('00000000-0000-4000-8000-0000000000a4', 'Differential expression', 'failed', {
    started_at: '2026-07-19T12:00:01Z',
    finished_at: '2026-07-19T12:00:48Z',
    exit_code: 1,
    error: 'ValueError: group "treated" has 0 rows',
  }), false),
  row(job('00000000-0000-4000-8000-0000000000a5', 'Normalize', 'stopped', {
    started_at: '2026-07-19T12:00:01Z',
    finished_at: '2026-07-19T12:01:12Z',
  })),
]

function milestones(jobId: string, last: JobMilestone['status']): JobMilestone[] {
  return [
    { id: `${jobId}-m1`, job_id: jobId, milestone_id: 'read', status: 'done', detail: { count: 5000 }, created_at: '2026-07-19T12:00:02Z' },
    { id: `${jobId}-m2`, job_id: jobId, milestone_id: 'build_graph', status: 'done', detail: { note: 'k=15' }, created_at: '2026-07-19T12:00:20Z' },
    // A deliberately LONG finding (many group names) so the 390px gallery story
    // exercises the milestone row's wrap behavior (INV-5) on representative data.
    { id: `${jobId}-m3`, job_id: jobId, milestone_id: 'detect_clusters', status: last, detail: last === 'done' ? { count: 12, names: ['Group A', 'Group B', 'Group C', 'Group D', 'Group E', 'Group F', 'Group G', 'Group H', 'Group I', 'Group J', 'Group K', 'Group L'] } : {}, created_at: '2026-07-19T12:01:40Z' },
  ]
}

function detailFor(j: Job, last: JobMilestone['status']): JobDetailWire {
  return {
    job: j,
    logs: [
      { id: 'l1', job_id: j.id, seq: 1, stream: 'stdout', content: 'Reading matrix (5000 × 2)…', created_at: '2026-07-19T12:00:02Z' },
      { id: 'l2', job_id: j.id, seq: 2, stream: 'stdout', content: 'Building kNN graph (k=15)…', created_at: '2026-07-19T12:00:20Z' },
      { id: 'l3', job_id: j.id, seq: 3, stream: 'stderr', content: j.error ?? 'warning: resolution is high', created_at: '2026-07-19T12:01:40Z' },
    ],
    metrics: [
      { id: 'me1', job_id: j.id, cpu_pct: 120, mem_bytes: 512_000_000, sampled_at: '2026-07-19T12:00:10Z' },
      { id: 'me2', job_id: j.id, cpu_pct: 185, mem_bytes: 734_000_000, sampled_at: '2026-07-19T12:01:00Z' },
    ],
    milestones: milestones(j.id, last),
    can_stop: j.status === 'running' || j.status === 'queued',
  }
}

const DEFAULTS: Partial<JobsState> = {
  jobs: [],
  total: 0,
  page: 1,
  perPage: 10,
  loading: false,
  creating: false,
  error: null,
  selectedId: null,
  detail: null,
  detailLoading: false,
  streaming: false,
}

function seed(partial: Partial<JobsState>) {
  return () => {
    useJobsStore.setState({ ...DEFAULTS, ...partial } as JobsState)
  }
}

const JobListStory = lazy(async () => ({ default: () => <JobList /> }))
const JobDetailStory = lazy(async () => ({ default: () => <JobDetail /> }))

const completed = LIST_ROWS[2].job
const failed = LIST_ROWS[3].job
const running = { ...LIST_ROWS[0].job, started_at: new Date(Date.now() - 42_000).toISOString() }

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'jobs-drawer-list',
      title: 'Jobs drawer — list (populated)',
      note: 'The owner\'s jobs across every lifecycle state with humanized status badges, Stop on active rows, and the create row. Populated render at desktop + 390px.',
      path: '/dev/jobs-drawer-list',
      initialPath: '/dev/jobs-drawer-list',
      component: JobListStory,
      setup: seed({ jobs: LIST_ROWS, total: LIST_ROWS.length }),
    },
    {
      slug: 'jobs-drawer-detail-completed',
      title: 'Jobs drawer — detail (completed)',
      note: 'A finished run: humanized status, timing meta (finished + "Ran 2m 04s" + exit 0), the done milestone step ticker, CPU/memory charts, and logs.',
      path: '/dev/jobs-drawer-detail-completed',
      initialPath: '/dev/jobs-drawer-detail-completed',
      component: JobDetailStory,
      setup: seed({ selectedId: completed.id, detail: detailFor(completed, 'done') }),
    },
    {
      slug: 'jobs-drawer-detail-failed',
      title: 'Jobs drawer — detail (failed)',
      note: 'A failed run: error line, a FAILED milestone step, timing meta with exit 1.',
      path: '/dev/jobs-drawer-detail-failed',
      initialPath: '/dev/jobs-drawer-detail-failed',
      component: JobDetailStory,
      setup: seed({ selectedId: failed.id, detail: detailFor(failed, 'failed') }),
    },
    {
      slug: 'jobs-drawer-detail-running',
      title: 'Jobs drawer — detail (running)',
      note: 'A live run: "Running <n>s" duration, an in-progress milestone step, streaming logs, Stop.',
      path: '/dev/jobs-drawer-detail-running',
      initialPath: '/dev/jobs-drawer-detail-running',
      component: JobDetailStory,
      setup: seed({ selectedId: running.id, detail: detailFor(running, 'started'), streaming: true }),
    },
  ],
}
