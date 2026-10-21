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
import { ListPagination } from '@/components/common/ListPagination'
import type { FeatureFlagView } from '@/api-client/types'
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
    </SettingsPageContainer>
  )
}
