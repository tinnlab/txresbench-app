// TEST-315 (ITEM-67) — the project Jobs pane's scope + paging logic. The pure helpers
// behind the pane: the list query ALWAYS carries `project_id` (the `?project_id=X`
// job_scope contract — the operational monitor never shows the global owner list), the
// active/terminal status predicates, the "N of M" label, and the metric-series mapping
// reused by the jobs `TimeSeriesChart`. Node-env pure test (mirrors runHistory.test.ts).

import { describe, expect, it } from 'vitest'
import type { JobMetric } from '@/api-client/types'
import {
  buildJobsListQuery,
  cpuSeries,
  DEFAULT_JOBS_PER_PAGE,
  isActiveJob,
  isTerminalJob,
  JOBS_LIST_MAX_PER_PAGE,
  jobsCountLabel,
  jobsPageBounds,
  memSeries,
} from './jobsScope'

describe('buildJobsListQuery — the ?project_id= scope contract', () => {
  it('always carries the project_id so the list JOINs job_scope', () => {
    const q = buildJobsListQuery('proj-123', 2, 10)
    expect(q).toEqual({ project_id: 'proj-123', page: 2, per_page: 10 })
    expect(q.project_id).toBe('proj-123')
  })

  it('clamps a non-positive / non-finite page to 1', () => {
    expect(buildJobsListQuery('p', 0, 10).page).toBe(1)
    expect(buildJobsListQuery('p', -3, 10).page).toBe(1)
    expect(buildJobsListQuery('p', Number.NaN, 10).page).toBe(1)
    expect(buildJobsListQuery('p', 2.9, 10).page).toBe(2)
  })

  it('clamps per_page to the max and falls back to the default when invalid', () => {
    expect(buildJobsListQuery('p', 1, 9999).per_page).toBe(JOBS_LIST_MAX_PER_PAGE)
    expect(buildJobsListQuery('p', 1, 0).per_page).toBe(DEFAULT_JOBS_PER_PAGE)
    expect(buildJobsListQuery('p', 1, Number.NaN).per_page).toBe(DEFAULT_JOBS_PER_PAGE)
  })
})

describe('job status predicates', () => {
  it('treats queued + running as active (stoppable)', () => {
    expect(isActiveJob('queued')).toBe(true)
    expect(isActiveJob('running')).toBe(true)
    expect(isActiveJob('completed')).toBe(false)
    expect(isActiveJob('failed')).toBe(false)
    expect(isActiveJob('stopped')).toBe(false)
  })

  it('treats completed/failed/stopped as terminal', () => {
    expect(isTerminalJob('completed')).toBe(true)
    expect(isTerminalJob('failed')).toBe(true)
    expect(isTerminalJob('stopped')).toBe(true)
    expect(isTerminalJob('running')).toBe(false)
    expect(isTerminalJob('queued')).toBe(false)
  })
})

describe('jobs paging labels', () => {
  it('computes page bounds and the N-of-M label', () => {
    expect(jobsPageBounds(1, 10, 0)).toEqual({ from: 0, to: 0, totalPages: 1 })
    expect(jobsPageBounds(2, 10, 25)).toEqual({ from: 11, to: 20, totalPages: 3 })
    expect(jobsCountLabel(1, 10, 0)).toBe('Showing 0–0 of 0 jobs')
    expect(jobsCountLabel(1, 10, 1)).toBe('Showing 1–1 of 1 job')
    expect(jobsCountLabel(2, 10, 25)).toBe('Showing 11–20 of 25 jobs')
  })
})

describe('metric series mapping', () => {
  const metrics: JobMetric[] = [
    { id: 'm1', job_id: 'j', sampled_at: '2026-07-19T00:00:00Z', cpu_pct: 50, mem_bytes: 1_048_576 } as JobMetric,
    { id: 'm2', job_id: 'j', sampled_at: '2026-07-19T00:00:03Z', cpu_pct: 120, mem_bytes: 2_097_152 } as JobMetric,
  ]

  it('maps cpu_pct and mem_bytes(→MB) into TimeSeriesChart points', () => {
    expect(cpuSeries(metrics)).toEqual([
      { t: '2026-07-19T00:00:00Z', v: 50 },
      { t: '2026-07-19T00:00:03Z', v: 120 },
    ])
    expect(memSeries(metrics)).toEqual([
      { t: '2026-07-19T00:00:00Z', v: 1 },
      { t: '2026-07-19T00:00:03Z', v: 2 },
    ])
  })
})
