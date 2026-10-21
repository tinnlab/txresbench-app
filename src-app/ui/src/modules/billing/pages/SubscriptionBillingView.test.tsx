// @vitest-environment jsdom
// TEST-A6 [acceptance][invariant: INV-6], TEST-7 [ITEM-7], TEST-10 [ITEM-10] — the
// Subscription view shows the subscription status as a BADGE (not a raw enum),
// distinguishes an admin hold from a billing-derived suspension, surfaces a KNOWN
// plan override, and exposes the Set-plan / Clear-override / Suspend / Reactivate
// affordances. Actor ids render as names (resolveName), never UUIDs.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AdminBillingStateResponse,
  AdminAccountStatusResponse,
  AdminPlanOverrideResponse,
} from '@/api-client-saas/types'
import { SubscriptionBillingView } from './SubscriptionBillingView'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const activeBilling: AdminBillingStateResponse = {
  account_id: 'a1',
  plan_id: 'pro',
  subscription_status: 'active',
  suspended: false,
  premium: false,
  plan_manually_set: false,
  credit_balance_cents: 0,
}
const noHold: AdminAccountStatusResponse = { account_id: 'a1', admin_suspended: false }

const baseProps = {
  hasAccount: true,
  loading: false,
  error: null,
  billing: activeBilling,
  status: noHold,
  planOverride: null as AdminPlanOverrideResponse | null,
  canManageAccounts: true,
  resolveName: (id?: string | null) => (id ? `Name(${id})` : '—'),
  onRetry: vi.fn(),
  onOpenSetPlan: vi.fn(),
  onClearPlan: vi.fn(),
  onOpenSuspend: vi.fn(),
  onReactivate: vi.fn(),
}

describe('TEST-7 — Subscription view populated', () => {
  it('renders the subscription status as a human badge, not the raw enum', () => {
    render(<SubscriptionBillingView {...baseProps} billing={{ ...activeBilling, subscription_status: 'past_due' }} />)
    const badge = screen.getByTestId('billing-status-badge')
    expect(badge.textContent).toBe('Past Due')
    expect(badge.textContent).not.toBe('past_due')
  })

  it('shows the Set-plan and Clear-override affordances', () => {
    render(<SubscriptionBillingView {...baseProps} />)
    expect(screen.getByTestId('billing-open-setplan')).toBeTruthy()
    expect(screen.getByTestId('billing-clear-plan')).toBeTruthy()
  })

  it('renders the no-account prompt when no account is selected', () => {
    render(<SubscriptionBillingView {...baseProps} hasAccount={false} billing={null} />)
    expect(screen.getByTestId('billing-subscription-noaccount')).toBeTruthy()
  })

  it('renders a retryable error state on cold-load failure', () => {
    render(<SubscriptionBillingView {...baseProps} billing={null} error="boom" />)
    expect(screen.getByTestId('billing-subscription-error')).toBeTruthy()
  })
})

describe('TEST-A6 — admin-suspend distinct from billing suspension; known override', () => {
  it('shows an Admin-suspended badge (with reason + resolved name) distinct from billing suspension', () => {
    render(
      <SubscriptionBillingView
        {...baseProps}
        status={{
          account_id: 'a1',
          admin_suspended: true,
          admin_suspend_reason: 'Abuse investigation',
          admin_suspended_by: 'u-turing',
        }}
      />,
    )
    expect(screen.getByTestId('billing-adminsuspended-badge')).toBeTruthy()
    // billing.suspended is false → no billing-derived suspension badge
    expect(screen.queryByTestId('billing-suspended-badge')).toBeNull()
    const desc = screen.getByTestId('billing-subscription-descriptions')
    expect(desc.textContent).toContain('Abuse investigation')
    expect(desc.textContent).toContain('Name(u-turing)') // resolved, not the raw id
  })

  it('shows a billing-derived suspension badge independently of the admin hold', () => {
    render(
      <SubscriptionBillingView
        {...baseProps}
        billing={{ ...activeBilling, suspended: true, subscription_status: 'unpaid' }}
        status={noHold}
      />,
    )
    expect(screen.getByTestId('billing-suspended-badge')).toBeTruthy()
    expect(screen.queryByTestId('billing-adminsuspended-badge')).toBeNull()
  })

  // TEST-12 [acceptance][invariant: INV-4] — the plan-override DEFINITE state comes from the
  // billing READ (`plan_manually_set`), shown on cold load with NO planOverride mutation.
  it('renders the Admin override badge from billing.plan_manually_set on cold load (INV-4)', () => {
    const { rerender } = render(
      <SubscriptionBillingView
        {...baseProps}
        billing={{ ...activeBilling, plan_manually_set: false }}
        planOverride={null}
      />,
    )
    // Not overridden per the read → no override claim.
    expect(screen.queryByTestId('billing-override-badge')).toBeNull()
    // plan_manually_set:true from the READ (planOverride still null — no mutation this session).
    rerender(
      <SubscriptionBillingView
        {...baseProps}
        billing={{ ...activeBilling, plan_manually_set: true }}
        planOverride={null}
      />,
    )
    expect(screen.getByTestId('billing-override-badge')).toBeTruthy()
  })

  // TEST-14 [ITEM-19] — premium shows as a real on/off badge from billing.premium.
  it('renders the Premium badge from billing.premium (on/off)', () => {
    const { rerender } = render(
      <SubscriptionBillingView {...baseProps} billing={{ ...activeBilling, premium: false }} />,
    )
    expect(screen.queryByTestId('billing-premium-badge')).toBeNull()
    rerender(
      <SubscriptionBillingView {...baseProps} billing={{ ...activeBilling, premium: true }} />,
    )
    expect(screen.getByTestId('billing-premium-badge')).toBeTruthy()
  })
})

describe('TEST-10 — suspend / reactivate affordances gated on admin::accounts', () => {
  it('shows Suspend when not admin-suspended, and hides it without admin::accounts', () => {
    const { rerender } = render(<SubscriptionBillingView {...baseProps} />)
    expect(screen.getByTestId('billing-open-suspend')).toBeTruthy()
    rerender(<SubscriptionBillingView {...baseProps} canManageAccounts={false} />)
    expect(screen.queryByTestId('billing-open-suspend')).toBeNull()
    expect(screen.queryByTestId('billing-reactivate')).toBeNull()
  })

  it('shows Reactivate (not Suspend) when the account is admin-suspended', () => {
    render(
      <SubscriptionBillingView
        {...baseProps}
        status={{ account_id: 'a1', admin_suspended: true }}
      />,
    )
    expect(screen.getByTestId('billing-reactivate')).toBeTruthy()
    expect(screen.queryByTestId('billing-open-suspend')).toBeNull()
  })
})
