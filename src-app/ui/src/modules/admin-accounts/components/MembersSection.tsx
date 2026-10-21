import { useEffect, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import {
  Button,
  Card,
  Confirm,
  Empty,
  ErrorState,
  Flex,
  Select,
  Separator,
  Text,
  message,
} from '@ziee/kit'
import { Loading } from '@ziee/shell'
import { ListPagination } from '@/components/common/ListPagination'
import { AccountMembers } from '@/modules/admin-accounts/stores/AccountMembers.store'
import { Users } from '@/modules/user/stores/Users.store'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { runAction } from '@/core/actions/defineAction'
import type { Account, AccountMember, AccountRole } from '@/api-client/types'

const ROLE_OPTIONS: { label: string; value: AccountRole }[] = [
  { label: 'Member', value: 'member' },
  { label: 'Admin', value: 'admin' },
  { label: 'Owner', value: 'owner' },
]

/** The member's human-readable primary label: the chosen display name, falling
 *  back to the login username. Never the bare `user_id` UUID (#51). */
function memberName(m: AccountMember): string {
  return m.display_name ?? m.username
}

/**
 * Friendly surface for the backend's last-owner guard (INV-3 / DEC-4): a 422
 * `error_code: 'LAST_OWNER'` is shown as a plain-language toast; any other
 * failure toasts its message. Never rethrows to the render tree.
 */
function toastMemberError(error: unknown, fallback: string) {
  const code = (error as { error_code?: string })?.error_code
  if (code === 'LAST_OWNER') {
    message.error('An account must keep at least one owner.')
    return
  }
  message.error(error instanceof Error ? error.message : fallback)
}

/**
 * Members section (#57) — the inline members widget of the account-detail page,
 * lifted from the retired `MembersDrawer` inner content: add / remove /
 * change-role, mirroring the Users list's per-row gated action cluster. Every
 * mutation drives a permissioned `defineAction` via `runAction` (never a bare
 * store call, INV-3). The sole-owner controls are disabled client-side when the
 * full member set is known (single page); the authoritative guard is the backend
 * 422 `LAST_OWNER`, always caught here so the page never crashes.
 *
 * The account comes from the route (via the parent page), NOT a drawer `isOpen`:
 * `AccountMembers.setAccount(account)` is called on mount / account change, then
 * the first page loads.
 */
export function MembersSection({ account }: { account: Account }) {
  // Destructuring defaults guard against a transient undefined state field from
  // the lazy-store proxy before hydration (see AccountsAdminPage).
  const {
    account: loadedAccount = null,
    members = [],
    total = 0,
    currentPage = 1,
    pageSize = 20,
    isInitialized = false,
    loading = false,
    error = null,
    mutating = false,
  } = AccountMembers
  const { users } = Users
  const canManage = usePermission(Permissions.AccountManage)
  const canReadUsers = usePermission(Permissions.UsersRead)

  const [addUserId, setAddUserId] = useState<string | undefined>(undefined)
  const [addRole, setAddRole] = useState<AccountRole>('member')

  // Point the members store at this account (no-op if already set). Reset the
  // add-form when the account changes.
  useEffect(() => {
    AccountMembers.setAccount(account)
    setAddUserId(undefined)
    setAddRole('member')
  }, [account])

  // Load the first members page once the store is pointed at this account.
  const pointedHere = loadedAccount?.id === account.id
  useEffect(() => {
    if (pointedHere && !isInitialized && !loading) {
      void AccountMembers.loadMembers()
    }
  }, [pointedHere, isInitialized, loading])

  // Load users once for the add-member picker.
  useEffect(() => {
    if (canReadUsers && users.length === 0) {
      void Users.loadUsers()
    }
  }, [canReadUsers, users.length])

  // The full member set is known only when the whole list is on this page.
  const fullSetKnown = total === members.length
  const ownerCount = members.filter(m => m.role === 'owner').length
  const isSoleOwner = (m: AccountMember) =>
    fullSetKnown && m.role === 'owner' && ownerCount <= 1

  const handleAdd = async () => {
    if (!addUserId) return
    try {
      // The action returns false when a concurrent mutation dropped it — don't
      // report a no-op as success.
      const ran = await runAction('admin.account.addMember', {
        user_id: addUserId,
        role: addRole,
      })
      if (ran === false) return
      message.success('Member added')
      setAddUserId(undefined)
      setAddRole('member')
    } catch (error) {
      toastMemberError(error, 'Failed to add member')
    }
  }

  const handleSetRole = async (userId: string, role: AccountRole) => {
    try {
      const ran = await runAction('admin.account.setMemberRole', {
        user_id: userId,
        role,
      })
      if (ran === false) return
      message.success('Role updated')
    } catch (error) {
      toastMemberError(error, 'Failed to change role')
    }
  }

  const handleRemove = async (userId: string) => {
    try {
      const ran = await runAction('admin.account.removeMember', {
        user_id: userId,
      })
      if (ran === false) return
      message.success('Member removed')
    } catch (error) {
      toastMemberError(error, 'Failed to remove member')
    }
  }

  // Members already in the account shouldn't appear as add candidates.
  const memberIds = new Set(members.map(m => m.user_id))
  const addOptions = users
    .filter(u => !memberIds.has(u.id))
    .map(u => ({ label: u.display_name ?? u.username, value: u.id }))

  const handlePageChange = (page: number, size?: number) => {
    const newSize = size ?? pageSize
    const newPage = size && size !== pageSize ? 1 : page
    void AccountMembers.loadMembers(newPage, newSize)
  }

  return (
    <Card title="Members" data-testid="account-detail-members-card">
      <div className="flex flex-col gap-4">
        <Flex className="gap-2 items-center">
          <Text type="secondary" className="!text-sm">
            Manage who belongs to this account and their role.
          </Text>
        </Flex>

        {/* Add-member row (gated account::manage) */}
        {canManage && (
          <div
            className="flex flex-wrap items-end gap-2"
            data-testid="account-members-add-row"
          >
            {canReadUsers ? (
              <div className="flex-1 min-w-48">
                <Text className="!text-sm mb-1 block">Add a member</Text>
                <Select
                  options={addOptions}
                  value={addUserId ?? ''}
                  onChange={(v: string) => setAddUserId(v || undefined)}
                  placeholder="Select a user"
                  showSearch
                  data-testid="account-members-add-user-select"
                  aria-label="User to add"
                />
              </div>
            ) : (
              <Text type="secondary" className="!text-sm flex-1">
                Adding a member by name requires the “users::read” permission.
              </Text>
            )}
            <Select
              options={ROLE_OPTIONS}
              value={addRole}
              onChange={(v: string) => setAddRole(v as AccountRole)}
              data-testid="account-members-add-role-select"
              aria-label="Role for the new member"
            />
            <Button
              icon={<UserPlus aria-hidden="true" />}
              onClick={handleAdd}
              loading={mutating}
              unavailableReason={!addUserId ? 'Select a user to add' : undefined}
              data-testid="account-members-add-button"
            >
              Add
            </Button>
          </div>
        )}

        <Separator />

        {loading && members.length === 0 ? (
          <Loading label="Loading members" />
        ) : members.length === 0 ? (
          error ? (
            <ErrorState
              resource="members"
              description="The member list couldn't be loaded."
              details={error}
              onRetry={() => AccountMembers.loadMembers()}
              data-testid="account-members-error"
            />
          ) : (
            <Empty description="No members yet" data-testid="account-members-empty" />
          )
        ) : (
          <div data-testid="account-members-list">
            {members.map((m, index) => {
              const sole = isSoleOwner(m)
              // Under the sole-owner guard, forbid dropping below owner.
              const roleOptions = sole
                ? ROLE_OPTIONS.filter(o => o.value === 'owner')
                : ROLE_OPTIONS
              return (
                <div key={m.user_id} data-testid={`account-member-row-${m.user_id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex-1 min-w-48">
                      <Text
                        className="font-medium !text-sm block truncate"
                        data-testid={`account-member-name-${m.user_id}`}
                      >
                        {memberName(m)}
                      </Text>
                      <Text
                        type="secondary"
                        className="!text-xs block truncate"
                        data-testid={`account-member-email-${m.user_id}`}
                      >
                        {m.email}
                      </Text>
                    </div>
                    <div className="flex items-center gap-1 justify-start sm:justify-end">
                      <Select
                        options={roleOptions}
                        value={m.role}
                        onChange={(v: string) => handleSetRole(m.user_id, v as AccountRole)}
                        disabled={!canManage}
                        data-testid={`account-member-role-select-${m.user_id}`}
                        aria-label={`Role for ${memberName(m)}`}
                      />
                      {canManage && (
                        <Confirm
                          title="Remove this member?"
                          onConfirm={() => handleRemove(m.user_id)}
                          okText="Remove"
                          cancelText="Cancel"
                          data-testid={`account-member-remove-confirm-${m.user_id}`}
                        >
                          <Button
                            variant="ghost"
                            icon={<Trash2 aria-hidden="true" />}
                            aria-label={`Remove ${memberName(m)}`}
                            unavailableReason={
                              sole ? 'An account must keep at least one owner' : undefined
                            }
                            data-testid={`account-member-remove-button-${m.user_id}`}
                          >
                            Remove
                          </Button>
                        </Confirm>
                      )}
                    </div>
                  </div>
                  {index < members.length - 1 && <Separator className="my-3" />}
                </div>
              )
            })}

            {total > 0 && (
              <ListPagination
                data-testid="account-members-pagination"
                current={currentPage}
                total={total}
                pageSize={pageSize}
                onChange={handlePageChange}
                onPageSizeChange={(size: number) => handlePageChange(1, size)}
                itemNoun="members"
              />
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
