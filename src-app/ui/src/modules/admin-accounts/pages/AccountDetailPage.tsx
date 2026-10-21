import { useEffect } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Building2, User as UserIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Descriptions,
  ErrorState,
  Flex,
  Text,
  message,
} from '@ziee/kit'
import { SettingsPageContainer, Loading } from '@ziee/shell'
import { Permissions } from '@/api-client/permissions'
import { useHasPermission, usePermission } from '@/core/permissions'
import { runAction } from '@/core/actions/defineAction'
import type { AdminAccountSummary } from '@/api-client/types'
import { AccountDetail } from '@/modules/admin-accounts/stores/AccountDetail.store'
import { AccountMembers } from '@/modules/admin-accounts/stores/AccountMembers.store'
import { MembersSection } from '@/modules/admin-accounts/components/MembersSection'
// Billing widgets (reused Views + account-scoped stores + drawers). Always
// bundled; they RENDER only under the `billing::admin` presence gate (INV-2).
import { SubscriptionBillingView } from '@/modules/billing/pages/SubscriptionBillingView'
import { UsageQuotaView } from '@/modules/billing/pages/UsageQuotaView'
import { CreditsGrantsView } from '@/modules/billing/pages/CreditsGrantsView'
import { BillingSubscription } from '@/modules/billing/stores/BillingSubscription.store'
import { UsageQuota } from '@/modules/billing/stores/UsageQuota.store'
import { CreditsGrants } from '@/modules/billing/stores/CreditsGrants.store'
import { BillingUserDirectory, nameFor } from '@/modules/billing/lib/userDirectory'
import { SetPlanDrawer } from '@/modules/billing/components/SetPlanDrawer'
import { SetPlanDrawer as SetPlanDrawerStore } from '@/modules/billing/components/SetPlanDrawer.store'
import { SuspendDrawer } from '@/modules/billing/components/SuspendDrawer'
import { SuspendDrawer as SuspendDrawerStore } from '@/modules/billing/components/SuspendDrawer.store'
import { GrantCreditDrawer } from '@/modules/billing/components/GrantCreditDrawer'
import { GrantCreditDrawer as GrantCreditDrawerStore } from '@/modules/billing/components/GrantCreditDrawer.store'

/**
 * Account-detail page (#57) — the single per-account admin surface. Opening an
 * account (`/settings/accounts-admin/:id`) is now the context: the account comes
 * from the route param, NOT a picker. Stacked sections mirror the settings idiom
 * (`account/pages/AccountSettingsPage.tsx`): Overview + Members always render
 * (`admin::accounts`); Subscription / Usage & Quota / Credits self-hide unless
 * `useHasPermission('billing::admin')` (presence-first, INV-2) — so on a
 * desktop/OSS build they simply aren't there, even for a root admin.
 *
 * Route-guarded on `Permissions.AdminAccounts` (INV-1: a non-admin deep-linking
 * here gets an in-place 403 while their own `/settings` still loads).
 */
export function AccountDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const location = useLocation()
  // Optional owner_label/member_count hint carried from the list row (fast path);
  // never required — a deep-link resolves everything from `Admin.getAccount`.
  const summaryHint = (location.state as { summary?: AdminAccountSummary } | null)?.summary
  const hasBilling = useHasPermission('billing::admin')

  const {
    account = null,
    error = null,
    isInitialized = false,
    accountId: loadedId = null,
  } = AccountDetail

  useEffect(() => {
    if (id && id !== loadedId) void AccountDetail.load(id)
  }, [id, loadedId])

  return (
    <SettingsPageContainer
      title={account?.name ?? 'Account'}
      subtitle="Everything about this account in one place — members, subscription, usage, and credits."
      data-testid="account-detail-page"
    >
      <div className="mb-3">
        <Link to="/settings/accounts-admin">
          <Button
            variant="ghost"
            icon={<ArrowLeft aria-hidden="true" />}
            data-testid="account-detail-back"
          >
            All accounts
          </Button>
        </Link>
      </div>

      {!account ? (
        // No account yet: show Loading until a load has actually RESOLVED. On a fresh
        // mount / deep-link / refresh the load runs in a post-paint effect, so the first
        // frame has account=null + error=null + isInitialized=false — show Loading, never
        // a false "couldn't be loaded" flash (INV-1 deep-link path). Once a load has
        // completed (`isInitialized`) with still no account — an error, or a degenerate
        // empty body — show the recoverable ErrorState rather than sticking on Loading.
        error || isInitialized ? (
          <ErrorState
            resource="account"
            description="This account couldn't be loaded. It may not exist, or you may not have access."
            details={error ?? undefined}
            onRetry={() => id && void AccountDetail.load(id)}
            data-testid="account-detail-error"
          />
        ) : (
          <Loading label="Loading account" />
        )
      ) : (
        <div className="flex flex-col gap-4">
          <OverviewSection ownerLabelHint={summaryHint?.owner_label} />
          <MembersSection account={account} />
          {hasBilling && <SubscriptionSection accountId={id} />}
          {hasBilling && <UsageSection accountId={id} />}
          {hasBilling && <CreditsSection accountId={id} />}
        </div>
      )}
    </SettingsPageContainer>
  )
}

/**
 * Overview — account identity + suspend state. `name`/`kind`/`created_at` from the
 * resolved `Account`; Owner derived from the loaded members (the `role === 'owner'`
 * member, by NAME not UUID — #51) with the list's `owner_label` hint as a fallback;
 * the suspend Badge reflects `BillingSubscription.status.admin_suspended` when
 * available (saas — the Subscription section owns the authoritative control).
 */
function OverviewSection({ ownerLabelHint }: { ownerLabelHint?: string }) {
  const { account = null } = AccountDetail
  const { members = [], total: memberTotal = 0 } = AccountMembers
  const { status = null } = BillingSubscription
  if (!account) return null

  const isOrg = account.kind === 'organization'
  const ownerMember = members.find(m => m.role === 'owner')
  const ownerName = ownerLabelHint ?? (ownerMember ? (ownerMember.display_name ?? ownerMember.username) : null)
  // The full member set is known only when the whole list is on the loaded page.
  // If it's paginated and no owner is on THIS page, we can't assert "No owner"
  // (the owner may be on a later page) — show a neutral placeholder instead of a
  // false negative. On a navigation the `owner_label` hint already gives the exact
  // owner, so this indeterminate case only affects deep-links to large orgs.
  const fullSetKnown = memberTotal === members.length
  const ownerDisplay = ownerName ?? (fullSetKnown ? 'No owner' : '—')
  // Scope the suspend badge to THIS account: `status` is loaded by SubscriptionSection
  // and, on an A→B account switch, briefly still holds A's status before B reloads.
  const suspended = status?.admin_suspended === true && status?.account_id === account.id

  return (
    <Card title="Overview" data-testid="account-detail-overview-card">
      <Flex className="gap-2 items-center mb-3 flex-wrap">
        {isOrg ? <Building2 aria-hidden="true" /> : <UserIcon aria-hidden="true" />}
        <Text className="font-medium">{account.name}</Text>
        <Badge tone={isOrg ? 'info' : 'neutral'} data-testid="account-detail-kind-badge">
          {isOrg ? 'Organization' : 'Personal'}
        </Badge>
        {suspended && (
          <Badge tone="error" data-testid="account-detail-suspended-badge">
            Suspended
          </Badge>
        )}
      </Flex>
      <Descriptions
        size="sm"
        column={3}
        data-testid="account-detail-descriptions"
        items={[
          {
            key: 'kind',
            label: 'Kind',
            children: isOrg ? 'Organization' : 'Personal',
          },
          {
            key: 'owner',
            label: 'Owner',
            children: (
              <span data-testid="account-detail-owner">{ownerDisplay}</span>
            ),
          },
          {
            key: 'created',
            label: 'Created',
            children: new Date(account.created_at).toLocaleDateString(),
          },
        ]}
      />
    </Card>
  )
}

/** Subscription & Billing widget — re-homes the retired page's inner wiring, with
 *  the account from the route instead of the picker. */
function SubscriptionSection({ accountId }: { accountId: string }) {
  const {
    billing = null,
    status = null,
    planOverride = null,
    loading = false,
    error = null,
    accountId: loadedAccountId = null,
  } = BillingSubscription
  const { names = {} } = BillingUserDirectory
  const canManageAccounts = usePermission(Permissions.AdminAccounts)

  useEffect(() => {
    if (accountId && accountId !== loadedAccountId) void BillingSubscription.load(accountId)
  }, [accountId, loadedAccountId])

  useEffect(() => {
    BillingUserDirectory.resolveMany([status?.admin_suspended_by, planOverride?.plan_override_by])
  }, [status?.admin_suspended_by, planOverride?.plan_override_by])

  useEffect(() => {
    if (billing && error) {
      message.error(error)
      BillingSubscription.clearError()
    }
  }, [error, billing])

  const resolveName = (id?: string | null) => nameFor(names, id)

  const runOrToast = async (id: 'billing.clearPlan' | 'billing.reactivateAccount') => {
    if (!accountId) return
    try {
      await runAction(id, { account_id: accountId })
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'The action failed')
    }
  }

  return (
    <>
      <SubscriptionBillingView
        hasAccount
        loading={loading}
        error={error}
        billing={billing}
        status={status}
        planOverride={planOverride}
        canManageAccounts={canManageAccounts}
        resolveName={resolveName}
        onRetry={() => accountId && void BillingSubscription.load(accountId)}
        onOpenSetPlan={() => SetPlanDrawerStore.open()}
        onClearPlan={() => void runOrToast('billing.clearPlan')}
        onOpenSuspend={() => SuspendDrawerStore.open()}
        onReactivate={() => void runOrToast('billing.reactivateAccount')}
      />
      <SetPlanDrawer accountId={accountId} />
      <SuspendDrawer accountId={accountId} />
    </>
  )
}

/** Usage & Quota widget — read-only, server-paged. */
function UsageSection({ accountId }: { accountId: string }) {
  const {
    rows = [],
    total = 0,
    currentPage = 1,
    pageSize = 20,
    quota = null,
    loading = false,
    error = null,
    accountId: loadedAccountId = null,
  } = UsageQuota

  useEffect(() => {
    if (accountId && accountId !== loadedAccountId) void UsageQuota.load(accountId, 1)
  }, [accountId, loadedAccountId])

  useEffect(() => {
    if ((quota || rows.length > 0) && error) {
      message.error(error)
      UsageQuota.clearError()
    }
  }, [error, quota, rows.length])

  const onPageChange = (page: number, size?: number) => {
    if (!accountId) return
    const newSize = size ?? pageSize
    const newPage = size && size !== pageSize ? 1 : page
    void UsageQuota.load(accountId, newPage, newSize)
  }

  return (
    <UsageQuotaView
      hasAccount
      loading={loading}
      error={error}
      quota={quota}
      rows={rows}
      total={total}
      currentPage={currentPage}
      pageSize={pageSize}
      onRetry={() => accountId && void UsageQuota.load(accountId, currentPage, pageSize)}
      onPageChange={onPageChange}
    />
  )
}

/** Credits & Grants widget — balance + auditable ledger + premium comp. */
function CreditsSection({ accountId }: { accountId: string }) {
  const {
    credits = null,
    premium = false,
    premiumKnown = false,
    loading = false,
    error = null,
    accountId: loadedAccountId = null,
  } = CreditsGrants
  const { names = {} } = BillingUserDirectory

  useEffect(() => {
    if (accountId && accountId !== loadedAccountId) void CreditsGrants.load(accountId)
  }, [accountId, loadedAccountId])

  useEffect(() => {
    const ids = (credits?.grants ?? []).flatMap(g => [g.granted_by, g.revoked_by])
    BillingUserDirectory.resolveMany(ids)
  }, [credits])

  useEffect(() => {
    if (credits && error) {
      message.error(error)
      CreditsGrants.clearError()
    }
  }, [error, credits])

  const resolveName = (id?: string | null) => nameFor(names, id)

  const revoke = async (grantId: string) => {
    if (!accountId) return
    try {
      await runAction('billing.revokeCredit', { account_id: accountId, grant_id: grantId })
      message.success('Grant revoked')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to revoke the grant')
    }
  }
  const setPremium = async (next: boolean) => {
    if (!accountId) return
    try {
      await runAction('billing.setPremium', { account_id: accountId, premium: next })
      message.success(next ? 'Premium comp enabled' : 'Premium comp disabled')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update premium comp')
    }
  }

  return (
    <>
      <CreditsGrantsView
        hasAccount
        loading={loading}
        error={error}
        credits={credits}
        premium={premium}
        premiumKnown={premiumKnown}
        canManage
        resolveName={resolveName}
        onRetry={() => accountId && void CreditsGrants.load(accountId)}
        onOpenGrant={() => GrantCreditDrawerStore.open()}
        onRevoke={(grantId: string) => void revoke(grantId)}
        onSetPremium={(next: boolean) => void setPremium(next)}
      />
      <GrantCreditDrawer accountId={accountId} />
    </>
  )
}
