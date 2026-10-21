import { Trash2, Pencil, Lock, Users, User as UserIcon, Coins, Star } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Switch,
  Descriptions,
  Empty,
  Flex,
  message,
  Separator,
  Text,
  Confirm,
  ErrorState,
} from '@ziee/kit'
import { ListPagination } from '@/components/common/ListPagination'
import { Loading } from '@ziee/shell'
import { useEffect, useState } from 'react'
import { Auth } from '@/modules/auth/Auth.store'
import { Users as UsersStore } from '@/modules/user/stores/Users.store'
import { UserGroups } from '@/modules/user/stores/UserGroups.store'
import { EditUserDrawer as EditUserDrawerStore } from '@/modules/user/components/user/EditUserDrawer.store'
import { ResetPasswordDrawer as ResetPasswordDrawerStore } from '@/modules/user/components/user/ResetPasswordDrawer.store'
import { UserGroupsDrawer as UserGroupsDrawerStore } from '@/modules/user/components/user/UserGroupsDrawer.store'
import { CreateUserDrawer as CreateUserDrawerStore } from '@/modules/user/components/user/CreateUserDrawer.store'
import { AddButton } from '@/modules/settings/components/AddButton'
import { Can, usePermission, useHasPermission } from '@/core/permissions'
import { type AdminUserListItem } from '@/api-client/types'
import { type AdminUserListItem as SaasAdminUserListItem } from '@/api-client-saas/types'
import { Permissions } from '@/api-client/permissions'
import { runAction } from '@/core/actions/defineAction'
import { formatCents } from '@/modules/billing/lib/money'
import { GrantUserCreditDrawer as GrantUserCreditDrawerStore } from '@/modules/user/components/user/GrantUserCreditDrawer.store'
import { GrantUserCreditDrawer } from '@/modules/user/components/user/GrantUserCreditDrawer.tsx'
import { SettingsPageContainer } from '@ziee/shell'
// UserRegistrationSettings — temporarily un-imported; see comment in JSX.
// import { UserRegistrationSettings } from '@/modules/user/components/user/UserRegistrationSettings.tsx'
import { CreateUserDrawer } from '@/modules/user/components/user/CreateUserDrawer.tsx'
import { EditUserDrawer } from '@/modules/user/components/user/EditUserDrawer.tsx'
import { ResetPasswordDrawer } from '@/modules/user/components/user/ResetPasswordDrawer.tsx'
import { UserGroupsDrawer } from '@/modules/user/components/user/UserGroupsDrawer.tsx'
import { AssignGroupDrawer } from '@/modules/user/components/user/AssignGroupDrawer.tsx'

export function UsersSettings() {
  // Stores
  const {
    users,
    total: totalUsers,
    currentPage: storePage,
    pageSize: storePageSize,
    loading: loadingUsers,
    error: usersError,
  } = UsersStore
  const { error: groupsError } = UserGroups
  const { user: currentUser } = Auth
  // Which user's activate/deactivate confirmation is open (shared by the status
  // Switch + the Activate/Deactivate Button — both open the same Confirm).
  const [activeConfirmUserId, setActiveConfirmUserId] = useState<string | null>(
    null,
  )

  const canEdit = usePermission(Permissions.UsersEdit)
  const canResetPassword = usePermission(Permissions.UsersResetPassword)
  const canAssignGroups = usePermission(Permissions.GroupsAssignUsers)
  const canDelete = usePermission(Permissions.UsersDelete)
  const canToggleStatus = usePermission(Permissions.UsersToggleStatus)
  // The tier/premium column is SAAS-GATED on permission PRESENCE (INV-1): in a
  // default/OSS build `billing::admin` is absent from the generated enum, so this is
  // false even for a root admin and the whole column self-hides — the base Users page
  // (`users::read`) still works. Called ONCE here (never in the row loop), so it obeys
  // the Rules of Hooks.
  const canBilling = useHasPermission('billing::admin')
  // Which user's premium-comp confirmation is open (Switch + Confirm share it).
  const [premiumConfirmUserId, setPremiumConfirmUserId] = useState<string | null>(null)

  // Toast only user-action failures. A failed users LOAD renders as a
  // persistent ErrorState below (not toast-only), so only toast an error that
  // occurred against already-loaded data (a mutation). Both `usersError` and
  // `groupsError` can ALSO originate from the page's initial GET (the groups
  // list loads for the assign-group flow); in a full outage that load-failure
  // toast would stack on top of the users ErrorState. Gate BOTH on
  // `users.length > 0` so a cold load failure is shown ONLY by the in-place
  // ErrorState, and a drawer-mutation failure (page already populated) still
  // toasts.
  useEffect(() => {
    if (users.length === 0) return
    if (usersError) {
      message.error(usersError)
      UsersStore.clearError()
    }
    if (groupsError) {
      message.error(groupsError)
      UserGroups.clearError()
    }
  }, [usersError, groupsError, users.length])

  const handleToggleActive = async (userId: string) => {
    try {
      // Dispatch the permissioned `user.toggleActive` action (a thin wrapper over the SAME
      // store method) so this mutation is equally AI-drivable, not a human-only onClick (INV-1).
      await runAction('user.toggleActive', { id: userId })
      message.success('User status updated successfully')
    } catch (error) {
      console.error('Failed to update user status:', error)
      // Error is handled by the store
    }
  }

  const handleDelete = async (userId: string) => {
    try {
      await runAction('user.delete', { id: userId })
      message.success('User deleted successfully')
    } catch (error) {
      console.error('Failed to delete user:', error)
      // Error is handled by the store
    }
  }

  // `display_name ?? username`, NEVER a bare UUID (INV-3 / #51).
  const identityLabel = (user: AdminUserListItem) => user.display_name ?? user.username

  // Read the saas-only `billing` sub-object off the row. The DEFAULT list type omits
  // it (a field-level saas-only cfg-gate); on a saas build the server includes it,
  // so read it via a narrow cast to the saas row type. `null` when the caller lacks
  // billing::admin, the user has no personal account, or no resolvable state.
  const readBilling = (user: AdminUserListItem) =>
    (user as SaasAdminUserListItem).billing ?? null

  const handleTogglePremium = async (accountId: string, next: boolean) => {
    try {
      // Guard on the action result like the grant drawer does: a silent no-op
      // (e.g. the store's billing::admin snapshot-guard declining) must NOT toast a
      // false success or imply a refetch happened.
      const res = await runAction('user.grantPremiumComp', {
        account_id: accountId,
        premium: next,
      })
      if (!res) return
      message.success(next ? 'Premium comp enabled' : 'Premium comp cleared')
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to update premium')
    }
  }

  // The SAAS-GATED tier/premium column for one row. Renders a neutral "—" when the
  // user has no personal account or no resolvable billing state (DEC-4) — never a
  // fabricated "$0.00 / free". Premium is toggled via a Switch→Confirm that dispatches
  // the `user.grantPremiumComp` action seam (INV-2), and comp credit opens the typed
  // grant drawer (INV-4). Not a hook — safe inside `.map()` (reads props + local state
  // only; the reactive `useHasPermission` is read once above).
  const renderTier = (user: AdminUserListItem) => {
    const accountId = user.personal_account_id
    const billing = readBilling(user)
    if (!accountId || !billing) {
      return (
        <Text className="text-muted-foreground" data-testid={`user-tier-none-${user.id}`}>
          —
        </Text>
      )
    }
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid={`user-tier-${user.id}`}>
        <Flex className="gap-2 items-center">
          <Badge
            tone={billing.premium ? 'success' : 'neutral'}
            data-testid={`user-tier-premium-badge-${user.id}`}
          >
            {billing.premium ? 'Premium' : 'Standard'}
          </Badge>
          {canBilling && (
            <div className="inline-flex items-center">
              <Switch
                data-standalone-control
                tooltip={billing.premium ? 'Clear premium comp' : 'Comp to premium (unlimited)'}
                className={'mr-2!'}
                checked={billing.premium}
                onChange={() => setPremiumConfirmUserId(user.id)}
                data-testid={`user-tier-premium-switch-${user.id}`}
              />
              <Confirm
                open={premiumConfirmUserId === user.id}
                onOpenChange={open => setPremiumConfirmUserId(open ? user.id : null)}
                title={`${billing.premium ? 'Clear the premium comp for' : 'Comp'} ${identityLabel(user)}${billing.premium ? '?' : ' to unlimited (premium)?'}`}
                onConfirm={() => handleTogglePremium(accountId, !billing.premium)}
                okText="OK"
                cancelText="Cancel"
                data-testid={`user-tier-premium-confirm-${user.id}`}
              />
            </div>
          )}
        </Flex>
        <Text className="text-sm" data-testid={`user-tier-plan-${user.id}`}>
          <span className="text-muted-foreground">Plan: </span>
          {billing.plan_id}
        </Text>
        <Text className="text-sm" data-testid={`user-tier-balance-${user.id}`}>
          <span className="text-muted-foreground">Credit: </span>
          {formatCents(billing.credit_balance_cents)}
        </Text>
        {canBilling && (
          <Button
            variant="ghost"
            size="default"
            icon={<Coins />}
            onClick={() => GrantUserCreditDrawerStore.open(accountId, identityLabel(user))}
            data-testid={`user-tier-grant-credit-button-${user.id}`}
          >
            Grant credit
          </Button>
        )}
      </div>
    )
  }

  const getUserActions = (user: AdminUserListItem) => {
    const actions: React.ReactNode[] = []

    // Self / root-admin lockout guards: hide destructive controls on
    // the viewer's own row and on the root admin row regardless of
    // permission (the backend enforces these too, but the UI should
    // never offer a button that will reliably 400/403).
    const isSelf = currentUser?.id === user.id
    const isRootAdmin = user.is_admin

    // Active/inactive switch
    if (canToggleStatus && !isSelf && !isRootAdmin) {
      actions.push(
        <div key="active-confirm" className="inline-flex items-center">
          <Switch
            data-standalone-control
            tooltip={user.is_active ? 'Deactivate user' : 'Activate user'}
            className={'mr-2!'}
            checked={user.is_active}
            onChange={() => setActiveConfirmUserId(user.id)}
            data-testid={`user-active-switch-${user.id}`}
          />
          <Confirm
            open={activeConfirmUserId === user.id}
            onOpenChange={open =>
              setActiveConfirmUserId(open ? user.id : null)
            }
            title={`${user.is_active ? 'Deactivate' : 'Activate'} this user?`}
            onConfirm={() => handleToggleActive(user.id)}
            okText="OK"
            cancelText="Cancel"
            data-testid={`user-toggle-active-confirm-${user.id}`}
          >
            <Button variant="ghost" size="default" data-testid={`user-toggle-active-button-${user.id}`}>
              {user.is_active ? 'Deactivate' : 'Activate'}
            </Button>
          </Confirm>
        </div>,
      )
    }

    if (canEdit) {
      actions.push(
        <Button
          key="edit"
          variant="ghost"
          icon={<Pencil />}
          onClick={() => EditUserDrawerStore.openEditUserDrawer(user)}
          data-testid={`user-edit-button-${user.id}`}
        >
          Edit
        </Button>,
      )
    }

    if (canResetPassword) {
      actions.push(
        <Button
          key="password"
          variant="ghost"
          icon={<Lock />}
          onClick={() =>
            ResetPasswordDrawerStore.openResetPasswordDrawer(user)
          }
          data-testid={`user-reset-password-button-${user.id}`}
        >
          Reset Password
        </Button>,
      )
    }

    if (canAssignGroups) {
      actions.push(
        <Button
          key="groups"
          variant="ghost"
          icon={<Users />}
          onClick={() => UserGroupsDrawerStore.openUserGroupsDrawer(user)}
          data-testid={`user-groups-button-${user.id}`}
        >
          Groups
        </Button>,
      )
    }

    if (canDelete && !isSelf && !isRootAdmin) {
      actions.push(
        <div key="delete" className="inline-flex items-center">
          <Confirm
            title="Are you sure you want to delete this user?"
            onConfirm={() => handleDelete(user.id)}
            okText="OK"
            cancelText="Cancel"
            data-testid={`user-delete-confirm-${user.id}`}
          >
            <Button
              variant="ghost"
              icon={<Trash2 aria-hidden="true" />}
              aria-label={`Delete ${user.username}`}
              data-testid={`user-delete-button-${user.id}`}
            >
              Delete
            </Button>
          </Confirm>
        </div>,
      )
    }

    return actions.filter(Boolean)
  }

  const handlePageChange = (page: number, size?: number) => {
    const newPageSize = size || storePageSize
    const newPage = size && size !== storePageSize ? 1 : page // Reset to page 1 if page size changes

    UsersStore.loadUsers(newPage, newPageSize)
  }

  return (
    <SettingsPageContainer title="Users">
      <div>
        <Flex vertical className="gap-3">
          {/* User Registration Settings — hidden until the backend
            * endpoint exists. The store (Users.loadUserRegistrationSettings
            * / updateUserRegistrationSettings) is a TODO stub that hard-
            * codes `true` and never calls the server; rendering the
            * toggle here was a UI lie (audit 03 B-4). Re-enable when
            * `GET/POST /api/users/registration-settings` ships
            * server-side. */}
          {/* <UserRegistrationSettings /> */}

          <Card
            title="Users"
            data-testid="user-list-card"
            extra={
              <Can permission={Permissions.UsersCreate}>
                <AddButton
                  label="Create user"
                  onClick={() => CreateUserDrawerStore.openCreateUserDrawer()}
                  data-testid="user-create-open-button"
                />
              </Can>
            }
          >
            {loadingUsers ? (
              <Loading label="Loading users" />
            ) : users.length === 0 ? (
              usersError ? (
                <ErrorState
                  resource="users"
                  description="The user list couldn't be loaded. Check your connection and try again."
                  details={usersError}
                  onRetry={() => UsersStore.loadUsers(storePage, storePageSize)}
                  data-testid="user-list-error"
                />
              ) : (
                <div>
                  <Empty description="No users yet" data-testid="user-list-empty" />
                </div>
              )
            ) : (
              <div>
                {users.map((user, index) => (
                  <div key={user.id} data-testid={`user-row-${user.username}`}>
                    <div className="flex items-start gap-3 flex-wrap">
                      {/* User Info */}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <div className={'flex-1 min-w-48'}>
                            <Flex className="gap-2 items-center">
                              <UserIcon />
                              <Text className="font-medium">
                                {identityLabel(user)}
                              </Text>
                              <Badge tone={user.is_active ? 'success' : 'error'} data-testid={`user-status-badge-${user.id}`}>{user.is_active ? 'Active' : 'Inactive'}</Badge>
                            </Flex>
                          </div>
                          {/* Left-align the wrapped action list on mobile
                              so a lone wrapped action (e.g. "Groups") isn't
                              orphaned right; right-align inline from sm up. */}
                          <div
                            className={'flex flex-wrap gap-1 items-center justify-start sm:justify-end'}
                          >
                            {getUserActions(user)}
                          </div>
                        </div>

                        <Descriptions
                          size="sm"
                          column={3}
                          data-testid={`user-descriptions-${user.id}`}
                          items={[
                            { key: 'email', label: 'Email', children: user.email },
                            { key: 'last_login', label: 'Last Login', children: user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : 'Never' },
                            { key: 'created', label: 'Created', children: new Date(user.created_at).toLocaleDateString() },
                          ]}
                        />

                        {/* Tier / premium column — SAAS-GATED on permission presence
                            (INV-1). Absent (and the whole block unrendered) in a build
                            without billing::admin; the base Users page still works. */}
                        {canBilling && (
                          <div
                            className="mt-2 pt-2 border-t border-border/60"
                            data-testid={`user-tier-row-${user.id}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <Star className="size-3.5 text-muted-foreground" aria-hidden="true" />
                              <Text className="text-xs text-muted-foreground uppercase tracking-wide">
                                Tier &amp; billing
                              </Text>
                            </div>
                            {renderTier(user)}
                          </div>
                        )}
                      </div>
                    </div>
                    {index < users.length - 1 && <Separator className="my-4" />}
                  </div>
                ))}
              </div>
            )}

            {users.length > 0 && (
              <>
                <ListPagination
          data-testid="user-list-pagination"
          current={storePage}
          total={totalUsers}
          pageSize={storePageSize}
          onChange={handlePageChange}
          onPageSizeChange={(size: number) => handlePageChange(1, size)}
          itemNoun="users"
          aria-label="Pagination"
        />
              </>
            )}
          </Card>
        </Flex>

        {/* Drawer Components */}
        <CreateUserDrawer />
        <EditUserDrawer />
        <ResetPasswordDrawer />
        <UserGroupsDrawer />
        <AssignGroupDrawer />
        {/* Per-user grant-credit drawer — mounted only when the tier column is
            present (saas + billing::admin), mirroring the column's own gate. */}
        {canBilling && <GrantUserCreditDrawer />}
      </div>
    </SettingsPageContainer>
  )
}
