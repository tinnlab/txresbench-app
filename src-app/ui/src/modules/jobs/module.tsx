import { ListChecks } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // register settings slot types
import { JobsDrawer as JobsDrawerStore } from './JobsDrawer.store'
import { JobsDrawer } from './components/JobsDrawer'

const JobSettingsPage = lazyWithPreload(() =>
  import('./pages/JobSettingsPage').then(m => ({ default: m.JobSettingsPage })),
)

export default createModule({
  metadata: {
    name: 'jobs',
    version: '1.0.0',
    description: 'Analysis job scheduler — FCFS queue, logs, resource charts, stop.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/jobs',
      element: JobSettingsPage,
      requiresAuth: true,
      permission: Permissions.JobsSettingsRead,
      layout: SettingsLayoutDef,
    },
  ],
  // Both job stores are WHOLE-STORE-LAZY (`registerLazyStore` in their own
  // files). `JobsDrawer` is imported above only because the sidebar-tool slot
  // below opens it directly; `Jobs` rides the drawer/pane chunks that read it.
  stores: [],
  slots: {
    // "Jobs" button ABOVE Settings (order 100). Opens the drawer — NOT a route
    // (`path` is a non-matching sentinel; `onClick` wins in handleToolsMenuClick).
    sidebarTools: [
      {
        id: 'jobs',
        icon: <ListChecks />,
        label: 'Jobs',
        path: '#jobs',
        order: 90,
        permission: Permissions.JobsUse,
        onClick: () => JobsDrawerStore.open(),
      },
    ],
    // Mount the drawer host once, globally (portals to body; renders nothing
    // until opened). Gated to jobs::use holders.
    appBanners: [
      {
        id: 'jobs-drawer-host',
        component: JobsDrawer,
        order: 0,
        permission: Permissions.JobsUse,
      },
    ],
    // Admin concurrency page (available on desktop too — NOT platform-gated).
    settingsAdminPages: [
      {
        id: 'jobs',
        icon: <ListChecks />,
        label: 'Jobs',
        path: 'jobs',
        order: 30,
        permission: Permissions.JobsSettingsRead,
      },
    ],
  },
  initialize: () => {},
})
