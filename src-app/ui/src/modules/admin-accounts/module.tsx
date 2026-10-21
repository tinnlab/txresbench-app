import { Building2 } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: register the Accounts-admin `defineAction`s
// (`admin.account.createOrg` / `addMember` / `setMemberRole` / `removeMember`)
// into the global action registry. This is the SOLE runtime import site.
import '@/core/actions/builtin/adminAccountActions'

const AccountsAdminPage = lazyWithPreload(() =>
  import('./pages/AccountsAdminPage').then(m => ({
    default: m.AccountsAdminPage,
  })),
)

const AccountDetailPage = lazyWithPreload(() =>
  import('./pages/AccountDetailPage').then(m => ({
    default: m.AccountDetailPage,
  })),
)

/**
 * The `admin-accounts` module (#44) — the Accounts admin page of the Admin
 * Console epic. It registers a `settingsAdminPages` entry (`order: 6`), so the
 * Admin nav group lists it. (The #42 landing hub that once led this cluster was
 * removed as redundant; the Admin group renders directly from this slot's
 * entries.)
 *
 * Gated on `admin::accounts` at BOTH layers (route guard + slot entry) per
 * `docs/design/admin-console-shell.md` §"Admin sees the section; a non-admin does
 * not": the slot filter hides the nav entry for a non-admin; the route guard (and
 * `SettingsPage`'s forbidden-section handling) renders an in-place 403 on a
 * typed/bookmarked deep link. The page's write affordances are additionally gated
 * `account::manage` (`<Can>` + each mutation's `defineAction` permission).
 *
 * Single-segment path `accounts-admin` (NOT a nested `admin-console/accounts`):
 * `SettingsPage.tsx` extracts the active section from the FIRST path segment only,
 * so a nested path would break active-section detection + deep-link gating (DEC-1).
 */
export default createModule({
  metadata: {
    name: 'admin-accounts',
    version: '1.0.0',
    description:
      'Admin Accounts page: list all accounts, create organizations, manage members.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/accounts-admin',
      element: AccountsAdminPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      permission: Permissions.AdminAccounts, // route guard (403 on direct nav)
    },
    {
      // The per-account detail page (#57). Shares the FIRST path segment
      // (`accounts-admin`) with the list, so `SettingsPage`'s section matcher
      // (`/\/settings\/([^/]+)/`) keeps the section active + gated on the detail
      // route too. No separate `settingsAdminPages` slot entry — the nav shows only
      // the "Accounts" list; the detail page is reached by opening a row.
      path: '/settings/accounts-admin/:id',
      element: AccountDetailPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      permission: Permissions.AdminAccounts, // route guard (403 on deep-link, INV-1)
    },
  ],
  stores: [],
  slots: {
    settingsAdminPages: [
      {
        id: 'admin-accounts',
        icon: <Building2 />,
        // "Accounts" — the deployment-wide admin list (#51 DEC-1). The previously
        // colliding per-user entry (settingsUserPages) is now labeled "My accounts",
        // so the two are distinct in BOTH the web grouped menu (user vs "Admin"
        // group) AND the desktop flat menu (which drops the group divider). This
        // replaces the awkward "All accounts" dodge the owner flagged.
        label: 'Accounts',
        path: 'accounts-admin',
        order: 6, // leads the Admin cluster (the #42 landing at order 5 was removed)
        permission: Permissions.AdminAccounts,
      },
    ],
  },
})
