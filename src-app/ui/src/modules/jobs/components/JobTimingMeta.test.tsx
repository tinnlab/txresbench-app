// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JobTimingMeta } from './JobTimingMeta'
import type { TimedJobLike } from '../jobTiming'

afterEach(cleanup)

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// TEST-5 (ITEM-2): the timing meta shows the applicable facts, humanized, no ids/epochs.
describe('JobTimingMeta', () => {
  it('completed: primary=Finished + duration + exit code', () => {
    const job: TimedJobLike = {
      status: 'completed',
      created_at: '2026-07-19T12:00:00Z',
      started_at: '2026-07-19T12:00:01Z',
      finished_at: '2026-07-19T12:02:05Z',
      exit_code: 0,
    }
    const { getByTestId } = render(<JobTimingMeta job={job} />)
    expect(getByTestId('job-timing-primary').textContent).toContain('Finished')
    expect(getByTestId('job-timing-duration').textContent).toContain('Ran')
    expect(getByTestId('job-timing-duration').textContent).toContain('2m 4s')
    expect(getByTestId('job-timing-exit').textContent).toBe('exit 0')
  })

  it('queued: only a queued timestamp — no duration, no exit', () => {
    const job: TimedJobLike = { status: 'queued', created_at: '2026-07-19T12:00:00Z' }
    const { getByTestId, queryByTestId } = render(<JobTimingMeta job={job} />)
    expect(getByTestId('job-timing-primary').textContent).toContain('Queued')
    expect(queryByTestId('job-timing-duration')).toBeNull()
    expect(queryByTestId('job-timing-exit')).toBeNull()
  })

  // TEST-2 (ITEM-3, jobs-detail-contrast): the secondary `· relative` fragment must
  // use the muted-foreground token at FULL strength — never the `/70` alpha that composited
  // below WCAG-AA (2.97:1 light / 4.24:1 dark). A cheap regression tripwire for the contrast
  // fix; the real WCAG proof is the axe spec tests/visual/jobs-detail-contrast.spec.ts.
  it('relative-timestamp uses full muted-foreground token (no sub-AA /70 alpha)', () => {
    const job: TimedJobLike = {
      status: 'completed',
      created_at: '2026-07-19T12:00:00Z',
      started_at: '2026-07-19T12:00:01Z',
      finished_at: '2026-07-19T12:02:05Z',
      exit_code: 0,
    }
    const { getByTestId } = render(<JobTimingMeta job={job} />)
    const primary = getByTestId('job-timing-primary')
    // The relative fragment (`· <n> ago`) is the trailing muted span.
    const relative = primary.querySelector('span.text-muted-foreground')
    expect(relative).not.toBeNull()
    expect(relative?.textContent).toContain('·')
    // No `/NN` alpha modifier may sit on any muted-foreground span in this row.
    expect(primary.querySelector('[class*="text-muted-foreground/"]')).toBeNull()
  })

  it('never renders a raw ISO string, epoch, or UUID', () => {
    const job: TimedJobLike = {
      status: 'completed',
      created_at: '2026-07-19T12:00:00Z',
      started_at: '2026-07-19T12:00:01Z',
      finished_at: '2026-07-19T12:02:05Z',
      exit_code: 0,
    }
    const { getByTestId } = render(<JobTimingMeta job={job} />)
    const text = getByTestId('job-timing-meta').textContent ?? ''
    expect(text).not.toContain('2026-07-19T12:02:05Z')
    expect(text).not.toMatch(UUID_RE)
  })
})
