import { projectExtensionRegistry } from '@/modules/project/core/extensions'
import { ArtifactsPanel } from './components/ArtifactsPanel'

/**
 * The workstore project-extension (P1 · ITEM-11). Artifacts is now a workbench PANE (the project detail
 * page is the full-bleed workbench), so this registers NO `project_nav` section — only the
 * `detail_panels` panel, rendered as the `artifacts` pane by `workbench/core/shell/dock/panes.tsx`'s `SectionPane`.
 * Auto-discovered by `project/extensions/index.ts`'s glob (mirrors the dataset extension).
 */
projectExtensionRegistry.register({
  name: 'workstore',
  slots: {
    detail_panels: [
      {
        id: 'artifacts',
        section: 'artifacts',
        component: ArtifactsPanel,
        order: 20,
      },
    ],
  },
})

// Default export satisfies the glob's import contract.
export default {}
