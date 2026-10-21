// @vitest-environment jsdom
// TEST-2  [covers ITEM-2] — with billing::admin PRESENT, each row shows premium on/off,
//   plan/tier, and the credit balance; a no-personal-account row shows a neutral "—".
// TEST-6  [covers ITEM-6] — toggling the premium Switch opens a Confirm; confirming
//   dispatches runAction('user.grantPremiumComp', …) — NOT an inline store mutation.
// TEST-A1 [acceptance][invariant: INV-1] — with billing::admin ABSENT the tier column +
//   controls are ALL absent while the base Users list still renders.
// TEST-A4 [acceptance][invariant: INV-3] — a display_name renders; the account UUID never
//   appears as identity text.

import { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { message } from '@ziee/kit'

const h = vi.hoisted(() => ({ billing: true }))
const runActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const grantDrawerOpen = vi.hoisted(() => vi.fn())

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  // base-ui's Switch constructs a PointerEvent on click; jsdom lacks it (repo idiom
  // from workbench/core/render/tableRowControls.test.tsx).
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
})
afterEach(cleanup)

vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  useHasPermission: () => h.billing,
  Can: ({ children }: { children: React.ReactNode }) => children,
  hasPermissionNow: () => true,
}))
vi.mock('@/core/actions/defineAction', () => ({ runAction: runActionMock }))

// Auth + peripheral stores.
vi.mock('@/modules/auth/Auth.store', () => ({ Auth: { user: { id: 'admin', is_admin: true } } }))
vi.mock('@/modules/user/stores/UserGroups.store', () => ({ UserGroups: { error: null, clearError: () => {} } }))

// Sibling drawer stores + components — stubbed; their own tests cover them.
vi.mock('@/modules/user/components/user/EditUserDrawer.store', () => ({ EditUserDrawer: { openEditUserDrawer: () => {} } }))
vi.mock('@/modules/user/components/user/ResetPasswordDrawer.store', () => ({ ResetPasswordDrawer: { openResetPasswordDrawer: () => {} } }))
vi.mock('@/modules/user/components/user/UserGroupsDrawer.store', () => ({ UserGroupsDrawer: { openUserGroupsDrawer: () => {} } }))
vi.mock('@/modules/user/components/user/CreateUserDrawer.store', () => ({ CreateUserDrawer: { openCreateUserDrawer: () => {} } }))
vi.mock('@/modules/user/components/user/CreateUserDrawer.tsx', () => ({ CreateUserDrawer: () => null }))
vi.mock('@/modules/user/components/user/EditUserDrawer.tsx', () => ({ EditUserDrawer: () => null }))
vi.mock('@/modules/user/components/user/ResetPasswordDrawer.tsx', () => ({ ResetPasswordDrawer: () => null }))
vi.mock('@/modules/user/components/user/UserGroupsDrawer.tsx', () => ({ UserGroupsDrawer: () => null }))
vi.mock('@/modules/user/components/user/AssignGroupDrawer.tsx', () => ({ AssignGroupDrawer: () => null }))
vi.mock('@/modules/user/components/user/GrantUserCreditDrawer.tsx', () => ({ GrantUserCreditDrawer: () => null }))
vi.mock('@/modules/user/components/user/GrantUserCreditDrawer.store', () => ({
  GrantUserCreditDrawer: { open: grantDrawerOpen, close: () => {} },
}))

const usersState = {
  users: [] as unknown[],
  total: 0,
  currentPage: 1,
  pageSize: 10,
  loading: false,
  error: null as string | null,
  loadUsers: vi.fn(),
  clearError: vi.fn(),
  toggleUserActiveStatus: vi.fn(),
  deleteUser: vi.fn(),
}
vi.mock('@/modules/user/stores/Users.store', () => ({ Users: usersState }))

const { UsersSettings } = await import('./UsersSettings')

const rows = [
  {
    id: 'u1', username: 'alovelace', display_name: 'Ada Lovelace', email: 'ada@acme.bio',
    is_active: true, is_admin: false, email_verified: true, permissions: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    personal_account_id: 'acct-ada-uuid', billing: { premium: true, plan_id: 'enterprise', credit_balance_cents: 500000 },
  },
  {
    id: 'u2', username: 'aturing', display_name: 'Alan Turing', email: 'alan@acme.bio',
    is_active: true, is_admin: false, email_verified: true, permissions: [],
    created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    personal_account_id: 'acct-turing', billing: { premium: false, plan_id: 'free', credit_balance_cents: 1250 },
  },
  {
    id: 'u3', username: 'kjohnson', display_name: 'Katherine Johnson', email: 'kj@acme.bio',
    is_active: false, is_admin: false, email_verified: false, permissions: [],
    created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
    personal_account_id: null, billing: null,
  },
]

beforeEach(() => {
  h.billing = true
  runActionMock.mockClear()
  grantDrawerOpen.mockClear()
  Object.assign(usersState, { users: rows, total: rows.length, loading: false, error: null })
})

describe('TEST-2 / TEST-A4 — tier column populated (billing::admin present)', () => {
  it('shows premium on/off, plan, and the balance as dollars; identity is the display_name', () => {
    render(<UsersSettings />)
    expect(screen.getByTestId('user-tier-premium-badge-u1').textContent).toMatch(/Premium/)
    expect(screen.getByTestId('user-tier-premium-badge-u2').textContent).toMatch(/Standard/)
    expect(screen.getByTestId('user-tier-plan-u1').textContent).toMatch(/enterprise/)
    expect(screen.getByTestId('user-tier-balance-u1').textContent).toMatch(/\$5,000\.00/)
    expect(screen.getByTestId('user-tier-balance-u2').textContent).toMatch(/\$12\.50/)
    // Identity is the human name; the account UUID is never rendered (INV-3).
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByText(/acct-ada-uuid/)).toBeNull()
  })

  it('renders a neutral "—" for a user with no personal account', () => {
    render(<UsersSettings />)
    expect(screen.getByTestId('user-tier-none-u3').textContent).toBe('—')
    expect(screen.queryByTestId('user-tier-premium-badge-u3')).toBeNull()
  })
})

describe('TEST-6 — premium toggle dispatches the defineAction via a Confirm (INV-2)', () => {
  it('Switch → Confirm → runAction(user.grantPremiumComp)', async () => {
    render(<UsersSettings />)
    fireEvent.click(screen.getByTestId('user-tier-premium-switch-u1'))
    // The controlled Confirm is now open; confirm it.
    const confirm = await screen.findByTestId('user-tier-premium-confirm-u1')
    const ok = within(confirm.ownerDocument.body).getByRole('button', { name: /^OK$/ })
    await act(async () => {
      fireEvent.click(ok)
    })
    expect(runActionMock).toHaveBeenCalledWith('user.grantPremiumComp', {
      account_id: 'acct-ada-uuid',
      premium: false, // Ada is premium=true → toggling clears it
    })
  })

  it('the Grant credit button opens the grant drawer for that account', () => {
    render(<UsersSettings />)
    fireEvent.click(screen.getByTestId('user-tier-grant-credit-button-u2'))
    expect(grantDrawerOpen).toHaveBeenCalledWith('acct-turing', 'Alan Turing')
  })

  // FIX_ROUND-1 (LEDGER: correctness/UsersSettings.tsx:127) — a silent no-op from the
  // action (result falsy) must NOT toast a false success. This RED-without-the-fix
  // regression is what promotes the finding (oracle_confirmed).
  it('does NOT toast success when the premium action no-ops (falsy result)', async () => {
    const successSpy = vi.spyOn(message, 'success').mockImplementation(() => undefined as never)
    runActionMock.mockResolvedValueOnce(undefined as never)
    render(<UsersSettings />)
    fireEvent.click(screen.getByTestId('user-tier-premium-switch-u1'))
    const confirm = await screen.findByTestId('user-tier-premium-confirm-u1')
    const ok = within(confirm.ownerDocument.body).getByRole('button', { name: /^OK$/ })
    await act(async () => {
      fireEvent.click(ok)
    })
    expect(runActionMock).toHaveBeenCalled()
    expect(successSpy).not.toHaveBeenCalled()
    successSpy.mockRestore()
  })
})

describe('TEST-A1 — presence self-hide (billing::admin absent)', () => {
  it('hides the whole tier column + controls while the base Users list still renders', () => {
    h.billing = false
    render(<UsersSettings />)
    // Base list still works.
    expect(screen.getByTestId('user-list-card')).toBeTruthy()
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    // Tier column + every control absent.
    expect(screen.queryByTestId('user-tier-row-u1')).toBeNull()
    expect(screen.queryByTestId('user-tier-premium-switch-u1')).toBeNull()
    expect(screen.queryByTestId('user-tier-grant-credit-button-u1')).toBeNull()
    expect(screen.queryByTestId('user-tier-none-u3')).toBeNull()
  })
})
