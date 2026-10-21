import { lazy } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { SettingsPageContainer } from '@ziee/shell'
import { SubscriptionBillingView } from '@/modules/billing/pages/SubscriptionBillingView'
import { UsageQuotaView } from '@/modules/billing/pages/UsageQuotaView'
import { CreditsGrantsView } from '@/modules/billing/pages/CreditsGrantsView'
// Side-effect: register the billing actions so any interactive control in a story
// (a Revoke / premium toggle wired through runAction) doesn't throw.
import '@/core/actions/builtin/billingActions'

/**
 * Gallery seed for the billing WIDGETS (#45/#46/#47). Since the #57 IA refactor the
 * three standalone pages + account picker are retired — the Subscription / Usage &
 * Quota / Credits surfaces are now the reused, props-driven VIEW components mounted on
 * the account-detail page. This gallery reviews those Views DIRECTLY with REALISTIC
 * seeded props (real account + admin names, dollar amounts formatted from CENTS, a
 * ledger with active + revoked + expired grants, admin-suspend / plan-override /
 * premium states). The composed page (all sections together, under saas) is reviewed
 * in `admin-accounts/gallery.tsx`. The 390px narrow-viewport state is applied by the
 * shared theme/viewport matrix.
 */
const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`

const ADA = U('f1')
const TURING = U('f4')
const ACTOR_NAMES: Record<string, string> = {
  [ADA]: 'Ada Lovelace',
  [TURING]: 'Alan Turing',
}
const resolveName = (id?: string | null) => (id ? (ACTOR_NAMES[id] ?? id) : '')
const noop = () => {}

const activeBilling = {
  account_id: U('a1'),
  plan_id: 'pro',
  subscription_status: 'active',
  suspended: false,
  plan_manually_set: false,
  premium: false,
} as never

const usageQuota = {
  plan_id: 'pro',
  compute_allowance: 1000,
  compute_used: 820,
  storage_allowance: 500,
  storage_used: 130,
  hard_cap: false,
  overage: true,
  spend_cap_cents: 50000,
  alert_level_compute: 80,
  alert_level_storage: 50,
  suspended: false,
} as never

const usageRows = [
  {
    id: U('u1'),
    account_id: U('a1'),
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-08-31T23:59:59Z',
    compute_core_hours: 812.5,
    storage_gb_months: 128.4,
    gpu_hours: 14,
    egress_gb: 42.1,
    reported_at: '2026-09-01T02:00:00Z',
    updated_at: '2026-09-01T02:00:00Z',
  },
  {
    id: U('u2'),
    account_id: U('a1'),
    period_start: '2026-07-01T00:00:00Z',
    period_end: '2026-07-31T23:59:59Z',
    compute_core_hours: 640,
    storage_gb_months: 110,
    gpu_hours: 6,
    egress_gb: 30.5,
    updated_at: '2026-08-01T02:00:00Z',
  },
] as never

export const seededGrants = [
  {
    id: U('c1'),
    account_id: U('a1'),
    active: true,
    amount_cents: 5000,
    reason: 'Partner comp — Q3',
    granted_by: ADA,
    created_at: '2026-08-01T00:00:00Z',
    expires_at: '2026-12-31T23:59:59Z',
  },
  {
    id: U('c2'),
    account_id: U('a1'),
    active: false,
    amount_cents: 2500,
    reason: 'Onboarding trial credit',
    granted_by: TURING,
    created_at: '2026-06-10T00:00:00Z',
    revoked_at: '2026-07-02T00:00:00Z',
    revoked_by: ADA,
  },
  {
    id: U('c3'),
    account_id: U('a1'),
    active: false,
    amount_cents: 1000,
    reason: 'Launch promo',
    granted_by: ADA,
    created_at: '2026-03-01T00:00:00Z',
    expires_at: '2026-05-01T23:59:59Z',
  },
]

const creditsPopulated = { account_id: U('a1'), balance_cents: 5000, grants: seededGrants } as never

/** Render a View inside the settings container, matching how the detail page frames it. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SettingsPageContainer title={title} subtitle="Account-detail widget (gallery preview).">
      <div className="flex flex-col gap-4">{children}</div>
    </SettingsPageContainer>
  )
}

const SubscriptionPopulated = () => (
  <Frame title="Subscription & Billing">
    <SubscriptionBillingView
      hasAccount
      loading={false}
      error={null}
      billing={activeBilling}
      status={{ account_id: U('a1'), admin_suspended: false } as never}
      planOverride={null}
      canManageAccounts
      resolveName={resolveName}
      onRetry={noop}
      onOpenSetPlan={noop}
      onClearPlan={noop}
      onOpenSuspend={noop}
      onReactivate={noop}
    />
  </Frame>
)

const SubscriptionSuspendedOverride = () => (
  <Frame title="Subscription & Billing">
    <SubscriptionBillingView
      hasAccount
      loading={false}
      error={null}
      billing={{ ...(activeBilling as object), plan_id: 'enterprise', plan_manually_set: true, premium: true } as never}
      status={{
        account_id: U('a1'),
        admin_suspended: true,
        admin_suspend_reason: 'Abuse investigation',
        admin_suspended_by: TURING,
        admin_suspended_at: '2026-08-20T00:00:00Z',
      } as never}
      planOverride={{
        account_id: U('a1'),
        plan_id: 'enterprise',
        plan_manually_set: true,
        plan_override_by: ADA,
        plan_override_at: '2026-08-19T00:00:00Z',
      } as never}
      canManageAccounts
      resolveName={resolveName}
      onRetry={noop}
      onOpenSetPlan={noop}
      onClearPlan={noop}
      onOpenSuspend={noop}
      onReactivate={noop}
    />
  </Frame>
)

const SubscriptionError = () => (
  <Frame title="Subscription & Billing">
    <SubscriptionBillingView
      hasAccount
      loading={false}
      error="Failed to load billing state"
      billing={null}
      status={null}
      planOverride={null}
      canManageAccounts
      resolveName={resolveName}
      onRetry={noop}
      onOpenSetPlan={noop}
      onClearPlan={noop}
      onOpenSuspend={noop}
      onReactivate={noop}
    />
  </Frame>
)

const UsagePopulated = () => (
  <Frame title="Usage & Quota">
    <UsageQuotaView
      hasAccount
      loading={false}
      error={null}
      quota={usageQuota}
      rows={usageRows}
      total={(usageRows as unknown[]).length}
      currentPage={1}
      pageSize={20}
      onRetry={noop}
      onPageChange={noop}
    />
  </Frame>
)

const UsageError = () => (
  <Frame title="Usage & Quota">
    <UsageQuotaView
      hasAccount
      loading={false}
      error="Failed to load usage & quota"
      quota={null}
      rows={[] as never}
      total={0}
      currentPage={1}
      pageSize={20}
      onRetry={noop}
      onPageChange={noop}
    />
  </Frame>
)

const CreditsPopulated = () => (
  <Frame title="Credits & Grants">
    <CreditsGrantsView
      hasAccount
      loading={false}
      error={null}
      credits={creditsPopulated}
      premium={false}
      premiumKnown
      canManage
      resolveName={resolveName}
      onRetry={noop}
      onOpenGrant={noop}
      onRevoke={noop}
      onSetPremium={noop}
    />
  </Frame>
)

const CreditsPremium = () => (
  <Frame title="Credits & Grants">
    <CreditsGrantsView
      hasAccount
      loading={false}
      error={null}
      credits={creditsPopulated}
      premium
      premiumKnown
      canManage
      resolveName={resolveName}
      onRetry={noop}
      onOpenGrant={noop}
      onRevoke={noop}
      onSetPremium={noop}
    />
  </Frame>
)

/** Wrap a local story component as a lazy module so it satisfies the gallery's
 *  `LazyExoticComponent` surface type without a separate file per story. */
const asLazy = (C: () => ReactNode) => lazy(async () => ({ default: C as () => ReactElement }))

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'billing-subscription-populated',
      title: 'Subscription — populated (pro / active)',
      note: 'An account on pro with an active subscription; no admin hold or override.',
      path: '/gallery/billing-subscription',
      initialPath: '/gallery/billing-subscription',
      component: asLazy(SubscriptionPopulated),
    },
    {
      slug: 'billing-subscription-suspended-override',
      title: 'Subscription — admin-suspended + plan override',
      note: 'Admin hold with reason + grantor, an active admin plan override, and a premium comp.',
      path: '/gallery/billing-subscription',
      initialPath: '/gallery/billing-subscription',
      component: asLazy(SubscriptionSuspendedOverride),
    },
    {
      slug: 'billing-subscription-error',
      title: 'Subscription — cold-load error',
      note: 'A backend outage on load: a retryable ErrorState, not a blank card.',
      path: '/gallery/billing-subscription',
      initialPath: '/gallery/billing-subscription',
      component: asLazy(SubscriptionError),
    },
    {
      slug: 'billing-usage-populated',
      title: 'Usage & Quota — populated',
      note: 'Quota allowances vs used, spend cap ($500), and a metered usage rollup.',
      path: '/gallery/billing-usage',
      initialPath: '/gallery/billing-usage',
      component: asLazy(UsagePopulated),
    },
    {
      slug: 'billing-usage-error',
      title: 'Usage & Quota — cold-load error',
      note: 'A retryable ErrorState on the quota + usage load.',
      path: '/gallery/billing-usage',
      initialPath: '/gallery/billing-usage',
      component: asLazy(UsageError),
    },
    {
      slug: 'billing-credits-populated',
      title: 'Credits — populated ledger (active + revoked + expired)',
      note: 'Balance $50.00; the full auditable ledger keeps revoked + expired grants with grantor names.',
      path: '/gallery/billing-credits',
      initialPath: '/gallery/billing-credits',
      component: asLazy(CreditsPopulated),
    },
    {
      slug: 'billing-credits-premium',
      title: 'Credits — premium comp on',
      note: 'The premium (unlimited) override enabled, with the balance + ledger.',
      path: '/gallery/billing-credits',
      initialPath: '/gallery/billing-credits',
      component: asLazy(CreditsPremium),
    },
  ],
}
