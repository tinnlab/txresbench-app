import { Box } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: registers `sandbox.updateSettings` (#49) so the resource-limits
// save is drivable by the palette + AI, not only the inline form save.
import '@/core/actions/builtin/sandboxSettingsActions'

const SandboxSettingsPage = lazyWithPreload(() => import('./SandboxSettingsPage'))

export default createModule({
  metadata: {
    name: 'sandbox',
    version: '1.0.0',
    description: 'Analysis sandbox settings (resource limits + rootfs status)',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/sandbox',
      element: SandboxSettingsPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly.
      permission: Permissions.SandboxSettingsRead,
    },
  ],
  // Both sandbox stores are WHOLE-STORE-LAZY (`registerLazyStore` in their own
  // files); listing them here would re-add an eager module.tsx -> store import.
  stores: [],
  slots: {
    // Admin sidebar entry — hidden for users without the read permission.
    settingsAdminPages: [
      {
        id: 'sandbox',
        icon: <Box />,
        label: 'Sandbox',
        path: 'sandbox',
        order: 30,
        permission: Permissions.SandboxSettingsRead,
      },
    ],
  },
})
