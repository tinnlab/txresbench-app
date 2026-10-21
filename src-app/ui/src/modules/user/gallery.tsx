import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { useUsersStore } from '@/modules/user/stores/Users.store'
import { useGrantUserCreditDrawerStore } from '@/modules/user/components/user/GrantUserCreditDrawer.store'
// Side-effect: register the Users-tier actions so the gallery's interactive controls
// (premium Switch→Confirm, Grant credit) don't throw when dispatched.
import '@/core/actions/builtin/userTierActions'

/**
 * Gallery seed for the Users admin page (#43). The page fetches at runtime; the gallery
 * seeds the store so the design-critic vision pass reviews the POPULATED surface with
 * REALISTIC data — real human names/emails (never a bare UUID, INV-3), premium on/off,
 * dollar balances rendered from CENTS (INV-4), and a user with NO personal account
 * ("—").
 *
 * The tier/premium COLUMN presence-gates on `billing::admin` (INV-1), so it renders
 * POPULATED only under a saas build — review with `npm run gallery:saas` (VITE_SAAS=1).
 * In the default gallery the base Users list renders and the column self-hides (itself a
 * valid, reviewed state — the presence self-hide). See DEC-9.
 */
const UsersSettings = lazy(() =>
  import('./components/user/UsersSettings').then(m => ({ default: m.UsersSettings })),
)

// Realistic ids so nothing renders a raw UUID as identity; personal-account ids are the
// action target only (never shown).
const U = (n: string) => `00000000-0000-4000-8000-0000000000${n}`

type SeededUser = {
  id: string
  username: string
  display_name?: string
  email: string
  is_active: boolean
  is_admin: boolean
  email_verified: boolean
  permissions: string[]
  created_at: string
  updated_at: string
  last_login_at?: string
  personal_account_id?: string | null
  billing?: { premium: boolean; plan_id: string; credit_balance_cents: number } | null
}

export const seededUsers: SeededUser[] = [
  {
    id: U('01'),
    username: 'alovelace',
    display_name: 'Ada Lovelace',
    email: 'ada@acme.bio',
    is_active: true,
    is_admin: true,
    email_verified: true,
    permissions: [],
    created_at: '2026-01-12T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    last_login_at: '2026-08-26T09:30:00Z',
    personal_account_id: U('a1'),
    billing: { premium: true, plan_id: 'enterprise', credit_balance_cents: 500000 },
  },
  {
    id: U('02'),
    username: 'aturing',
    display_name: 'Alan Turing',
    email: 'alan@acme.bio',
    is_active: true,
    is_admin: false,
    email_verified: true,
    permissions: [],
    created_at: '2026-02-03T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    last_login_at: '2026-08-25T14:05:00Z',
    personal_account_id: U('a2'),
    billing: { premium: false, plan_id: 'pro', credit_balance_cents: 1250 },
  },
  {
    id: U('03'),
    username: 'ghopper',
    display_name: 'Grace Hopper',
    email: 'grace@acme.bio',
    is_active: true,
    is_admin: false,
    email_verified: true,
    permissions: [],
    created_at: '2026-03-15T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    last_login_at: '2026-08-10T08:00:00Z',
    personal_account_id: U('a3'),
    billing: { premium: false, plan_id: 'free', credit_balance_cents: 0 },
  },
  {
    // No personal account yet → neutral "—" (never a fabricated "$0.00 / free").
    id: U('04'),
    username: 'kjohnson',
    display_name: 'Katherine Johnson',
    email: 'katherine@acme.bio',
    is_active: false,
    is_admin: false,
    email_verified: false,
    permissions: [],
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    personal_account_id: null,
    billing: null,
  },
]

function base(users: SeededUser[], error: string | null = null, loading = false) {
  return () => {
    useUsersStore.setState({
      users,
      total: users.length,
      currentPage: 1,
      pageSize: 10,
      isInitialized: true,
      loading,
      error,
    } as never)
    useGrantUserCreditDrawerStore.setState({ isOpen: false, accountId: null, label: '' } as never)
  }
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'users-populated',
      title: 'Users — populated (premium on/off, balances, no-account)',
      note: 'Real names/emails; premium enterprise ($5,000.00), pro ($12.50), free ($0.00), and a user with no personal account ("—"). The tier column shows only under gallery:saas.',
      path: '/settings/users',
      initialPath: '/settings/users',
      component: UsersSettings,
      setup: base(seededUsers),
    },
    {
      slug: 'users-grant-credit-drawer',
      title: 'Users — grant-credit drawer (typed dollar form)',
      note: 'The per-user grant drawer open on Ada Lovelace: amount (dollars), required reason, optional expiry — no JSON textarea (saas only).',
      path: '/settings/users',
      initialPath: '/settings/users',
      component: UsersSettings,
      setup: () => {
        base(seededUsers)()
        useGrantUserCreditDrawerStore.setState({
          isOpen: true,
          accountId: U('a1'),
          label: 'Ada Lovelace',
        } as never)
      },
    },
    {
      slug: 'users-empty',
      title: 'Users — empty',
      note: 'No users yet — the neutral empty state.',
      path: '/settings/users',
      initialPath: '/settings/users',
      component: UsersSettings,
      setup: base([]),
    },
    {
      slug: 'users-error',
      title: 'Users — cold-load error',
      note: 'A backend outage on load: a retryable ErrorState, not a blank card.',
      path: '/settings/users',
      initialPath: '/settings/users',
      component: UsersSettings,
      setup: base([], 'Failed to load users'),
    },
  ],
}
