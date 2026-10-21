// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobDetail as JobDetailWire } from '@/api-client/types'

// The time-series charts lazy-load Observable Plot; stub them so this render test
// stays about the detail's OWN content (timing + milestones + no-UUID), not the chart lib.
vi.mock('./TimeSeriesChart', () => ({ TimeSeriesChart: () => null }))

const JOB_ID = '00000000-0000-4000-8000-0000000000a3'
const detail: JobDetailWire = {
  job: {
    id: JOB_ID,
    name: 'Dimension reduction',
    job_type: 'analysis',
    status: 'completed',
    owner_id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-07-19T12:00:00Z',
    started_at: '2026-07-19T12:00:01Z',
    finished_at: '2026-07-19T12:02:05Z',
    exit_code: 0,
    params: null,
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
  },
  logs: [{ id: 'l1', job_id: JOB_ID, seq: 1, stream: 'stdout', content: 'done', created_at: '2026-07-19T12:00:02Z' }],
  metrics: [{ id: 'm1', job_id: JOB_ID, cpu_pct: 120, mem_bytes: 512_000_000, sampled_at: '2026-07-19T12:00:10Z' }],
  milestones: [
    { id: 'ms1', job_id: JOB_ID, milestone_id: 'read', status: 'done', detail: { count: 5000 }, created_at: '2026-07-19T12:00:02Z' },
    { id: 'ms2', job_id: JOB_ID, milestone_id: 'detect_clusters', status: 'done', detail: { count: 12 }, created_at: '2026-07-19T12:01:40Z' },
  ],
  can_stop: false,
}

vi.mock('@/modules/jobs/Jobs.store', () => ({
  Jobs: {
    detail,
    detailLoading: false,
    streaming: false,
    stop: vi.fn(),
    closeDetail: vi.fn(),
  },
}))

const { JobDetail } = await import('./JobDetail')

afterEach(cleanup)

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// TEST-6 [acceptance INV-1]: a populated completed job shows human labels + timing +
// milestones and NEVER a bare UUID.
describe('JobDetail drawer — populated (INV-1 no-UUID, timing, milestones)', () => {
  it('renders the human name, humanized timing, and the milestone steps', () => {
    const { getByTestId } = render(<JobDetail />)
    expect(getByTestId('job-detail').textContent).toContain('Dimension reduction')
    expect(getByTestId('job-timing-duration').textContent).toContain('2m 4s')
    expect(getByTestId('job-timing-exit').textContent).toBe('exit 0')
    expect(getByTestId('job-milestones')).toBeTruthy()
    expect(getByTestId('job-milestone-detect_clusters').textContent).toContain('detect clusters')
  })

  it('renders NO bare 36-char UUID anywhere in its visible text', () => {
    const { getByTestId } = render(<JobDetail />)
    expect(getByTestId('job-detail').textContent ?? '').not.toMatch(UUID_RE)
  })
})
