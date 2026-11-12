import { ToggleLeft } from 'lucide-react'
import { createModule } from '@txresbench/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // register settings slot types
// Side-effect import: registers the `features.setGlobalFlag` defineAction into the
// global registry — the SOLE runtime import site (#48, mirrors admin-accounts).
import '@/core/actions/builtin/featureFlagActions'

const FeatureFlagsPage = lazyWithPreload(() =>
  import('./pages/FeatureFlagsPage').then(m => ({ default: m.FeatureFlagsPage })),
)

export default createModule({
  metadata: {
    name: 'features',
    version: '1.0.0',
    description: 'Runtime feature flags — global defaults + per-account overrides (#40).',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/feature-flags',
      element: FeatureFlagsPage,
      requiresAuth: true,
      permission: Permissions.FeaturesManage,
      layout: SettingsLayoutDef,
    },
  ],
  stores: [],
  slots: {
    // Admin Feature Flags page in the settings nav. Gated by the SAME permission as
    // the route (PERMISSION_GATING.md §3 — a gated slot linking to a route sets the
    // permission in both places).
    settingsAdminPages: [
      {
        id: 'feature-flags',
        icon: <ToggleLeft />,
        label: 'Feature Flags',
        path: 'feature-flags',
        order: 35,
        permission: Permissions.FeaturesManage,
      },
    ],
  },
  initialize: () => {},
})
