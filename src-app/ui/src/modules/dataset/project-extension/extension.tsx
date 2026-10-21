import { projectExtensionRegistry } from '@/modules/project/core/extensions'
import { DatasetsCardTag } from './components/DatasetsCardTag'
import { DatasetsPanel } from './components/DatasetsPanel'

/**
 * The dataset project-extension. Datasets is now a workbench PANE (the project detail page is the
 * full-bleed workbench, not a sectioned shell), so this registers NO `project_nav` section — only the
 * `detail_panels` panel (looked up + rendered as the `datasets` pane by `workbench/core/shell/dock/panes.tsx`'s
 * `SectionPane`) and the `card_tags` tag ("N datasets"). Auto-discovered by `project/extensions/index.ts`.
 */
projectExtensionRegistry.register({
  name: 'dataset',
  slots: {
    detail_panels: [
      {
        id: 'datasets',
        section: 'datasets',
        component: DatasetsPanel,
        order: 10,
      },
    ],
    card_tags: [
      {
        id: 'datasets',
        render: project => <DatasetsCardTag project={project} />,
        order: 10,
      },
    ],
  },
})

// Default export satisfies the glob's import contract.
export default {}
