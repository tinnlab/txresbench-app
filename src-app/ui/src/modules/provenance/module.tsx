import { GitBranch } from 'lucide-react'
import { createModule } from '@txresbench/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: registers `provenance.record-selection` — the save-path
// `call_action` target a processor's declared commit step invokes, and the real
// production caller `Provenance.recordCapture` never had (ITEM-13, DEC-2).
import './actions'
// Side-effect import: registers `provenance.updateSettings` (#49) so the settings save is
// drivable by the palette + AI, not only the inline form save.
import '@/core/actions/builtin/provenanceSettingsActions'

// Reproducibility is surfaced as the workbench's graph-centric Provenance pane (see
// `workbench/core/shell/dock/panes.tsx` → `ProvenancePane`), which reuses this module's store +
// `project-extension/components` (ExportDrawer / ReadinessChecklist). There is no longer a
// provenance `detail_panels` project-extension — the old section panel was retired.

const ProvenanceSettingsPage = lazyWithPreload(() => import('./ProvenanceSettingsPage'))

export default createModule({
  metadata: {
    name: 'provenance',
    version: '1.0.0',
    description: 'Reproducibility / provenance: project run trust-view, export, and admin settings',
  },
  dependencies: ['router', 'project'],
  routes: [
    {
      path: '/settings/provenance',
      element: ProvenanceSettingsPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly.
      permission: Permissions.ProvenanceSettingsRead,
    },
  ],
  // ProvenanceSettings + ProvenanceExport are WHOLE-STORE-LAZY
  // (`registerLazyStore` in their own files) and are reached only from the admin
  // settings page / export drawer, so they must NOT be imported here.
  // `Provenance` is WHOLE-STORE-LAZY (`registerLazyStore` in its own file) and
  // is reached through the workbench provenance pane / `./actions`, both of
  // which import the handle directly.
  stores: [],
  slots: {
    // Admin sidebar entry — hidden for users without the read permission.
    settingsAdminPages: [
      {
        id: 'provenance',
        icon: <GitBranch />,
        label: 'Provenance',
        path: 'provenance',
        order: 40,
        permission: Permissions.ProvenanceSettingsRead,
      },
    ],
  },
})
