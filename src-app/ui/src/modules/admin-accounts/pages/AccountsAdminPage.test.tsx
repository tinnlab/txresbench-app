// @vitest-environment jsdom
// TEST-5 (#44) — the Accounts admin page renders one row per account with the
// kind Badge, member count and owner; shows Empty when initialized+empty; shows
// a retryable ErrorState on a cold-load failure.

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAccountSummary } from '@/api-client/types'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }))

// kit Descriptions measures its container via ResizeObserver in a layout effect
// (absent in jsdom) — polyfill it (the repo's per-test idiom).
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  Can: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@ziee/shell', () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Loading: ({ label }: { label?: string }) => <div>{label}</div>,
}))
// The drawers pull heavy deps (forms, Users store); they are covered elsewhere.
vi.mock('@/modules/admin-accounts/components/CreateOrgDrawer', () => ({
  CreateOrgDrawer: () => null,
}))

const { AccountsAdminPage } = await import('./AccountsAdminPage')
const { useAdminAccountsStore } = await import(
  '@/modules/admin-accounts/stores/AdminAccounts.store'
)

const BASE = {
  accounts: [] as AdminAccountSummary[],
  total: 0,
  currentPage: 1,
  pageSize: 20,
  kind: undefined,
  isInitialized: true,
  loading: false,
  creating: false,
  error: null as string | null,
}
const row = (
  id: string,
  name: string,
  kind: 'personal' | 'organization',
  member_count: number,
  owner_label?: string,
): AdminAccountSummary => ({
  account: { id, name, kind, created_at: '2026-07-01T00:00:00Z', updated_at: '' },
  member_count,
  // The owner is identified by user id internally, but the UI renders `owner_label`
  // (a human name) — never the UUID (#51 defect #2). Seed a realistic label.
  owner_user_id: owner_label ? '00000000-0000-4000-8000-000000000001' : undefined,
  owner_label,
})

beforeEach(() => {
  navigateMock.mockReset()
  useAdminAccountsStore.setState(BASE as never)
})
afterEach(() => cleanup())

describe('TEST-5 — Accounts admin page', () => {
  // TEST-5 [covers ITEM-8, ITEM-6]: the owner field renders the human `owner_label`,
  // never the UUID.
  it('renders a row per account with kind badge, member count, and owner NAME', () => {
    const rows = [
      row('a1', 'Acme', 'organization', 7, 'Ada Lovelace'),
      row('a2', 'jdoe', 'personal', 1, 'John Doe'),
    ]
    useAdminAccountsStore.setState({ ...BASE, accounts: rows, total: 2 } as never)
    const { getByTestId } = render(<AccountsAdminPage />)

    expect(getByTestId('account-row-a1')).toBeTruthy()
    expect(getByTestId('account-kind-badge-a1').textContent).toBe('Organization')
    expect(getByTestId('account-member-count-a1').textContent).toBe('7')
    // The owner is a human name (owner_label), NOT the raw user_id UUID.
    expect(getByTestId('account-owner-a1').textContent).toBe('Ada Lovelace')
    expect(getByTestId('account-owner-a1').textContent).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
    )

    expect(getByTestId('account-kind-badge-a2').textContent).toBe('Personal')
    expect(getByTestId('account-member-count-a2').textContent).toBe('1')
    expect(getByTestId('account-owner-a2').textContent).toBe('John Doe')
  })

  it('renders "No owner" when the account has no owner', () => {
    useAdminAccountsStore.setState({
      ...BASE,
      accounts: [row('a3', 'Orphan', 'organization', 0, undefined)],
      total: 1,
    } as never)
    const { getByTestId } = render(<AccountsAdminPage />)
    expect(getByTestId('account-owner-a3').textContent).toBe('No owner')
  })

  it('renders Empty when initialized with no accounts', () => {
    useAdminAccountsStore.setState({ ...BASE, accounts: [], total: 0 } as never)
    const { getByTestId, queryByTestId } = render(<AccountsAdminPage />)
    expect(getByTestId('accounts-admin-empty')).toBeTruthy()
    expect(queryByTestId('accounts-admin-error')).toBeNull()
  })

  it('renders a retryable ErrorState on a cold-load failure', () => {
    useAdminAccountsStore.setState({
      ...BASE,
      accounts: [],
      total: 0,
      error: 'Failed to load accounts',
    } as never)
    const { getByTestId } = render(<AccountsAdminPage />)
    expect(getByTestId('accounts-admin-error')).toBeTruthy()
  })

  // TEST-7 [covers ITEM-11]: the per-row "Manage" button navigates to the account
  // detail page (carrying the summary hint), and NO members drawer is mounted.
  it('navigates to the account detail page when Manage is clicked, with the summary hint', () => {
    const summary = row('a1', 'Acme', 'organization', 7, 'Ada Lovelace')
    useAdminAccountsStore.setState({ ...BASE, accounts: [summary], total: 1 } as never)
    const { getByTestId, queryByTestId } = render(<AccountsAdminPage />)

    // The old members-drawer trigger is gone; the Manage button is present.
    expect(queryByTestId('account-members-button-a1')).toBeNull()
    fireEvent.click(getByTestId('account-manage-button-a1'))

    expect(navigateMock).toHaveBeenCalledWith('/settings/accounts-admin/a1', {
      state: { summary },
    })
  })
})
