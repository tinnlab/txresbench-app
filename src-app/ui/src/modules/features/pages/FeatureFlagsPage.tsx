import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Confirm,
  Empty,
  ErrorState,
  Select,
  Spin,
  Switch,
  Text,
  message,
} from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { runAction } from '@/core/actions/defineAction'
import { FeatureFlags } from '@/modules/features/FeatureFlags.store'
import {
  FeatureFlagAccounts,
  featureFlagAccountLabel,
} from '@/modules/features/stores/FeatureFlagAccounts.store'
import { ListPagination } from '@/components/common/ListPagination'
import type { AdminAccountSummary, FeatureFlagView } from '@/api-client/types'
import { SettingsPageContainer } from '@ziee/shell'

/**
 * Admin "Feature Flags" settings page — the runtime feature-flags subsystem
 * (#40 read-only listing, #48 the GLOBAL enable/disable toggle).
 *
 * Lists every known runtime flag with its compiled default, its provenance
 * (compiled default vs an explicit global override), and its RESOLVED effective
 * state. Each row's Switch flips the flag's GLOBAL default on/off deployment-wide
 * — a `dangerous` action dispatched through `runAction('features.setGlobalFlag')`
 * (so it is equally AI-drivable, INV-1) behind a Confirm (deployment-wide changes
 * are deliberate, INV-3). Gated by `features::manage` at the slot + route + control
 * (INV-2); unpermitted users never see it. Per-account overrides are a follow-on
 * (DEC-1). Mirrors `UsersSettings.tsx` (Switch+Confirm) + `AccountsAdminPage.tsx`
 * (container/card/states/pagination).
 */
/**
 * The PER-ACCOUNT overrides section (#53) — the missing half of #48. An admin picks an
 * account, sees every flag resolved FOR that account (inherited vs overridden clearly
 * distinct), can override a flag for just that account, and can **Clear override** to
 * revert it to inheriting the global/compiled default. Every mutation is dispatched
 * through `runAction('features.setAccountFlag' | 'features.clearAccountOverride')` — the
 * SAME actions the AI agent drives (INV-5), never an inline store call. This is the twin
 * of the global list above (same row layout, testid scheme, and `ListPagination`).
 */
function PerAccountSection() {
  const {
    selectedAccountId = null,
    accountFlags = [],
    accountLoading = false,
    accountError = null,
    accountPending = {},
  } = FeatureFlags
  const {
    accounts = [],
    loading: accountsLoading = false,
    isInitialized = false,
    error: accountsError = null,
  } = FeatureFlagAccounts

  // Which flag's per-account toggle / clear Confirm is open (single shared key each,
  // mirroring the global list's `confirmKey`).
  const [toggleKey, setToggleKey] = useState<string | null>(null)
  const [clearKey, setClearKey] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Cold-load the account list once for the picker (guarded so a failed load doesn't
  // re-fire — the store marks itself initialized on error).
  useEffect(() => {
    if (!isInitialized && !accountsLoading) void FeatureFlagAccounts.loadAccounts()
  }, [isInitialized, accountsLoading])

  const options = accounts.map((s: AdminAccountSummary) => ({
    label: featureFlagAccountLabel(s),
    value: s.account.id,
  }))
  const selectedLabel =
    accounts.find(s => s.account.id === selectedAccountId)?.account.name ?? undefined

  const onPick = (id: string | undefined) => {
    void FeatureFlags.selectAccount(id ?? null)
    setPage(1)
  }

  const handlePageChange = (nextPage: number, size?: number) => {
    if (size && size !== pageSize) {
      setPageSize(size)
      setPage(1)
    } else {
      setPage(nextPage)
    }
  }

  const handleToggle = async (flag: FeatureFlagView) => {
    if (!selectedAccountId) return
    const enabled = !flag.effective
    try {
      await runAction('features.setAccountFlag', {
        flag_key: flag.flag_key,
        account_id: selectedAccountId,
        enabled,
      })
      message.success(
        `"${flag.flag_key}" ${enabled ? 'enabled' : 'disabled'} for ${selectedLabel ?? 'account'}`,
      )
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to set per-account override')
    } finally {
      setToggleKey(null)
    }
  }

  const handleClear = async (flag: FeatureFlagView) => {
    if (!selectedAccountId) return
    try {
      await runAction('features.clearAccountOverride', {
        flag_key: flag.flag_key,
        account_id: selectedAccountId,
      })
      message.success(`Override cleared — "${flag.flag_key}" now inherits`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to clear override')
    } finally {
      setClearKey(null)
    }
  }

  const renderRow = (flag: FeatureFlagView) => {
    const isPending = !!accountPending[flag.flag_key]
    const isOverridden = flag.account_enabled != null
    // The inherited value the account falls back to when there's no override: the
    // global override if set, else the compiled default.
    const inheritedOn = flag.global_enabled != null ? flag.global_enabled : flag.default_enabled
    return (
      <li
        key={flag.flag_key}
        data-testid={`feature-flag-account-row-${flag.flag_key}`}
        className="flex items-center justify-between gap-4 py-3 flex-wrap"
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm break-all">{flag.flag_key}</div>
          <div className="text-sm text-muted-foreground">{flag.description}</div>
          <Text
            className="text-xs text-muted-foreground"
            data-testid={`feature-flag-account-state-${flag.flag_key}`}
          >
            {isOverridden
              ? `Overridden for this account (${flag.account_enabled ? 'on' : 'off'})`
              : `Inherited (${inheritedOn ? 'on' : 'off'} — ${
                  flag.global_enabled != null ? 'global default' : 'compiled default'
                })`}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          {isOverridden ? (
            <Badge
              data-testid={`feature-flag-account-badge-${flag.flag_key}`}
              tone="warning"
            >
              Overridden
            </Badge>
          ) : (
            <Badge
              data-testid={`feature-flag-account-badge-${flag.flag_key}`}
              tone="neutral"
            >
              Inherited
            </Badge>
          )}
          <Badge
            data-testid={`feature-flag-account-effective-${flag.flag_key}`}
            tone={flag.effective ? 'success' : 'neutral'}
          >
            {flag.effective ? 'On' : 'Off'}
          </Badge>
          <Switch
            data-standalone-control
            tooltip={flag.effective ? 'Disable for this account' : 'Enable for this account'}
            checked={flag.effective}
            disabled={isPending}
            onChange={() => setToggleKey(flag.flag_key)}
            data-testid={`feature-flag-account-switch-${flag.flag_key}`}
          />
          <Confirm
            open={toggleKey === flag.flag_key}
            onOpenChange={open => setToggleKey(open ? flag.flag_key : null)}
            title={`${flag.effective ? 'Disable' : 'Enable'} "${flag.flag_key}" for ${selectedLabel ?? 'this account'}?`}
            description="This sets a per-account override; it does not change the global default or other accounts."
            onConfirm={() => handleToggle(flag)}
            okText={flag.effective ? 'Disable' : 'Enable'}
            cancelText="Cancel"
            data-testid={`feature-flag-account-toggle-confirm-${flag.flag_key}`}
          />
          <Button
            variant="outline"
            disabled={!isOverridden || isPending}
            onClick={() => setClearKey(flag.flag_key)}
            data-testid={`feature-flag-clear-${flag.flag_key}`}
          >
            Clear override
          </Button>
          <Confirm
            open={clearKey === flag.flag_key}
            onOpenChange={open => setClearKey(open ? flag.flag_key : null)}
            title={`Clear the override for "${flag.flag_key}"?`}
            description={`${selectedLabel ?? 'This account'} will revert to inheriting the ${
              flag.global_enabled != null ? 'global default' : 'compiled default'
            } (${inheritedOn ? 'on' : 'off'}).`}
            onConfirm={() => handleClear(flag)}
            okText="Clear override"
            cancelText="Cancel"
            data-testid={`feature-flag-clear-confirm-${flag.flag_key}`}
          />
        </div>
      </li>
    )
  }

  const total = accountFlags.length
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, lastPage)
  const start = (safePage - 1) * pageSize
  const pageFlags = accountFlags.slice(start, start + pageSize)

  return (
    <Card
      data-testid="feature-flags-account-card"
      title="Per-account overrides"
      className="mt-4"
    >
      <Text className="!text-sm !font-normal mb-1 block" type="secondary">
        Account
      </Text>
      <div className="max-w-xl mb-4">
        <Select
          options={options}
          value={selectedAccountId ?? undefined}
          onChange={onPick}
          placeholder={accountsLoading ? 'Loading accounts…' : 'Select an account…'}
          showSearch
          allowClear
          clearLabel="Clear account"
          loading={accountsLoading}
          data-testid="feature-flags-account-picker"
          aria-label="Select an account to view its per-account overrides"
          className="w-full"
        />
        {accountsError && (
          <Text
            className="!text-sm mt-1 block"
            type="danger"
            data-testid="feature-flags-account-picker-error"
          >
            {accountsError}
          </Text>
        )}
      </div>

      {selectedAccountId == null ? (
        <Empty
          data-testid="feature-flags-account-empty"
          description="Select an account to view and override its feature flags."
        />
      ) : accountLoading && accountFlags.length === 0 ? (
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading per-account overrides" />
        </div>
      ) : accountError && accountFlags.length === 0 ? (
        <ErrorState
          variant="page"
          resource="per-account overrides"
          description="This account's overrides couldn't be loaded. Try again."
          details={accountError}
          onRetry={() => void FeatureFlags.loadForAccount(selectedAccountId)}
          data-testid="feature-flags-account-error"
        />
      ) : accountFlags.length === 0 ? (
        <Empty
          data-testid="feature-flags-account-flags-empty"
          description="No feature flags are defined."
        />
      ) : (
        <div>
          <ul
            data-testid="feature-flags-account-list"
            className="divide-y divide-border"
          >
            {pageFlags.map(renderRow)}
          </ul>
          {total > 0 && (
            <ListPagination
              data-testid="feature-flags-account-pagination"
              current={safePage}
              total={total}
              pageSize={pageSize}
              onChange={handlePageChange}
              onPageSizeChange={(size: number) => handlePageChange(1, size)}
              itemNoun="flags"
            />
          )}
        </div>
      )}
    </Card>
  )
}

export function FeatureFlagsPage() {
  // Destructuring defaults: the `registerLazyStore` proxy can transiently yield an
  // undefined state field before the store hydrates in some runtimes (seen in the
  // gallery crawl — a bare `flags.length` then throws). Defaulting every field keeps
  // the first paint safe and matches the store's real initial state (mirrors
  // AccountsAdminPage).
  const { flags = [], loading = false, error = null, pending = {} } = FeatureFlags
  const canManage = usePermission(Permissions.FeaturesManage)

  // Which flag's toggle Confirm is currently open (mirrors UsersSettings'
  // single shared confirm keyed by row id).
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  // Client-side pagination over the single `Features.list` response (DEC-4,
  // settings numbered idiom, page size 10). The compiled flag registry is
  // bounded but grows with releases, so the list is paged, never unbounded.
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const subtitle =
    'Runtime feature flags for this deployment. Each flag has a compiled default, an ' +
    'optional global override, and optional per-account overrides; the effective state ' +
    'is what the app actually uses. Toggling a flag sets its GLOBAL default for the whole ' +
    'deployment.'

  if (loading && flags.length === 0) {
    return (
      <SettingsPageContainer title="Feature Flags" subtitle={subtitle} data-testid="feature-flags-page">
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading feature flags" />
        </div>
      </SettingsPageContainer>
    )
  }

  if (error && flags.length === 0) {
    return (
      <SettingsPageContainer title="Feature Flags" subtitle={subtitle} data-testid="feature-flags-page">
        <ErrorState
          variant="page"
          resource="feature flags"
          description="The feature flags couldn't be loaded. Check your connection and try again."
          details={error}
          onRetry={() => void FeatureFlags.load()}
          data-testid="feature-flags-error"
        />
      </SettingsPageContainer>
    )
  }

  const total = flags.length
  // Clamp the page against the current list length: a sync:reconnect reload can
  // return fewer flags than a later page addresses, which would otherwise render
  // an empty <ul> under a live pager.
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, lastPage)
  const start = (safePage - 1) * pageSize
  const pageFlags = flags.slice(start, start + pageSize)

  const handlePageChange = (nextPage: number, size?: number) => {
    if (size && size !== pageSize) {
      setPageSize(size)
      setPage(1)
    } else {
      setPage(nextPage)
    }
  }

  const handleToggle = async (flag: FeatureFlagView) => {
    const enabled = !flag.effective
    try {
      await runAction('features.setGlobalFlag', { flag_key: flag.flag_key, enabled })
      message.success(
        `Feature "${flag.flag_key}" ${enabled ? 'enabled' : 'disabled'} globally`,
      )
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update feature flag')
    } finally {
      setConfirmKey(null)
    }
  }

  const renderRow = (flag: FeatureFlagView) => {
    const isPending = !!pending[flag.flag_key]
    const hasGlobalOverride = flag.global_enabled != null
    return (
      <li
        key={flag.flag_key}
        data-testid={`feature-flag-row-${flag.flag_key}`}
        className="flex items-center justify-between gap-4 py-3 flex-wrap"
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm break-all">{flag.flag_key}</div>
          <div className="text-sm text-muted-foreground">{flag.description}</div>
          <Text
            className="text-xs text-muted-foreground"
            data-testid={`feature-flag-provenance-${flag.flag_key}`}
          >
            {hasGlobalOverride
              ? 'Global override'
              : `Compiled default (${flag.default_enabled ? 'on' : 'off'})`}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <Badge
            data-testid={`feature-flag-effective-${flag.flag_key}`}
            tone={flag.effective ? 'success' : 'neutral'}
          >
            {flag.effective ? 'On' : 'Off'}
          </Badge>
          {canManage && (
            <>
              {/* The Switch shows the RESOLVED effective value; the toggle sets the
                  GLOBAL default. In today's global-only view these coincide
                  (effective == global-resolved). The per-account follow-on (DEC-1)
                  must revisit this binding so an account override can't make the
                  global toggle look unresponsive. */}
              <Switch
                data-standalone-control
                tooltip={flag.effective ? 'Disable globally' : 'Enable globally'}
                checked={flag.effective}
                disabled={isPending}
                onChange={() => setConfirmKey(flag.flag_key)}
                data-testid={`feature-flag-switch-${flag.flag_key}`}
              />
              <Confirm
                open={confirmKey === flag.flag_key}
                onOpenChange={open => setConfirmKey(open ? flag.flag_key : null)}
                title={`${flag.effective ? 'Disable' : 'Enable'} "${flag.flag_key}" for the whole deployment?`}
                onConfirm={() => handleToggle(flag)}
                okText={flag.effective ? 'Disable' : 'Enable'}
                cancelText="Cancel"
                data-testid={`feature-flag-toggle-confirm-${flag.flag_key}`}
              />
            </>
          )}
        </div>
      </li>
    )
  }

  return (
    <SettingsPageContainer title="Feature Flags" subtitle={subtitle} data-testid="feature-flags-page">
      <Card data-testid="feature-flags-card" title="Flags">
        {!canManage && (
          <Alert
            data-testid="feature-flags-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You can view feature flags but not change them."
            className="mb-3"
          />
        )}

        {flags.length === 0 ? (
          <Empty data-testid="feature-flags-empty" description="No feature flags are defined." />
        ) : (
          <div>
            <ul data-testid="feature-flags-list" className="divide-y divide-border">
              {pageFlags.map(renderRow)}
            </ul>
            {total > 0 && (
              <ListPagination
                data-testid="feature-flags-pagination"
                current={safePage}
                total={total}
                pageSize={pageSize}
                onChange={handlePageChange}
                onPageSizeChange={(size: number) => handlePageChange(1, size)}
                itemNoun="flags"
              />
            )}
          </div>
        )}
      </Card>

      {/* Per-account overrides (#53) — a management-only surface; unpermitted users
          (who can't reach this route anyway) never see the per-account controls. */}
      {canManage && <PerAccountSection />}
    </SettingsPageContainer>
  )
}
