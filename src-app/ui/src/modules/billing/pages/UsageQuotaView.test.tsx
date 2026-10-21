// @vitest-environment jsdom
// TEST-11 [ITEM-11] — the Usage & Quota view renders quota allowances vs used, the
// spend cap as dollars, the quota-state badges, and the metered usage rollup table
// with numbered pagination. Read-only (no mutation controls).

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { QuotaStateResponse, UsageRollupRow } from '@/api-client-saas/types'
import { UsageQuotaView } from './UsageQuotaView'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const quota: QuotaStateResponse = {
  plan_id: 'pro',
  compute_allowance: 1000,
  compute_used: 820,
  storage_allowance: 500,
  storage_used: 130,
  // #141 — the SEAT allowance + the live member count. Required on the DTO so the fixture
  // carries them; this view does not render seats yet (#149 owns that surface).
  member_allowance: 50,
  members_used: 7,
  hard_cap: false,
  overage: true,
  spend_cap_cents: 50000,
  alert_level_compute: 80,
  alert_level_storage: 50,
  suspended: false,
}

const rows: UsageRollupRow[] = [
  {
    id: 'u1',
    account_id: 'a1',
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-08-31T23:59:59Z',
    compute_core_hours: 812.5,
    storage_gb_months: 128.4,
    gpu_hours: 14,
    egress_gb: 42.1,
    reported_at: '2026-09-01T02:00:00Z',
    updated_at: '2026-09-01T02:00:00Z',
  },
]

const baseProps = {
  hasAccount: true,
  loading: false,
  error: null,
  quota,
  rows,
  total: 1,
  currentPage: 1,
  pageSize: 20,
  onRetry: vi.fn(),
  onPageChange: vi.fn(),
}

describe('TEST-11 — Usage & Quota view', () => {
  it('renders the spend cap as dollars', () => {
    render(<UsageQuotaView {...baseProps} />)
    const desc = screen.getByTestId('billing-quota-descriptions')
    expect(desc.textContent).toContain('$500.00')
    expect(desc.textContent).not.toContain('50000')
  })

  it('renders the metered overage badge and the plan badge', () => {
    render(<UsageQuotaView {...baseProps} />)
    expect(screen.getByTestId('billing-quota-overage')).toBeTruthy()
    expect(screen.getByTestId('billing-quota-plan').textContent).toBe('pro')
  })

  it('renders the usage rollup table with pagination', () => {
    render(<UsageQuotaView {...baseProps} />)
    expect(screen.getByTestId('billing-usage-table')).toBeTruthy()
    expect(screen.getByTestId('billing-usage-pagination')).toBeTruthy()
  })

  it('renders the compute/storage allowance-vs-used meters', () => {
    render(<UsageQuotaView {...baseProps} />)
    const compute = screen.getByTestId('billing-quota-compute')
    expect(compute.textContent).toContain('820')
    expect(compute.textContent).toContain('1,000')
  })

  it('shows "No cap" when there is no spend cap', () => {
    render(<UsageQuotaView {...baseProps} quota={{ ...quota, spend_cap_cents: undefined }} />)
    expect(screen.getByTestId('billing-quota-descriptions').textContent).toContain('No cap')
  })

  it('shows the no-account prompt when no account is selected', () => {
    render(<UsageQuotaView {...baseProps} hasAccount={false} quota={null} rows={[]} total={0} />)
    expect(screen.getByTestId('billing-usage-noaccount')).toBeTruthy()
  })

  it('renders a retryable error on cold-load failure', () => {
    render(<UsageQuotaView {...baseProps} quota={null} rows={[]} total={0} error="boom" />)
    expect(screen.getByTestId('billing-quota-error')).toBeTruthy()
  })
})
