// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobMilestone } from '@/api-client/types'
import { JobMilestoneSteps, milestoneDetailText } from './JobMilestoneSteps'

afterEach(cleanup)

function ms(milestone_id: string, status: string, detail: unknown): JobMilestone {
  return { id: `${milestone_id}-x`, job_id: 'j', milestone_id, status, detail, created_at: '2026-07-19T12:00:00Z' }
}

// TEST-4 [acceptance INV-4]: the step ticker renders the declared steps + findings,
// not a silent spinner.
describe('JobMilestoneSteps (INV-4 — user-visible progress)', () => {
  it('renders one humanized step per milestone with its harvested finding', () => {
    const { getByTestId } = render(
      <JobMilestoneSteps
        milestones={[
          ms('read', 'done', { count: 5000 }),
          ms('detect_counts', 'done', { count: 3, names: ['alpha', 'beta', 'gamma'] }),
          ms('write_output', 'started', {}),
        ]}
      />,
    )
    // Humanized step name (underscores → spaces).
    expect(getByTestId('job-milestone-detect_counts').textContent).toContain('detect counts')
    // Harvested finding one-liner.
    expect(getByTestId('job-milestone-detect_counts').textContent).toContain('3 (alpha, beta, gamma)')
    // Per-step accessible status word.
    expect(getByTestId('job-milestone-write_output').textContent).toContain('in progress')
    expect(getByTestId('job-milestones')).toBeTruthy()
  })

  it('renders nothing (no crash) for an empty milestone list', () => {
    const { container } = render(<JobMilestoneSteps milestones={[]} />)
    expect(container.textContent).toBe('')
  })

  // TEST-7 (ITEM-6): the datasets pipeline uses this same component with its own
  // testid prefix — proving that refactor is behavior-preserving at the boundary.
  it('honors the datasets pipeline testid prefix (pipeline-milestone-<id>)', () => {
    const { getByTestId } = render(
      <JobMilestoneSteps
        testidPrefix="pipeline-milestone"
        milestones={[ms('read', 'done', { note: 'hi' })]}
      />,
    )
    expect(getByTestId('pipeline-milestones')).toBeTruthy()
    expect(getByTestId('pipeline-milestone-read').textContent).toContain('read')
    expect(getByTestId('pipeline-milestone-read').textContent).toContain('hi')
  })
})

describe('milestoneDetailText', () => {
  it('formats count+names, a bare note, and anything else', () => {
    expect(milestoneDetailText({ count: 3, names: ['a', 'b'] })).toBe('3 (a, b)')
    expect(milestoneDetailText({ note: 'reading' })).toBe('reading')
    expect(milestoneDetailText(null)).toBe('')
    expect(milestoneDetailText({ nothing: true })).toBe('')
  })
})
