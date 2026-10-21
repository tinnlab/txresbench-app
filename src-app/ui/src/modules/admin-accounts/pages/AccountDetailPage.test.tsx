// @vitest-environment jsdom
// TEST-4 [covers ITEM-2, ITEM-3] — the account-detail page: Overview renders the
// account identity (name / kind / owner-by-name / created / suspend badge), a
// top-level Loading while the account resolves, and a retryable ErrorState on
// failure.
// TEST-5 [covers ITEM-6, ITEM-7, ITEM-8, ITEM-13] — the three billing widgets render
// only when `useHasPermission('billing::admin')` is true; when false, Overview +
// Members still render and the billing widgets are ABSENT (the component-tier
// complement to the INV-2 restricted-user e2e, TEST-13).

import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@/api-client/types'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

// ---- controllable state -------------------------------------------------------
const hasBilling = vi.hoisted(() => ({ value: true }))
const detail = vi.hoisted(
  () =>
    ({ account: null, loading: false, error: null, isInitialized: true, accountId: 'a1', load: vi.fn() }) as {
      account: Account | null
      loading: boolean
      error: string | null
      isInitialized: boolean
      accountId: string | null
      load: ReturnType<typeof vi.fn>
    },
)
const members = vi.hoisted(() => ({ value: [] as unknown[] }))
const subStatus = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'a1' }),
  useLocation: () => ({ state: null }),
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/core/permissions', () => ({
  useHasPermission: () => hasBilling.value,
  usePermission: () => true,
  Permissions: { AdminAccounts: 'admin::accounts' },
}))
vi.mock('@ziee/shell', () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Loading: ({ label }: { label?: string }) => <div data-testid="page-loading">{label}</div>,
}))
vi.mock('@/core/actions/defineAction', () => ({ runAction: vi.fn() }))

// Stub the composed children — this test verifies COMPOSITION + gating, not the
// widgets' internals (those have their own tests + the e2e).
vi.mock('@/modules/admin-accounts/components/MembersSection', () => ({
  MembersSection: () => <div data-testid="members-widget" />,
}))
vi.mock('@/modules/billing/pages/SubscriptionBillingView', () => ({
  SubscriptionBillingView: () => <div data-testid="subscription-widget" />,
}))
vi.mock('@/modules/billing/pages/UsageQuotaView', () => ({
  UsageQuotaView: () => <div data-testid="usage-widget" />,
}))
vi.mock('@/modules/billing/pages/CreditsGrantsView', () => ({
  CreditsGrantsView: () => <div data-testid="credits-widget" />,
}))
vi.mock('@/modules/billing/components/SetPlanDrawer', () => ({ SetPlanDrawer: () => null }))
vi.mock('@/modules/billing/components/SetPlanDrawer.store', () => ({ SetPlanDrawer: { open: vi.fn() } }))
vi.mock('@/modules/billing/components/SuspendDrawer', () => ({ SuspendDrawer: () => null }))
vi.mock('@/modules/billing/components/SuspendDrawer.store', () => ({ SuspendDrawer: { open: vi.fn() } }))
vi.mock('@/modules/billing/components/GrantCreditDrawer', () => ({ GrantCreditDrawer: () => null }))
vi.mock('@/modules/billing/components/GrantCreditDrawer.store', () => ({ GrantCreditDrawer: { open: vi.fn() } }))
vi.mock('@/modules/billing/lib/userDirectory', () => ({
  BillingUserDirectory: { names: {}, resolveMany: vi.fn() },
  nameFor: () => '',
}))
const emptyStore = { load: vi.fn(), clearError: vi.fn() }
vi.mock('@/modules/billing/stores/BillingSubscription.store', () => ({
  get BillingSubscription() {
    return { ...emptyStore, billing: null, planOverride: null, get status() { return subStatus.value }, accountId: null }
  },
}))
vi.mock('@/modules/billing/stores/UsageQuota.store', () => ({
  UsageQuota: { ...emptyStore, rows: [], total: 0, quota: null, accountId: null },
}))
vi.mock('@/modules/billing/stores/CreditsGrants.store', () => ({
  CreditsGrants: { ...emptyStore, credits: null, premium: false, premiumKnown: false, accountId: null },
}))
vi.mock('@/modules/admin-accounts/stores/AccountMembers.store', () => ({
  get AccountMembers() {
    return { get members() { return members.value } }
  },
}))
vi.mock('@/modules/admin-accounts/stores/AccountDetail.store', () => ({
  get AccountDetail() {
    return detail
  },
}))

const { AccountDetailPage } = await import('./AccountDetailPage')

const ACME: Account = {
  id: 'a1',
  name: 'Acme Bio',
  kind: 'organization',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '',
}

afterEach(cleanup)
beforeEach(() => {
  hasBilling.value = true
  detail.account = ACME
  detail.loading = false
  detail.error = null
  detail.isInitialized = true
  detail.accountId = 'a1'
  members.value = []
  subStatus.value = null
})

describe('TEST-4 — Overview + page states', () => {
  it('renders the Overview identity (name, kind badge, owner by name, created)', () => {
    members.value = [
      { user_id: 'u1', role: 'owner', display_name: 'Ada Lovelace', username: 'ada' },
    ]
    const { getByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-overview-card')).toBeTruthy()
    expect(getByTestId('account-detail-kind-badge').textContent).toBe('Organization')
    // Owner is the human name of the owner-role member, never a UUID.
    expect(getByTestId('account-detail-owner').textContent).toBe('Ada Lovelace')
    expect(getByTestId('account-detail-owner').textContent).not.toMatch(/^[0-9a-f]{8}-/i)
  })

  it('shows a suspend badge when the subscription status for THIS account reports admin_suspended', () => {
    subStatus.value = { account_id: 'a1', admin_suspended: true }
    const { getByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-suspended-badge')).toBeTruthy()
  })

  it('does NOT show the suspend badge when the loaded status belongs to a DIFFERENT account (stale A→B)', () => {
    subStatus.value = { account_id: 'other-account', admin_suspended: true }
    const { queryByTestId } = render(<AccountDetailPage />)
    expect(queryByTestId('account-detail-suspended-badge')).toBeNull()
  })

  it('shows a top-level Loading while the account is resolving (not yet initialized), never a false error flash', () => {
    // Fresh mount / deep-link: the load runs in a post-paint effect, so account=null,
    // error=null, isInitialized=false — must be Loading, NOT the ErrorState.
    detail.account = null
    detail.loading = true
    detail.isInitialized = false
    const { getByTestId, queryByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('page-loading')).toBeTruthy()
    expect(queryByTestId('account-detail-error')).toBeNull()
    expect(queryByTestId('account-detail-overview-card')).toBeNull()
  })

  it('shows a retryable ErrorState when the account fails to load', () => {
    detail.account = null
    detail.loading = false
    detail.error = 'nope'
    const { getByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-error')).toBeTruthy()
  })

  it('shows the recoverable ErrorState (not a stuck spinner) when a load RESOLVED with no account and no error', () => {
    // Degenerate/empty resolve: isInitialized=true but account=null and error=null.
    // The gate must fall to the retryable ErrorState, never stick on Loading.
    detail.account = null
    detail.loading = false
    detail.error = null
    detail.isInitialized = true
    const { getByTestId, queryByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-error')).toBeTruthy()
    expect(queryByTestId('page-loading')).toBeNull()
  })
})

describe('TEST-5 — saas gating of the billing widgets', () => {
  it('renders all five sections when billing::admin is held', () => {
    hasBilling.value = true
    const { getByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-overview-card')).toBeTruthy()
    expect(getByTestId('members-widget')).toBeTruthy()
    expect(getByTestId('subscription-widget')).toBeTruthy()
    expect(getByTestId('usage-widget')).toBeTruthy()
    expect(getByTestId('credits-widget')).toBeTruthy()
  })

  it('hides all three billing widgets when billing::admin is absent (Overview + Members remain)', () => {
    hasBilling.value = false
    const { getByTestId, queryByTestId } = render(<AccountDetailPage />)
    expect(getByTestId('account-detail-overview-card')).toBeTruthy()
    expect(getByTestId('members-widget')).toBeTruthy()
    expect(queryByTestId('subscription-widget')).toBeNull()
    expect(queryByTestId('usage-widget')).toBeNull()
    expect(queryByTestId('credits-widget')).toBeNull()
  })
})
