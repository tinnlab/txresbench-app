import { useEffect, useState } from 'react'
import { Alert, Badge, Card, Skeleton, Text } from '@ziee/kit'
import { SettingsPageContainer } from '@ziee/shell'
import { ApiClient } from '@/api-client'
import type { Account as AccountModel, AccountMember } from '@/api-client/types'
import { ListPagination } from '@/components/common/ListPagination'
import { Account } from '@/modules/account/stores/Account.store'

const PAGE_SIZE = 10

function kindBadge(account: AccountModel) {
  return account.kind === 'personal' ? (
    <Badge tone="neutral" data-testid="account-kind-personal">
      Personal
    </Badge>
  ) : (
    <Badge tone="neutral" data-testid="account-kind-organization">
      Organization
    </Badge>
  )
}

/** Read-only members list for ONE org account (Phase 2 — no invite/role UI). Paged
 *  via the numbered `ListPagination` (settings-list idiom) with a "Showing N of M"
 *  summary, so a large org never fetch-all's. Owner-filtered by the backend (a
 *  non-member's request 404s — never reached here since the list is the user's own
 *  memberships). */
function AccountMembersList({ accountId }: { accountId: string }) {
  const [page, setPage] = useState(1)
  const [members, setMembers] = useState<AccountMember[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ApiClient.Account.listMembers({ id: accountId, page, per_page: PAGE_SIZE })
      .then(res => {
        if (cancelled) return
        setMembers(res.members)
        setTotal(res.total)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load members')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, page])

  if (loading && members.length === 0) {
    return <Skeleton className="h-16 w-full" data-testid="account-members-loading" />
  }
  if (error) {
    return (
      <Alert tone="error" title="Couldn’t load members" data-testid="account-members-error">
        {error}
      </Alert>
    )
  }

  return (
    <div data-testid={`account-members-${accountId}`}>
      <ul className="flex flex-col gap-2">
        {members.map(m => (
          <li
            key={m.user_id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            data-testid={`account-member-${m.user_id}`}
          >
            <div className="min-w-0">
              <Text
                className="!text-sm block truncate"
                data-testid={`account-member-name-${m.user_id}`}
              >
                {m.display_name ?? m.username}
              </Text>
              <Text
                type="secondary"
                className="!text-xs block truncate"
                data-testid={`account-member-email-${m.user_id}`}
              >
                {m.email}
              </Text>
            </div>
            <Badge tone="neutral" data-testid={`account-member-role-${m.user_id}`}>
              {`${m.role}`}
            </Badge>
          </li>
        ))}
      </ul>
      {total > 0 && (
        <Text className="!text-xs text-muted-foreground pt-2 block" data-testid="account-members-count">
          Showing {members.length} of {total}
        </Text>
      )}
      {total > PAGE_SIZE && (
        <ListPagination
          data-testid="account-members-pagination"
          aria-label="Members pagination"
          current={page}
          total={total}
          pageSize={PAGE_SIZE}
          onChange={setPage}
          onPageSizeChange={() => setPage(1)}
          itemNoun="members"
        />
      )}
    </div>
  )
}

/**
 * `/settings/accounts` (A4 ITEM-8) — one `Card` per account (the Sessions
 * settings-card idiom): the account name, a kind badge, an "active" marker, and —
 * for an org — a read-only members list. The solo user sees ONE card ("Personal")
 * with no switch affordance and no members list ("account" never gets in their way).
 * Route + slot gated on `account::read`.
 */
export function AccountSettingsPage() {
  // Reactive reads (proxy getters subscribe).
  const { accounts, activeAccountId, loading, error } = Account

  return (
    <SettingsPageContainer title="My accounts">
      {loading && accounts.length === 0 ? (
        <Skeleton className="h-24 w-full" data-testid="account-settings-loading" />
      ) : error && accounts.length === 0 ? (
        <Alert tone="error" title="Couldn’t load accounts" data-testid="account-settings-error">
          {error}
        </Alert>
      ) : (
        <div className="flex flex-col gap-4" data-testid="account-settings-list">
          {accounts.map(account => (
            <Card
              key={account.id}
              data-testid={`account-card-${account.id}`}
              title={account.kind === 'personal' ? 'Personal' : account.name}
              extra={
                account.id === activeAccountId ? (
                  <Badge tone="primary" data-testid="account-active-marker">
                    Active
                  </Badge>
                ) : undefined
              }
            >
              <div className="flex items-center gap-2 pb-2">{kindBadge(account)}</div>
              {account.kind === 'organization' && (
                <AccountMembersList accountId={account.id} />
              )}
            </Card>
          ))}
        </div>
      )}
    </SettingsPageContainer>
  )
}
