import { HardDrive } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: registers `workstore.updateSettings` (issue #54) so the settings
// save is drivable by the palette + AI, not only the inline form save.
import '@/core/actions/builtin/workstoreSettingsActions'

const WorkstoreSettingsPage = lazyWithPreload(() => import('./WorkstoreSettingsPage'))

export default createModule({
  metadata: {
    name: 'workstore',
    version: '1.0.0',
    description: 'Workstore admin settings (GC policy + ingest size caps)',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/workstore',
      element: WorkstoreSettingsPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly.
      permission: Permissions.WorkstoreSettingsRead,
    },
  ],
  // The store is WHOLE-STORE-LAZY (`registerLazyStore` in its own file).
  stores: [],
  slots: {
    // Admin sidebar entry — hidden for users without the read permission.
    settingsAdminPages: [
      {
        id: 'workstore',
        icon: <HardDrive />,
        label: 'Workstore',
        path: 'workstore',
        order: 43,
        permission: Permissions.WorkstoreSettingsRead,
      },
    ],
  },
})
