import { User as UserIcon, Users as UsersIcon } from 'lucide-react'
import { Permissions } from '@/api-client/permissions'
import { isKnownPermission } from '@/core/permissions'
import { createModule } from '@ziee/framework'
// Side-effect imports: register the Users/Groups identity-CRUD `defineAction`s (#49) so
// every admin mutation is drivable by the palette + AI, not only the inline human path.
// Unconditional — these gate on default-build permissions (unlike the saas-gated
// `userTierActions` imported below).
import '@/core/actions/builtin/usersAdminActions'
import '@/core/actions/builtin/userGroupActions'

// Register the saas-only Users-tier `defineAction`s (`user.grantPremiumComp` /
// `user.grantUserCredit`, #43) ONLY when `billing::admin` is present in the build — so
// on a desktop/OSS build they don't surface in ⌘K / list_capabilities (the committed
// frontend-actions manifest still carries them for the hosted build; the server filters
// by held permission). Mirrors `billing/module.tsx`'s `present`-gated action import.
if (isKnownPermission('billing::admin')) void import('@/core/actions/builtin/userTierActions')
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import '@/modules/user/types' // Import type augmentation
import '@/modules/user/types/GroupWidget' // Register userGroup widget slot
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types

const UsersSettings = lazyWithPreload(() =>
  import('./components/user/UsersSettings').then(m => ({
    default: m.UsersSettings,
  })),
)
const UserGroupsSettings = lazyWithPreload(() =>
  import('./components/group/UserGroupsSettings').then(m => ({
    default: m.UserGroupsSettings,
  })),
)

export default createModule({
  metadata: {
    name: 'user',
    version: '1.0.0',
    description: 'User and user group management',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/users',
      element: UsersSettings,
      requiresAuth: true,
      permission: Permissions.UsersRead,
      layout: SettingsLayoutDef,
    },
    {
      path: '/settings/user-groups',
      element: UserGroupsSettings,
      requiresAuth: true,
      permission: Permissions.GroupsRead,
      layout: SettingsLayoutDef,
    },
  ],
  // All nine user stores are WHOLE-STORE-LAZY: each store file calls
  // `registerLazyStore` at module scope and self-registers, so the store's code
  // rides the chunk of whatever settings component imports it. Listing them here
  // would re-introduce an eager `module.tsx` → store import and drag every one
  // of them back into the entry chunk.
  stores: [],
  slots: {
    settingsAdminPages: [
      {
        id: 'users',
        icon: <UserIcon />,
        label: 'Users',
        path: 'users',
        order: 10,
        permission: Permissions.UsersRead,
      },
      {
        id: 'user-groups',
        icon: <UsersIcon />,
        label: 'User Groups',
        path: 'user-groups',
        order: 11,
        permission: Permissions.GroupsRead,
      },
    ],
  },
  initialize: () => {
    console.log('User module initialized')
  },
  cleanup: () => {
    console.log('User module cleanup')
  },
})
