// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JobStatusBadge } from './JobStatusBadge'

afterEach(cleanup)

// TEST-3 [acceptance INV-2]: status is a HUMAN label, not the raw enum.
describe('JobStatusBadge (INV-2 — badge, not raw enum)', () => {
  it('renders the humanized label for each lifecycle state, not the wire enum', () => {
    for (const [status, label] of [
      ['queued', 'Queued'],
      ['running', 'Running'],
      ['completed', 'Completed'],
      ['failed', 'Failed'],
      ['stopped', 'Stopped'],
    ] as const) {
      const { getByTestId } = render(<JobStatusBadge status={status} />)
      const badge = getByTestId(`job-status-${status}`)
      // The VISIBLE label is title-cased — flipping back to the raw enum fails this.
      expect(badge.textContent).toBe(label)
      expect(badge.textContent).not.toBe(status)
      cleanup()
    }
  })

  it('keeps the raw-enum testid (so existing e2e selectors are unbroken)', () => {
    const { getByTestId } = render(<JobStatusBadge status="completed" />)
    expect(getByTestId('job-status-completed')).toBeTruthy()
  })

  it('an unknown status falls back to its raw string rather than crashing/blank', () => {
    const { getByTestId } = render(<JobStatusBadge status="reconciling" />)
    expect(getByTestId('job-status-reconciling').textContent).toBe('reconciling')
  })
})
