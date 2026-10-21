import { Database } from 'lucide-react'
import { Permissions } from '@/api-client/permissions'
import { createModule } from '@ziee/framework'
import { AppLayoutDef } from '@/modules/layouts/app-layout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import { RecentDatasetsWidget } from '@/modules/datasets/widgets/RecentDatasetsWidget'

const DatasetsLibraryPage = lazyWithPreload(() =>
  import('./pages/DatasetsLibraryPage').then(m => ({ default: m.DatasetsLibraryPage })),
)
const DatasetDetailPage = lazyWithPreload(() =>
  import('./pages/DatasetDetailPage').then(m => ({ default: m.DatasetDetailPage })),
)

// Datasets reuse `projects::use` for authorization (owner + `dataset_shares`, no
// new global permission — DEC-23); every dataset REST endpoint gates on it.
export default createModule({
  metadata: {
    name: 'datasets',
    version: '1.0.0',
    description: 'Datasets — the user-owned data library, processing pipeline, and lineage.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/datasets',
      element: DatasetsLibraryPage,
      requiresAuth: true,
      permission: Permissions.ProjectsUse,
      layout: AppLayoutDef,
    },
    {
      path: '/datasets/:id',
      element: DatasetDetailPage,
      requiresAuth: true,
      permission: Permissions.ProjectsUse,
      layout: AppLayoutDef,
    },
  ],
  // Both dataset stores are WHOLE-STORE-LAZY (`registerLazyStore` in their own
  // files). Dual-listing them here is SAFE (the module system's `selfOwnedStores`
  // set reuses the self-registered proxy rather than building a second,
  // independently ref-counted one) but POINTLESS — it only re-adds an eager
  // module.tsx -> store import.
  stores: [],
  slots: {
    sidebarNavigation: [
      {
        id: 'datasets',
        icon: <Database />,
        label: 'Datasets',
        path: '/datasets',
        order: 5,
        permission: Permissions.ProjectsUse,
      },
    ],
    sidebarContent: [
      {
        id: 'recent-datasets',
        component: RecentDatasetsWidget,
        order: 5,
        permission: Permissions.ProjectsUse,
      },
    ],
  },
})
