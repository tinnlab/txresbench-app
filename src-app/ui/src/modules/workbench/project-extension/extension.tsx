import { LayoutDashboard } from 'lucide-react'
import { projectExtensionRegistry } from '@/modules/project/core/extensions'
import { WorkbenchSection } from './WorkbenchSection'

/**
 * The workbench project-extension (ITEM-14) — adds a full-bleed "Workspace" section
 * (the P6 analysis IDE shell) to a project: a `project_nav` entry + a `detail_panels`
 * panel marked `fullBleed`, so the project shell renders NO chrome and this panel owns
 * the whole viewport (not merely "drops max-width + padding" — see the `fullBleed`
 * doc on `ProjectDetailPanelContribution`). Because this is also the ONLY `project_nav`
 * entry in the tree, EVERY reachable project URL is full-bleed and the shell's header /
 * section nav render nowhere; project identity is surfaced by `WorkbenchShell`'s own
 * header and project actions by the projects-list card ⋮ menu.
 * Auto-discovered by `project/extensions/index.ts`'s per-module
 * `project-extension/extension.tsx` glob — ZERO project-core registration edits,
 * mirroring the provenance / workstore / dataset extensions.
 *
 * NO `permission` field: the Workspace is visible to every project member; the shell
 * gates every WRITE on `canEdit` (a Viewer gets a fully-rendered, read-only IDE).
 */
projectExtensionRegistry.register({
  name: 'workbench',
  slots: {
    // order 5 → the FIRST nav entry, so it is the DEFAULT section: landing on a project
    // (`/projects/:id`) redirects to the full-bleed Workspace (the workbench IS the page).
    project_nav: [
      {
        id: 'workspace',
        section: 'workspace',
        label: 'Workspace',
        icon: <LayoutDashboard />,
        order: 5,
      },
    ],
    detail_panels: [
      {
        id: 'workspace',
        section: 'workspace',
        component: WorkbenchSection,
        fullBleed: true,
        order: 5,
      },
    ],
  },
})

// Default export satisfies the glob's import contract.
export default {}
