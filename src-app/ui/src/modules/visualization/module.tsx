// module.tsx — the visualization module registration (adapter layer). Adds a
// top-level nav entry + route to the ALL-GPU deck.gl visualization workspace. Round-1
// gates on auth only (no new permission — DEC-9); the page renders the fixture
// DataSource. `viz-core` stays framework-agnostic; this file is the ziee binding.

import { createModule } from '@ziee/framework'
import { LineChart } from 'lucide-react'
import { AppLayoutDef } from '@/modules/layouts/app-layout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
// Import the (lightweight, framework-agnostic) stores from the `core` subpath, NOT
// the `@ziee/viz` barrel — the barrel re-exports the deck.gl React layer, so a
// barrel import here (this module.tsx is eager-registered at boot by
// `modules/loader.ts`) drags deck.gl (~380 KB gz) into the initial bundle for EVERY
// route. `@ziee/viz/core` carries only the zustand stores; deck.gl loads lazily with
// the VisualizationPage. See .lifecycle/datasets-page (ITEM-2).
import { useCoordinationStore, useGridWorkspaceStore } from '@ziee/viz/core'
import './types'

const VisualizationPage = lazyWithPreload(() =>
  import('./adapter/VisualizationPage').then(m => ({ default: m.VisualizationPage })),
)

export default createModule({
  metadata: {
    name: 'visualization',
    version: '1.0.0',
    description: 'All-GPU deck.gl visualization workspace (scatter, spatial, charts, grid).',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/visualization',
      element: VisualizationPage,
      requiresAuth: true,
      layout: AppLayoutDef,
    },
  ],
  stores: [
    { name: 'Coordination', store: useCoordinationStore },
    { name: 'GridWorkspace', store: useGridWorkspaceStore },
  ],
  slots: {
    sidebarNavigation: [
      {
        id: 'visualization',
        icon: <LineChart />,
        label: 'Visualization',
        path: '/visualization',
        order: 20,
      },
    ],
  },
})
