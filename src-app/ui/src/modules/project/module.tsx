import { FlaskConical, Settings2 } from 'lucide-react'
import { Permissions } from '@/api-client/permissions'
import { createModule } from '@txresbench/framework'
import { isDesktop } from '@/core/platform'
import { AppLayoutDef } from '@/modules/layouts/app-layout'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import { registerProjectNotificationKinds } from '@/modules/project/notifications'
import { RecentProjectsWidget } from '@/modules/project/widgets/RecentProjectsWidget'
import '@/modules/project/extensions' // auto-discover project extensions (glob; supersedes the former projectCardTags slot)
import '@/modules/settings/types/SettingsSlots' // settingsAdminPages slot type

const ProjectsPage = lazyWithPreload(() =>
  import('./pages/ProjectsPage').then(m => ({ default: m.ProjectsPage })),
)
const ProjectDetailPage = lazyWithPreload(() =>
  import('./pages/ProjectDetailPage').then(m => ({ default: m.ProjectDetailPage })),
)
const ProjectAdminPage = lazyWithPreload(() =>
  import('./pages/ProjectAdminPage').then(m => ({ default: m.ProjectAdminPage })),
)

// Sharing / transfer / the admin transfer toggle are WEB-ONLY (desktop is
// single-user). Projects + datasets + the card work on both.
const web = !isDesktop()

export default createModule({
  metadata: {
    name: 'project',
    version: '1.0.0',
    description: 'Projects — the top-level grouping of datasets and analyses.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/projects',
      element: ProjectsPage,
      requiresAuth: true,
      permission: Permissions.ProjectsUse,
      layout: AppLayoutDef,
    },
    {
      path: '/projects/:id',
      element: ProjectDetailPage,
      requiresAuth: true,
      permission: Permissions.ProjectsUse,
      layout: AppLayoutDef,
    },
    {
      // The project detail shell keys its active section off `:section`
      // (`/projects/:id/:section`), driven by the project_nav / detail_panels slots.
      path: '/projects/:id/:section',
      element: ProjectDetailPage,
      requiresAuth: true,
      permission: Permissions.ProjectsUse,
      layout: AppLayoutDef,
    },
    // The admin cross-user project-management page is web-only (desktop is
    // single-user). It also folds in the deployment transfer-toggle card.
    ...(web
      ? [
          {
            path: '/settings/projects',
            element: ProjectAdminPage,
            requiresAuth: true,
            permission: Permissions.ProjectAdminRead,
            layout: SettingsLayoutDef,
          },
        ]
      : []),
  ],
  // All six project stores are WHOLE-STORE-LAZY (`registerLazyStore` in their
  // own files); the chunk of whatever page/widget imports the handle is what
  // pulls each in. Dual-listing here is safe but only re-adds an eager import.
  stores: [],
  slots: {
    sidebarNavigation: [
      {
        id: 'project',
        icon: <FlaskConical />,
        label: 'Projects',
        path: '/projects',
        order: 10,
        permission: Permissions.ProjectsUse,
      },
    ],
    // Expandable recent-projects feed with per-project extension nav.
    sidebarContent: [
      {
        id: 'recent-projects',
        component: RecentProjectsWidget,
        order: 10,
        permission: Permissions.ProjectsUse,
      },
    ],
    // Admin transfer settings — web-only.
    ...(web
      ? {
          settingsAdminPages: [
            {
              id: 'projects',
              icon: <Settings2 />,
              label: 'Projects',
              path: 'projects',
              order: 20,
              permission: Permissions.ProjectAdminRead,
            },
          ],
        }
      : {}),
  },
  initialize: () => {
    // Contribute the project notification kinds through the SDK renderer seam.
    registerProjectNotificationKinds()
  },
})
