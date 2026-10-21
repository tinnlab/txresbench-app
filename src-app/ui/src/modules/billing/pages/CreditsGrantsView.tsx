import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Confirm,
  Descriptions,
  Empty,
  ErrorState,
  Flex,
  Table,
  Text,
} from '@ziee/kit'
import type { BadgeTone, TableColumn } from '@ziee/kit'
import { Loading } from '@ziee/shell'
import type { CreditBalanceResponse, CreditGrantResponse } from '@/api-client-saas/types'
import { ListPagination } from '@/components/common/ListPagination'
import { formatCents } from '@/modules/billing/lib/money'

export interface CreditsGrantsViewProps {
  hasAccount: boolean
  loading: boolean
  error: string | null
  credits: CreditBalanceResponse | null
  /** Whether premium is comped. Read from the billing GET on load (#39 read projection),
   *  so `premiumKnown` is true after a cold load — `premium` is UNKNOWN only before the
   *  first load. */
  premium: boolean
  premiumKnown: boolean
  canManage: boolean
  resolveName: (id?: string | null) => string
  onRetry: () => void
  onOpenGrant: () => void
  onRevoke: (grantId: string) => void
  onSetPremium: (next: boolean) => void
}

type GrantStatus = { label: string; tone: BadgeTone }

function grantStatus(g: CreditGrantResponse): GrantStatus {
  if (g.revoked_at) return { label: 'Revoked', tone: 'error' }
  if (!g.active) return { label: 'Expired', tone: 'neutral' }
  return { label: 'Active', tone: 'success' }
}

const PAGE_SIZE = 10

/**
 * Presentational Credits & Grants view (#47) — pure props. Shows the balance (as
 * dollars), the premium-override toggle, and the FULL auditable ledger INCLUDING
 * revoked/expired grants (INV-4), each with a resolved grantor name (never a UUID),
 * reason, timestamps, and a status badge. The ledger paginates with "Showing N of M".
 */
export function CreditsGrantsView(props: CreditsGrantsViewProps) {
  const {
    hasAccount,
    loading,
    error,
    credits,
    premium,
    premiumKnown,
    canManage,
    resolveName,
    onRetry,
    onOpenGrant,
    onRevoke,
    onSetPremium,
  } = props
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  if (!hasAccount) {
    return (
      <Card title="Credits & Grants" data-testid="billing-credits-card">
        <Empty
          description="Select an account to view its credits & grants."
          data-testid="billing-credits-noaccount"
        />
      </Card>
    )
  }

  const grants = credits?.grants ?? []
  const start = (page - 1) * pageSize
  const pageGrants = grants.slice(start, start + pageSize)

  const columns: TableColumn<CreditGrantResponse>[] = [
    { key: 'amount', title: 'Amount', numeric: true, render: g => formatCents(g.amount_cents) },
    { key: 'reason', title: 'Reason', render: g => g.reason },
    { key: 'granted_by', title: 'Granted by', render: g => resolveName(g.granted_by) },
    {
      key: 'created_at',
      title: 'Granted',
      render: g => new Date(g.created_at).toLocaleDateString(),
    },
    {
      key: 'expires_at',
      title: 'Expires',
      render: g => (g.expires_at ? new Date(g.expires_at).toLocaleDateString() : 'Never'),
    },
    {
      key: 'status',
      title: 'Status',
      render: g => {
        const s = grantStatus(g)
        return (
          <div>
            <Badge tone={s.tone} data-testid={`billing-grant-status-${g.id}`}>
              {s.label}
            </Badge>
            {g.revoked_at && (
              // INV-4 auditability: WHO revoked it and WHEN (never a raw UUID).
              <Text
                className="!text-xs block mt-1"
                type="secondary"
                data-testid={`billing-grant-revoked-by-${g.id}`}
              >
                by {resolveName(g.revoked_by)} · {new Date(g.revoked_at).toLocaleDateString()}
              </Text>
            )}
          </div>
        )
      },
    },
    {
      key: 'actions',
      title: '',
      render: g =>
        canManage && !g.revoked_at && g.active ? (
          <Confirm
            title="Revoke this grant?"
            description="The grant is removed from the balance but kept in the ledger, stamped revoked."
            okText="Revoke"
            cancelText="Cancel"
            danger
            onConfirm={() => onRevoke(g.id)}
            data-testid={`billing-revoke-confirm-${g.id}`}
          >
            <Button variant="ghost" data-testid={`billing-revoke-${g.id}`}>
              Revoke
            </Button>
          </Confirm>
        ) : null,
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Credits"
        data-testid="billing-credits-balance-card"
        extra={
          canManage && (
            <Button variant="outline" onClick={onOpenGrant} data-testid="billing-open-grant">
              Grant credit
            </Button>
          )
        }
      >
        {loading && !credits ? (
          <Loading label="Loading credits" />
        ) : !credits ? (
          error ? (
            <ErrorState
              resource="credits"
              description="The account's credits couldn't be loaded."
              details={error}
              onRetry={onRetry}
              data-testid="billing-credits-error"
            />
          ) : (
            <Empty description="No credit state" data-testid="billing-credits-empty" />
          )
        ) : (
          <div data-testid="billing-credits-detail">
            <Flex className="gap-2 items-center mb-3 flex-wrap">
              <Text className="font-medium">Balance</Text>
              <Badge tone="success" data-testid="billing-credits-balance">
                {formatCents(credits.balance_cents)}
              </Badge>
              {premiumKnown && premium && (
                <Badge tone="primary" data-testid="billing-premium-badge">
                  Premium (unlimited)
                </Badge>
              )}
            </Flex>
            <Descriptions
              size="sm"
              column={1}
              data-testid="billing-premium-descriptions"
              items={[
                {
                  key: 'premium',
                  label: 'Premium comp',
                  children: (
                    <div>
                      <Flex className="gap-2 items-center flex-wrap">
                        <Button
                          variant="outline"
                          disabled={!canManage}
                          onClick={() => onSetPremium(true)}
                          data-testid="billing-premium-enable"
                        >
                          Enable premium
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={!canManage}
                          onClick={() => onSetPremium(false)}
                          data-testid="billing-premium-disable"
                        >
                          Disable premium
                        </Button>
                        {premiumKnown && (
                          <Text className="!text-sm" type="secondary" data-testid="billing-premium-known">
                            {premium ? 'Comped to unlimited allowance' : 'Not comped'}
                          </Text>
                        )}
                      </Flex>
                      {/* The premium override is now read from the billing GET on load
                          (#39 read projection), so its current state is shown definitively —
                          no "not reported by the API" caveat. */}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Grant ledger" data-testid="billing-ledger-card">
        {grants.length === 0 ? (
          <Empty
            description="No grants on this account yet"
            data-testid="billing-ledger-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table<CreditGrantResponse>
              columns={columns}
              dataSource={pageGrants}
              rowKey="id"
              data-testid="billing-ledger-table"
            />
            <ListPagination
              data-testid="billing-ledger-pagination"
              current={page}
              total={grants.length}
              pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(size: number) => {
                setPageSize(size)
                setPage(1)
              }}
              itemNoun="grants"
            />
          </div>
        )}
      </Card>
    </div>
  )
}
