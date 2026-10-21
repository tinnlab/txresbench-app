// @vitest-environment jsdom
// TEST-3 [covers ITEM-4] — the inline Members section: renders members by NAME
// (display_name → username, never the UUID, #51), the add-member row gated
// account::manage, a per-row role Select + Remove, and the client sole-owner guard
// (restricts role options + disables Remove for the last owner). The runAction
// dispatch of the mutations is proven end-to-end in the account-detail e2e (TEST-11).
//
// vitest (jsdom). Boundaries mocked: permissions, the Users store, runAction, and
// kit's `message`; the real store + section run.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountMember } from '@/api-client/types'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  Permissions: { AccountManage: 'account::manage', UsersRead: 'users::read' },
}))
vi.mock('@/core/actions/defineAction', () => ({ runAction: vi.fn() }))
vi.mock('@/modules/user/stores/Users.store', () => ({
  Users: { users: [], loadUsers: vi.fn() },
}))
vi.mock('@ziee/kit', async importOriginal => ({
  ...(await importOriginal<typeof import('@ziee/kit')>()),
  message: { success: vi.fn(), error: vi.fn() },
}))

const { MembersSection } = await import('./MembersSection')
const { useAccountMembersStore } = await import(
  '@/modules/admin-accounts/stores/AccountMembers.store'
)

const ORG: Account = {
  id: 'a1',
  name: 'Acme Bio',
  kind: 'organization',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '',
}
const member = (
  user_id: string,
  username: string,
  role: AccountMember['role'],
  display_name?: string,
): AccountMember => ({
  account_id: 'a1',
  user_id,
  role,
  created_at: '',
  username,
  email: `${username}@acme.bio`,
  display_name,
})

function seed(members: AccountMember[]) {
  useAccountMembersStore.setState({
    account: ORG,
    members,
    total: members.length,
    currentPage: 1,
    pageSize: 20,
    isInitialized: true, // already loaded → the section's load effect is a no-op
    loading: false,
    mutating: false,
    error: null,
  } as never)
}

afterEach(cleanup)
beforeEach(() =>
  seed([
    member('u1', 'ada', 'owner', 'Ada Lovelace'),
    member('u2', 'aturing', 'admin', 'Alan Turing'),
    member('u3', 'kjohnson', 'member'), // no display_name → username fallback
  ]),
)

describe('TEST-3 — Members section', () => {
  it('renders members by human name (never a raw UUID), with the add-member row + role controls', () => {
    const { getByTestId } = render(<MembersSection account={ORG} />)

    // Names, not UUIDs (#51).
    expect(getByTestId('account-member-name-u1').textContent).toBe('Ada Lovelace')
    expect(getByTestId('account-member-name-u3').textContent).toBe('kjohnson') // fallback
    for (const uid of ['u1', 'u2', 'u3']) {
      expect(getByTestId(`account-member-name-${uid}`).textContent).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
      )
    }

    // The gated add-member row + per-row role Select + Remove are present.
    expect(getByTestId('account-members-add-row')).toBeTruthy()
    expect(getByTestId('account-member-role-select-u1')).toBeTruthy()
    expect(getByTestId('account-member-remove-button-u1')).toBeTruthy()
  })

  it('applies the sole-owner guard: the last owner cannot be removed', () => {
    seed([member('u1', 'ada', 'owner', 'Ada Lovelace')]) // single owner, full set known
    const { getByTestId } = render(<MembersSection account={ORG} />)
    const removeBtn = getByTestId('account-member-remove-button-u1')
    // The kit Button surfaces the guard via aria-disabled / an unavailable reason.
    expect(
      removeBtn.getAttribute('aria-disabled') === 'true' ||
        removeBtn.getAttribute('disabled') !== null ||
        removeBtn.getAttribute('data-unavailable') !== null,
    ).toBe(true)
  })

  it('shows the Empty state when the account has no members', () => {
    seed([])
    const { getByTestId } = render(<MembersSection account={ORG} />)
    expect(getByTestId('account-members-empty')).toBeTruthy()
  })
})
