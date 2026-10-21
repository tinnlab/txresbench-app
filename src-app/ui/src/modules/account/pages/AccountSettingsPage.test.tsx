// @vitest-environment jsdom
// TEST-9 [covers ITEM-9] (#51) — the personal `/settings/accounts` page's org
// members list renders each member by a HUMAN name (display_name ?? username) +
// email secondary line, never the raw `user_id` UUID. Boundaries mocked: the shell
// container + `ApiClient.Account.listMembers`; the real page + real Account store run.

import type { ReactNode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account as AccountModel, AccountMember } from '@/api-client/types'

vi.mock('@ziee/shell', () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

// The Account store self-inits on first access and consults the permission gate;
// stub it (return false so its init never fetches — we seed state directly).
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => false }))

const listMembers = vi.fn()
const list = vi.fn(async () => ({ accounts: [] }))
vi.mock('@/api-client', () => ({
  ApiClient: { Account: { listMembers: () => listMembers(), list: () => list() } },
}))

const { AccountSettingsPage } = await import('./AccountSettingsPage')
const { useAccountStore } = await import('@/modules/account/stores/Account.store')

const ORG: AccountModel = {
  id: 'o1',
  kind: 'organization',
  name: 'Acme Bio',
  personal_user_id: undefined,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '',
}

const UUID = '665a9a6c-4685-4d2f-9a1a-000000000001'
const member = (extra: Partial<AccountMember>): AccountMember => ({
  account_id: 'o1',
  user_id: UUID,
  role: 'owner',
  created_at: '',
  username: 'ada',
  email: 'ada@acme.bio',
  display_name: 'Ada Lovelace',
  ...extra,
})

beforeEach(() => {
  listMembers.mockReset()
  useAccountStore.setState({
    accounts: [ORG],
    activeAccountId: 'o1',
    loading: false,
    error: null,
  } as never)
})
afterEach(() => cleanup())

describe('TEST-9 — personal account settings member identity', () => {
  it('renders the member display name + email, never the user_id UUID', async () => {
    listMembers.mockResolvedValue({ members: [member({})], total: 1, page: 1, per_page: 10 })
    const { getByTestId, queryByText } = render(<AccountSettingsPage />)

    await waitFor(() =>
      expect(getByTestId(`account-member-name-${UUID}`).textContent).toBe('Ada Lovelace'),
    )
    expect(getByTestId(`account-member-email-${UUID}`).textContent).toBe('ada@acme.bio')
    // The raw UUID is not rendered as visible text anywhere.
    expect(queryByText(UUID)).toBeNull()
  })

  it('falls back to username when display_name is absent', async () => {
    listMembers.mockResolvedValue({
      members: [member({ display_name: undefined, username: 'kjohnson' })],
      total: 1,
      page: 1,
      per_page: 10,
    })
    const { getByTestId } = render(<AccountSettingsPage />)
    await waitFor(() =>
      expect(getByTestId(`account-member-name-${UUID}`).textContent).toBe('kjohnson'),
    )
  })
})
