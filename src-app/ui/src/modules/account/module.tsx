import { Building2 } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
import '@/modules/layouts/app-layout/types' // Register the `sidebarHeader` slot type
import { AccountSwitcher } from './components/AccountSwitcher'

const AccountSettingsPage = lazyWithPreload(() =>
  import('./pages/AccountSettingsPage').then(m => ({ default: m.AccountSettingsPage })),
)

/**
 * The `account` module (A4) — the active-account switcher (app chrome) + the
 * `/settings/accounts` page, both gated on `account::read` (Users-group grant; a
 * restricted user in a custom group without it sees neither — TEST-13). The
 * `Accounts` store self-registers on import (via `AccountSwitcher`), so `stores: []`.
 * The switcher renders nothing at ≤1 account / on desktop, so solo + desktop users
 * never see the concept.
 */
export default createModule({
  metadata: {
    name: 'account',
    version: '1.0.0',
    description: 'Active-account switcher + account settings (tenancy).',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/accounts',
      element: AccountSettingsPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      permission: Permissions.AccountRead, // route guard (403 on direct nav)
    },
  ],
  stores: [],
  slots: {
    // The switcher in the sidebar HEADER region (DEC-5). Permission-gated so a user
    // lacking `account::read` never mounts it (the slot gating layer — TEST-13).
    sidebarHeader: [
      {
        id: 'account-switcher',
        component: AccountSwitcher,
        order: 0,
        permission: Permissions.AccountRead,
      },
    ],
    // The account settings page (settingsUserPages slot; DEC-4 / DEC-5).
    settingsUserPages: [
      {
        id: 'accounts',
        icon: <Building2 />,
        // "My accounts" — this page lists the accounts the CURRENT user belongs to
        // (their personal account + every org they are a member of). First-person +
        // plural is accurate and disambiguates from the deployment-wide admin
        // "Accounts" entry (settingsAdminPages) in every shell, incl. the desktop
        // flat settings menu (#51 DEC-1).
        label: 'My accounts',
        path: 'accounts',
        order: 12,
        permission: Permissions.AccountRead,
      },
    ],
  },
})
