import {
  Badge,
  Card,
  Descriptions,
  Empty,
  ErrorState,
  Flex,
  Progress,
  Table,
  Text,
} from '@ziee/kit'
import type { TableColumn } from '@ziee/kit'
import { Loading } from '@ziee/shell'
import type { QuotaStateResponse, UsageRollupRow } from '@/api-client-saas/types'
import { ListPagination } from '@/components/common/ListPagination'
import { formatCents } from '@/modules/billing/lib/money'

export interface UsageQuotaViewProps {
  hasAccount: boolean
  loading: boolean
  error: string | null
  quota: QuotaStateResponse | null
  rows: UsageRollupRow[]
  total: number
  currentPage: number
  pageSize: number
  onRetry: () => void
  onPageChange: (page: number, size?: number) => void
}

function pct(used: number, allowance: number): number {
  if (!allowance || allowance <= 0) return used > 0 ? 100 : 0
  return Math.min(100, Math.round((used / allowance) * 100))
}

/** Null-safe number → locale string, so a partial/malformed response degrades to
 *  "0" instead of crashing the render on `undefined.toLocaleString()`. */
function num(n: number | undefined | null): string {
  return (Number.isFinite(n) ? (n as number) : 0).toLocaleString()
}

const columns: TableColumn<UsageRollupRow>[] = [
  {
    key: 'period',
    title: 'Period',
    render: r =>
      `${new Date(r.period_start).toLocaleDateString()} – ${new Date(r.period_end).toLocaleDateString()}`,
  },
  { key: 'compute_core_hours', title: 'Compute (core-h)', numeric: true, render: r => num(r.compute_core_hours) },
  { key: 'storage_gb_months', title: 'Storage (GB-mo)', numeric: true, render: r => num(r.storage_gb_months) },
  { key: 'gpu_hours', title: 'GPU (h)', numeric: true, render: r => num(r.gpu_hours) },
  { key: 'egress_gb', title: 'Egress (GB)', numeric: true, render: r => num(r.egress_gb) },
  {
    key: 'reported_at',
    title: 'Reported',
    render: r =>
      r.reported_at ? new Date(r.reported_at).toLocaleDateString() : 'pending',
  },
]

/**
 * Presentational Usage & Quota view (#46) — READ-ONLY, pure props. Shows the quota
 * allowances vs used, the spend cap (as dollars), the account's quota-state badges,
 * and the metered usage rollup as a paginated table with "Showing N of M".
 */
export function UsageQuotaView(props: UsageQuotaViewProps) {
  const { hasAccount, loading, error, quota, rows, total, currentPage, pageSize, onRetry, onPageChange } =
    props

  if (!hasAccount) {
    return (
      <Card title="Usage & Quota" data-testid="billing-usage-card">
        <Empty
          description="Select an account to view its usage & quota."
          data-testid="billing-usage-noaccount"
        />
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Quota" data-testid="billing-quota-card">
        {loading && !quota ? (
          <Loading label="Loading quota" />
        ) : !quota ? (
          error ? (
            <ErrorState
              resource="quota"
              description="The account's quota couldn't be loaded."
              details={error}
              onRetry={onRetry}
              data-testid="billing-quota-error"
            />
          ) : (
            <Empty description="No quota state" data-testid="billing-quota-empty" />
          )
        ) : (
          <div data-testid="billing-quota-detail">
            <Flex className="gap-2 items-center mb-3 flex-wrap">
              <Badge tone="info" data-testid="billing-quota-plan">{quota.plan_id}</Badge>
              {quota.hard_cap && <Badge tone="warning" data-testid="billing-quota-hardcap">Hard cap</Badge>}
              {quota.overage && <Badge tone="info" data-testid="billing-quota-overage">Metered overage</Badge>}
              {quota.suspended && <Badge tone="error" data-testid="billing-quota-suspended">Suspended</Badge>}
            </Flex>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
              <div data-testid="billing-quota-compute">
                <Text className="!text-sm" type="secondary">
                  Compute — {num(quota.compute_used)} / {num(quota.compute_allowance)} core-hours
                </Text>
                <Progress
                  value={pct(quota.compute_used, quota.compute_allowance)}
                  aria-label="Compute usage"
                  data-testid="billing-quota-compute-bar"
                />
              </div>
              <div data-testid="billing-quota-storage">
                <Text className="!text-sm" type="secondary">
                  Storage — {num(quota.storage_used)} / {num(quota.storage_allowance)} GB-months
                </Text>
                <Progress
                  value={pct(quota.storage_used, quota.storage_allowance)}
                  aria-label="Storage usage"
                  data-testid="billing-quota-storage-bar"
                />
              </div>
            </div>
            <Descriptions
              size="sm"
              column={2}
              data-testid="billing-quota-descriptions"
              items={[
                {
                  key: 'cap',
                  label: 'Spend cap',
                  children:
                    quota.spend_cap_cents != null ? formatCents(quota.spend_cap_cents) : 'No cap',
                },
                {
                  key: 'alerts',
                  label: 'Alert level (compute / storage)',
                  children: `${quota.alert_level_compute}% / ${quota.alert_level_storage}%`,
                },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Metered usage" data-testid="billing-usage-rollup-card">
        {loading && rows.length === 0 ? (
          <Loading label="Loading usage" />
        ) : rows.length === 0 ? (
          error ? (
            <ErrorState
              resource="usage"
              description="The account's usage couldn't be loaded."
              details={error}
              onRetry={onRetry}
              data-testid="billing-usage-error"
            />
          ) : (
            <Empty description="No metered usage recorded yet" data-testid="billing-usage-empty" />
          )
        ) : (
          <div className="overflow-x-auto">
            <Table<UsageRollupRow>
              columns={columns}
              dataSource={rows}
              rowKey="id"
              data-testid="billing-usage-table"
            />
            {total > 0 && (
              <ListPagination
                data-testid="billing-usage-pagination"
                current={currentPage}
                total={total}
                pageSize={pageSize}
                onChange={onPageChange}
                onPageSizeChange={(size: number) => onPageChange(1, size)}
                itemNoun="periods"
              />
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
