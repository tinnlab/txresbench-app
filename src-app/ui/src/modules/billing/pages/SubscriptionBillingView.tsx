import { Badge, Button, Card, Confirm, Descriptions, Empty, ErrorState, Flex, Text } from '@ziee/kit'
import type { BadgeTone } from '@ziee/kit'
import { Loading } from '@ziee/shell'
import type {
  AdminBillingStateResponse,
  AdminAccountStatusResponse,
  AdminPlanOverrideResponse,
} from '@/api-client-saas/types'

export interface SubscriptionBillingViewProps {
  hasAccount: boolean
  loading: boolean
  error: string | null
  billing: AdminBillingStateResponse | null
  status: AdminAccountStatusResponse | null
  planOverride: AdminPlanOverrideResponse | null
  canManageAccounts: boolean
  resolveName: (id?: string | null) => string
  onRetry: () => void
  onOpenSetPlan: () => void
  onClearPlan: () => void
  onOpenSuspend: () => void
  onReactivate: () => void
}

/** Human label for a Stripe subscription status enum-string (never shown raw).
 *  Defensive against a missing/partial status so a bad response degrades to a
 *  readable label instead of crashing the render. */
function statusLabel(s: string | undefined | null): string {
  if (!s) return 'Unknown'
  return s
    .split('_')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function statusTone(s: string | undefined | null): BadgeTone {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'success'
    case 'past_due':
    case 'incomplete':
      return 'warning'
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'error'
    default:
      return 'neutral'
  }
}

/**
 * Presentational Subscription & Billing view (#45) — pure props, no permission
 * gate, so it is unit-testable in the default build. The page wrapper supplies the
 * data + the presence/permission gating + the action handlers.
 */
export function SubscriptionBillingView(props: SubscriptionBillingViewProps) {
  const {
    hasAccount,
    loading,
    error,
    billing,
    status,
    planOverride,
    canManageAccounts,
    resolveName,
    onRetry,
    onOpenSetPlan,
    onClearPlan,
    onOpenSuspend,
    onReactivate,
  } = props

  if (!hasAccount) {
    return (
      <Card title="Subscription & Billing" data-testid="billing-subscription-card">
        <Empty
          description="Select an account to view its subscription & billing."
          data-testid="billing-subscription-noaccount"
        />
      </Card>
    )
  }

  const adminSuspended = status?.admin_suspended === true
  const billingSuspended = billing?.suspended === true
  // The plan-override DEFINITE state comes from the billing READ (#39 —
  // `AdminBillingStateResponse.plan_manually_set`), so it is known on cold load, not only
  // after a set/clear mutation returns a `planOverride` (INV-4). `planOverride` is kept for
  // the extra by/at detail, which only a mutation response carries.
  const overrideActive = billing?.plan_manually_set === true

  return (
    <Card
      title="Subscription & Billing"
      data-testid="billing-subscription-card"
      extra={
        <Flex className="gap-1 items-center flex-wrap">
          <Button
            variant="outline"
            onClick={onOpenSetPlan}
            disabled={!billing}
            data-testid="billing-open-setplan"
          >
            Set plan
          </Button>
          <Confirm
            title="Clear plan override?"
            description="Stripe will control the plan again from the next webhook."
            okText="Clear override"
            cancelText="Cancel"
            danger
            onConfirm={onClearPlan}
            data-testid="billing-clear-plan-confirm"
          >
            <Button
              variant="ghost"
              disabled={!billing}
              data-testid="billing-clear-plan"
            >
              Clear override
            </Button>
          </Confirm>
          {canManageAccounts &&
            (adminSuspended ? (
              <Confirm
                title="Reactivate account?"
                description="Lifts the admin hold. A real billing suspension is not affected."
                okText="Reactivate"
                cancelText="Cancel"
                onConfirm={onReactivate}
                data-testid="billing-reactivate-confirm"
              >
                <Button variant="outline" data-testid="billing-reactivate">
                  Reactivate
                </Button>
              </Confirm>
            ) : (
              <Button
                variant="destructive"
                onClick={onOpenSuspend}
                disabled={!billing}
                data-testid="billing-open-suspend"
              >
                Suspend
              </Button>
            ))}
        </Flex>
      }
    >
      {loading && !billing ? (
        <Loading label="Loading billing state" />
      ) : !billing ? (
        error ? (
          <ErrorState
            resource="billing state"
            description="The account's billing state couldn't be loaded."
            details={error}
            onRetry={onRetry}
            data-testid="billing-subscription-error"
          />
        ) : (
          <Empty description="No billing state" data-testid="billing-subscription-empty" />
        )
      ) : (
        <div data-testid="billing-subscription-detail">
          <Flex className="gap-2 items-center mb-3 flex-wrap">
            <Text className="font-medium">Plan</Text>
            <Badge tone="info" data-testid="billing-plan-badge">
              {billing.plan_id}
            </Badge>
            <Badge tone={statusTone(billing.subscription_status)} data-testid="billing-status-badge">
              {statusLabel(billing.subscription_status)}
            </Badge>
            {billing.premium && (
              <Badge tone="primary" data-testid="billing-premium-badge">
                Premium (unlimited)
              </Badge>
            )}
            {overrideActive && (
              <Badge tone="warning" data-testid="billing-override-badge">
                Admin override
              </Badge>
            )}
            {billingSuspended && (
              <Badge tone="error" data-testid="billing-suspended-badge">
                Billing-suspended
              </Badge>
            )}
            {adminSuspended && (
              <Badge tone="error" data-testid="billing-adminsuspended-badge">
                Admin-suspended
              </Badge>
            )}
          </Flex>
          <Descriptions
            size="sm"
            column={2}
            data-testid="billing-subscription-descriptions"
            items={[
              {
                key: 'status',
                label: 'Subscription status',
                children: statusLabel(billing.subscription_status),
              },
              {
                key: 'grace',
                label: 'Grace until',
                children: billing.grace_until
                  ? new Date(billing.grace_until).toLocaleString()
                  : '—',
              },
              {
                key: 'admin-hold',
                label: 'Admin hold',
                children: adminSuspended
                  ? `${status?.admin_suspend_reason ?? 'No reason given'} · by ${resolveName(status?.admin_suspended_by)}`
                  : 'None',
              },
              ...(overrideActive && planOverride?.plan_override_by
                ? [
                    {
                      key: 'override-by',
                      label: 'Plan override by',
                      children: `${resolveName(planOverride.plan_override_by)}${
                        planOverride.plan_override_at
                          ? ` · ${new Date(planOverride.plan_override_at).toLocaleDateString()}`
                          : ''
                      }`,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
    </Card>
  )
}
