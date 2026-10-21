import { createModule } from '@ziee/framework'
import { User } from 'lucide-react'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { Permissions } from '@/api-client/permissions'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import './types'
import './events'

const ProfileSettingsPage = lazyWithPreload(() =>
  import('./pages/ProfileSettingsPage').then(m => ({
    default: m.ProfileSettingsPage,
  })),
)

export default createModule({
  metadata: {
    name: 'profile',
    version: '1.0.0',
    description: 'Self-service account profile: view, edit, change password.',
  },
  dependencies: ['router'],
  routes: [
    {
      // Self-service — viewing your own profile requires `profile::read`
      // (held by the default group). Editing is gated separately in the
      // page on `profile::edit`.
      path: '/settings/profile',
      element: ProfileSettingsPage,
      requiresAuth: true,
      permission: Permissions.ProfileEdit,
      layout: SettingsLayoutDef,
    },
  ],
  // Profile is WHOLE-STORE-LAZY (`registerLazyStore` in its own file).
  stores: [],
  slots: {
    settingsUserPages: [
      {
        id: 'profile',
        icon: <User />,
        label: 'Profile',
        path: 'profile',
        // Above General (10) — the profile is the most personal page.
        order: 5,
        permission: Permissions.ProfileEdit,
      },
    ],
  },
})
