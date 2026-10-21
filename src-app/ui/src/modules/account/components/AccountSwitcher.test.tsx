// @vitest-environment jsdom
// A4 TEST-12 [acceptance][INV-4] — the desktop no-op + the ≤1-account hide.
//
// CytoAnalyst has no separate desktop/ui workspace (the desktop build serves this
// same `src-app/ui`), so the desktop no-op is proven by a mounted component test with
// `window.__TAURI__` set (isDesktop() true) rather than a desktop e2e — the drivable,
// non-vacuous form of "the switcher never renders on desktop".
//
// vitest (jsdom). The `Account` store + `@/core/platform` are the mocked boundaries;
// the real `AccountSwitcher` renders.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Account } from '@/api-client/types'

const isDesktop = vi.fn(() => false)
vi.mock('@/core/platform', () => ({ isDesktop: () => isDesktop(), isWeb: () => !isDesktop() }))

// A mutable fake of the reactive store proxy the switcher reads.
const store = {
  accounts: [] as Account[],
  activeAccountId: null as string | null,
  loading: false,
  error: null as string | null,
  setActiveAccount: vi.fn(),
}
vi.mock('@/modules/account/stores/Account.store', () => ({ Account: store }))

const { AccountSwitcher } = await import('./AccountSwitcher')

const PERSONAL: Account = {
  id: 'p1',
  kind: 'personal',
  name: 'me',
  personal_user_id: 'u1',
  created_at: '',
  updated_at: '',
}
const ORG: Account = {
  id: 'o1',
  kind: 'organization',
  name: 'Acme',
  personal_user_id: undefined,
  created_at: '',
  updated_at: '',
}

beforeEach(() => {
  isDesktop.mockReturnValue(false)
  store.accounts = []
  store.activeAccountId = null
  store.loading = false
  store.error = null
})
afterEach(() => cleanup())

describe('TEST-12 — the switcher is a no-op on desktop and at ≤1 account (INV-4)', () => {
  it('renders NOTHING on desktop even with two accounts (the __TAURI__ gate)', () => {
    isDesktop.mockReturnValue(true)
    store.accounts = [PERSONAL, ORG]
    store.activeAccountId = 'p1'
    const { container } = render(<AccountSwitcher />)
    expect(container.innerHTML, 'desktop → switcher never mounts').toBe('')
  })

  it('renders NOTHING on web with a single account (the hidden-at-one rule)', () => {
    store.accounts = [PERSONAL]
    store.activeAccountId = 'p1'
    const { container } = render(<AccountSwitcher />)
    expect(container.innerHTML, 'solo user → switcher hidden').toBe('')
  })

  it('DOES render on web with two accounts (the positive control)', () => {
    store.accounts = [PERSONAL, ORG]
    store.activeAccountId = 'p1'
    const { queryByTestId } = render(<AccountSwitcher />)
    expect(queryByTestId('account-switcher')).not.toBeNull()
  })
})
