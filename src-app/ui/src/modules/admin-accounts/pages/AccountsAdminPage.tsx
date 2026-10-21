import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, User as UserIcon, SlidersHorizontal } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  ErrorState,
  Flex,
  Separator,
  Text,
  message,
} from '@ziee/kit'
import { SettingsPageContainer, Loading } from '@ziee/shell'
import { ListPagination } from '@/components/common/ListPagination'
import { AddButton } from '@/modules/settings/components/AddButton'
import { Can } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { AdminAccounts } from '@/modules/admin-accounts/stores/AdminAccounts.store'
import { CreateOrgDrawer as CreateOrgDrawerStore } from '@/modules/admin-accounts/components/CreateOrgDrawer.store'
import { CreateOrgDrawer } from '@/modules/admin-accounts/components/CreateOrgDrawer'
import type { AdminAccountSummary } from '@/api-client/types'

/**
 * Accounts admin page (#44) — the twin of `UsersSettings.tsx`: "manage accounts
 * like users." Lists ALL accounts (the cross-account admin list
 * `Admin.listAccounts`, INV-1) with kind / member-count / owner, a
 * create-organization affordance gated `account::manage`, and a per-row "Manage"
 * button that opens the per-account detail page (#57) where members, subscription,
 * usage, and credits are managed with that account as the context.
 *
 * Mirrors the Users list idiom: `SettingsPageContainer` + a kit `Card` with an
 * `AddButton` in `extra`, `ListPagination` (page size 20, "Showing N of M"),
 * `Loading`/`Empty`/`ErrorState`, and a per-row gated action cluster. Semantic
 * tokens only.
 */
export function AccountsAdminPage() {
  const navigate = useNavigate()
  // Destructuring defaults: the `registerLazyStore` proxy can transiently yield
  // an undefined state field before the store hydrates in some runtimes (seen in
  // the gallery crawl — a bare `accounts.length` then throws). Defaulting every
  // field keeps the first paint safe and matches the store's real initial state.
  const {
    accounts = [],
    total = 0,
    currentPage = 1,
    pageSize = 20,
    loading = false,
    error = null,
    isInitialized = false,
  } = AdminAccounts

  // Cold load once.
  useEffect(() => {
    if (!isInitialized && !loading) {
      void AdminAccounts.loadAccounts()
    }
  }, [isInitialized, loading])

  // Toast a mutation failure only once the list is populated — a cold-load
  // failure is shown by the in-place ErrorState below, not a stacked toast
  // (mirrors UsersSettings' gated error toast).
  useEffect(() => {
    if (accounts.length === 0) return
    if (error) {
      message.error(error)
      AdminAccounts.clearError()
    }
  }, [error, accounts.length])

  const handlePageChange = (page: number, size?: number) => {
    const newSize = size ?? pageSize
    const newPage = size && size !== pageSize ? 1 : page
    void AdminAccounts.loadAccounts(newPage, newSize)
  }

  const openDetail = (summary: AdminAccountSummary) => {
    // Carry the summary as an owner_label/member_count hint for the detail page's
    // fast path; a deep-link resolves everything from `Admin.getAccount` anyway.
    navigate(`/settings/accounts-admin/${summary.account.id}`, { state: { summary } })
  }

  const renderRow = (summary: AdminAccountSummary, index: number) => {
    const { account, member_count, owner_label } = summary
    const isOrg = account.kind === 'organization'
    return (
      <div key={account.id} data-testid={`account-row-${account.id}`}>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <Flex className="gap-2 items-center mb-2 flex-wrap">
              {isOrg ? <Building2 /> : <UserIcon />}
              <Text className="font-medium">{account.name}</Text>
              <Badge
                tone={isOrg ? 'info' : 'neutral'}
                data-testid={`account-kind-badge-${account.id}`}
              >
                {isOrg ? 'Organization' : 'Personal'}
              </Badge>
            </Flex>
            <Descriptions
              size="sm"
              column={3}
              data-testid={`account-descriptions-${account.id}`}
              items={[
                {
                  key: 'members',
                  label: 'Members',
                  children: (
                    <span data-testid={`account-member-count-${account.id}`}>
                      {member_count}
                    </span>
                  ),
                },
                {
                  key: 'owner',
                  label: 'Owner',
                  children: (
                    <span data-testid={`account-owner-${account.id}`}>
                      {owner_label ?? 'No owner'}
                    </span>
                  ),
                },
                {
                  key: 'created',
                  label: 'Created',
                  children: new Date(account.created_at).toLocaleDateString(),
                },
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-1 items-center justify-start sm:justify-end">
            {/* Open the per-account detail page (#57) — members, subscription,
                usage, and credits, with this account as the context. */}
            <Button
              variant="ghost"
              icon={<SlidersHorizontal aria-hidden="true" />}
              onClick={() => openDetail(summary)}
              data-testid={`account-manage-button-${account.id}`}
            >
              Manage
            </Button>
          </div>
        </div>
        {index < accounts.length - 1 && <Separator className="my-4" />}
      </div>
    )
  }

  return (
    <SettingsPageContainer
      title="Accounts"
      subtitle="Manage every account in this deployment — create organizations and their members."
      data-testid="accounts-admin-page"
    >
      <Card
        title="Accounts"
        data-testid="accounts-admin-card"
        extra={
          <Can permission={Permissions.AccountManage}>
            <AddButton
              label="Create organization"
              onClick={() => CreateOrgDrawerStore.open()}
              data-testid="account-create-open-button"
            />
          </Can>
        }
      >
        {loading && accounts.length === 0 ? (
          <Loading label="Loading accounts" />
        ) : accounts.length === 0 ? (
          error ? (
            <ErrorState
              resource="accounts"
              description="The account list couldn't be loaded. Check your connection and try again."
              details={error}
              onRetry={() => AdminAccounts.loadAccounts(currentPage, pageSize)}
              data-testid="accounts-admin-error"
            />
          ) : (
            <Empty description="No accounts yet" data-testid="accounts-admin-empty" />
          )
        ) : (
          <div>
            {accounts.map(renderRow)}
            {total > 0 && (
              <ListPagination
                data-testid="accounts-admin-pagination"
                current={currentPage}
                total={total}
                pageSize={pageSize}
                onChange={handlePageChange}
                onPageSizeChange={(size: number) => handlePageChange(1, size)}
                itemNoun="accounts"
              />
            )}
          </div>
        )}
      </Card>

      {/* Drawers */}
      <CreateOrgDrawer />
    </SettingsPageContainer>
  )
}
