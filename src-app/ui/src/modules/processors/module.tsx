import { Puzzle } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types

const ProcessorsAdminPage = lazyWithPreload(() => import('./ProcessorsAdminPage'))

export default createModule({
  metadata: {
    name: 'processors',
    version: '1.0.0',
    description: 'Runtime-discovered analysis processors (folder scan + reload)',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/processors',
      element: ProcessorsAdminPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly (DEC-6,
      // reuses the existing sandbox settings read perm — no new permission).
      permission: Permissions.SandboxSettingsRead,
    },
  ],
  // ProcessorsAdmin is WHOLE-STORE-LAZY (`registerLazyStore` in its own file):
  // listing it here would re-add an eager module.tsx -> store import.
  stores: [],
  slots: {
    // Admin sidebar entry — hidden for users without the read permission.
    settingsAdminPages: [
      {
        id: 'processors',
        icon: <Puzzle />,
        label: 'Processors',
        path: 'processors',
        order: 31,
        permission: Permissions.SandboxSettingsRead,
      },
    ],
  },
})
