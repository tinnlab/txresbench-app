import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { AdminAccountSummary, AccountMember, Account } from '@/api-client/types'
import { useAdminAccountsStore } from '@/modules/admin-accounts/stores/AdminAccounts.store'
import { useAccountMembersStore } from '@/modules/admin-accounts/stores/AccountMembers.store'
import { useAccountDetailStore } from '@/modules/admin-accounts/stores/AccountDetail.store'
import { useBillingSubscriptionStore } from '@/modules/billing/stores/BillingSubscription.store'
import { useUsageQuotaStore } from '@/modules/billing/stores/UsageQuota.store'
import { useCreditsGrantsStore } from '@/modules/billing/stores/CreditsGrants.store'
import { useBillingUserDirectoryStore } from '@/modules/billing/lib/userDirectory'
// Side-effect import: register the account actions so the gallery's interactive
// recipes (Create / member controls) don't throw ActionNotFoundError (the gallery
// doesn't load `module.tsx`).
import '@/core/actions/builtin/adminAccountActions'

/**
 * Gallery seed for the Accounts admin page (#44, ITEM-9). The page fetches from
 * `Admin.listAccounts` at runtime; the gallery instead seeds the store's state
 * (the `project/gallery.tsx` `setup`-`setState` pattern) so the design-critic
 * vision pass reviews the POPULATED list (mixed personal + org rows with real
 * member counts + owners), plus the empty and cold-load-error states, and the
 * populated Members drawer. The 390px narrow-viewport state is applied by the
 * shared theme/viewport matrix.
 */
const AccountsAdminPage = lazy(() =>
  import('./pages/AccountsAdminPage').then(m => ({ default: m.AccountsAdminPage })),
)
const AccountDetailPage = lazy(() =>
  import('./pages/AccountDetailPage').then(m => ({ default: m.AccountDetailPage })),
)

const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`

function account(id: string, name: string, kind: Account['kind']): Account {
  return {
    id,
    name,
    kind,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...(kind === 'personal' ? { personal_user_id: U('f1') } : {}),
  }
}

// Realistic seeded people (real-looking names + emails) so the vision pass reviews
// a POPULATED render a human can read — the original UUID mocks are WHY the raw-id
// defect (#51) slipped past the gallery review. `f5` deliberately has no
// display_name, exercising the username-fallback primary-label path.
export const seededAccounts: AdminAccountSummary[] = [
  {
    account: account(U('a1'), 'Acme Bio', 'organization'),
    member_count: 7,
    owner_user_id: U('f1'),
    owner_label: 'Ada Lovelace',
  },
  {
    account: account(U('a2'), 'Lab 42', 'organization'),
    member_count: 3,
    owner_user_id: U('f2'),
    owner_label: 'Grace Hopper',
  },
  {
    account: account(U('a3'), 'John Doe (personal)', 'personal'),
    member_count: 1,
    owner_user_id: U('f3'),
    owner_label: 'John Doe',
  },
  {
    account: account(U('a4'), 'Orphan Org', 'organization'),
    member_count: 0,
    owner_user_id: undefined,
    owner_label: undefined,
  },
]

export const seededMembers: AccountMember[] = [
  {
    account_id: U('a1'),
    user_id: U('f1'),
    role: 'owner',
    created_at: '2026-07-15T00:00:00Z',
    username: 'ada',
    email: 'ada@acme.bio',
    display_name: 'Ada Lovelace',
  },
  {
    account_id: U('a1'),
    user_id: U('f4'),
    role: 'admin',
    created_at: '2026-07-16T00:00:00Z',
    username: 'aturing',
    email: 'alan.turing@acme.bio',
    display_name: 'Alan Turing',
  },
  {
    account_id: U('a1'),
    user_id: U('f5'),
    role: 'member',
    created_at: '2026-07-17T00:00:00Z',
    username: 'kjohnson',
    email: 'katherine.johnson@acme.bio',
    display_name: undefined,
  },
]

const LIST_DEFAULTS = {
  accounts: [] as AdminAccountSummary[],
  total: 0,
  currentPage: 1,
  pageSize: 20,
  kind: undefined,
  isInitialized: true,
  loading: false,
  creating: false,
  error: null as string | null,
}

const MEMBERS_RESET = {
  account: null as Account | null,
  members: [] as AccountMember[],
  total: 0,
  currentPage: 1,
  pageSize: 20,
  isInitialized: true,
  loading: false,
  mutating: false,
  error: null as string | null,
}

function seedList(partial: Partial<typeof LIST_DEFAULTS>) {
  return () => {
    useAdminAccountsStore.setState({ ...LIST_DEFAULTS, ...partial } as never)
    useAccountMembersStore.setState({ ...MEMBERS_RESET } as never)
  }
}

// ---- Account-detail page seeds (#57) ------------------------------------------
const detailAccount = seededAccounts[0].account // 'Acme Bio' (organization)

const subActive = {
  account_id: detailAccount.id,
  plan_id: 'pro',
  subscription_status: 'active',
  suspended: false,
  plan_manually_set: false,
  premium: false,
}
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
}
const usageRows = [
  {
    id: U('u1'),
    account_id: detailAccount.id,
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
const creditsPopulated = {
  account_id: detailAccount.id,
  balance_cents: 5000,
  grants: [
    {
      id: U('c1'),
      account_id: detailAccount.id,
      active: true,
      amount_cents: 5000,
      reason: 'Partner comp — Q3',
      granted_by: U('f1'),
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-12-31T23:59:59Z',
    },
  ],
}

/** Seed the account-detail stores. `billing` seeds the saas widgets too (they render
 *  only under `gallery:saas`, where `billing::admin` is present + held). */
function seedDetail(opts: {
  account?: Account | null
  loading?: boolean
  error?: string | null
  members?: AccountMember[]
  billing?: boolean
}) {
  return () => {
    const account = opts.account === undefined ? detailAccount : opts.account
    useAccountDetailStore.setState({
      accountId: detailAccount.id,
      account,
      isInitialized: true,
      loading: opts.loading ?? false,
      error: opts.error ?? null,
    } as never)
    useAccountMembersStore.setState({
      ...MEMBERS_RESET,
      account,
      members: opts.members ?? seededMembers,
      total: (opts.members ?? seededMembers).length,
    } as never)
    useBillingUserDirectoryStore.setState({
      names: { [U('f1')]: 'Ada Lovelace', [U('f4')]: 'Alan Turing' },
      pending: {},
    } as never)
    if (opts.billing) {
      useBillingSubscriptionStore.setState({
        accountId: detailAccount.id,
        billing: subActive,
        status: { account_id: detailAccount.id, admin_suspended: false },
        planOverride: null,
        isInitialized: true,
        loading: false,
        error: null,
      } as never)
      useUsageQuotaStore.setState({
        accountId: detailAccount.id,
        rows: usageRows,
        total: usageRows.length,
        currentPage: 1,
        pageSize: 20,
        quota: usageQuota,
        isInitialized: true,
        loading: false,
        error: null,
      } as never)
      useCreditsGrantsStore.setState({
        accountId: detailAccount.id,
        credits: creditsPopulated,
        premium: false,
        premiumKnown: true,
        isInitialized: true,
        loading: false,
        error: null,
      } as never)
    }
  }
}

export const gallery: ModuleGallery = {
  // The account-detail page FETCHES on mount (real behavior): `Admin.getAccount` for
  // the account context and `Account.listMembers` for the members section. The gallery
  // runs these fetches (the store-seed applies after the child's mount effect), so the
  // cassette must answer them — otherwise the detail surfaces error with an id-less
  // account. `Account.listMembers` echoes the seeded members for the current account.
  cassette: {
    'Admin.getAccount': detailAccount,
    'Account.listMembers': {
      members: seededMembers,
      total: seededMembers.length,
      page: 1,
      per_page: 20,
    },
  },
  seeded: [
    {
      slug: 'accounts-admin-populated',
      title: 'Accounts admin — populated list',
      note: 'All accounts (mixed personal + org), with member counts + owners, paged.',
      path: '/settings/accounts-admin',
      initialPath: '/settings/accounts-admin',
      component: AccountsAdminPage,
      setup: seedList({
        accounts: seededAccounts,
        total: seededAccounts.length,
      }),
    },
    {
      slug: 'accounts-admin-empty',
      title: 'Accounts admin — empty',
      note: 'A fresh deployment with no accounts yet.',
      path: '/settings/accounts-admin',
      initialPath: '/settings/accounts-admin',
      component: AccountsAdminPage,
      setup: seedList({ accounts: [], total: 0 }),
    },
    {
      slug: 'accounts-admin-error',
      title: 'Accounts admin — cold-load error',
      note: 'A backend outage on the initial load: a retryable ErrorState, not a blank card.',
      path: '/settings/accounts-admin',
      initialPath: '/settings/accounts-admin',
      component: AccountsAdminPage,
      setup: seedList({
        accounts: [],
        total: 0,
        error: 'Failed to load accounts',
      }),
    },
    {
      slug: 'account-detail-populated-saas',
      title: 'Account detail — all sections (saas)',
      note: 'The full detail page for an org: Overview + Members + Subscription + Usage + Credits. Billing sections render only under gallery:saas (billing::admin present).',
      path: '/settings/accounts-admin/:id',
      initialPath: `/settings/accounts-admin/${detailAccount.id}`,
      component: AccountDetailPage,
      setup: seedDetail({ billing: true }),
      fullHeight: true,
    },
    {
      slug: 'account-detail-populated-nonsaas',
      title: 'Account detail — Overview + Members only (non-saas)',
      note: 'The same page without billing::admin: only Overview + Members render (the billing widgets self-hide). This is the desktop/OSS state.',
      path: '/settings/accounts-admin/:id',
      initialPath: `/settings/accounts-admin/${detailAccount.id}`,
      component: AccountDetailPage,
      setup: seedDetail({ billing: false }),
      fullHeight: true,
    },
    {
      slug: 'account-detail-loading',
      title: 'Account detail — loading',
      note: 'The account is still resolving from Admin.getAccount: a top-level spinner, not a blank page.',
      path: '/settings/accounts-admin/:id',
      initialPath: `/settings/accounts-admin/${detailAccount.id}`,
      component: AccountDetailPage,
      setup: seedDetail({ account: null, loading: true }),
    },
    {
      slug: 'account-detail-error',
      title: 'Account detail — load error',
      note: 'The account failed to resolve (deleted / no access): a retryable ErrorState.',
      path: '/settings/accounts-admin/:id',
      initialPath: `/settings/accounts-admin/${detailAccount.id}`,
      component: AccountDetailPage,
      setup: seedDetail({ account: null, error: "This account couldn't be loaded." }),
    },
  ],
}
