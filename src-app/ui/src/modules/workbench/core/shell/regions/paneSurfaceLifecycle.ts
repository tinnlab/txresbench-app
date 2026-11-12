// paneSurfaceLifecycle — the two SHELL operations `paneSurfaceHost.ts` drives, bound to the real
// dock + regions stores. Split out only to keep that module free of the store graph: it is
// re-exported by the public barrel, which must stay loadable under the `node:test` strip-types
// runner, and the dock store reaches `@txresbench/dock`'s `ContainerWindows.tsx` (see that module's
// port note). Installed by `panes.tsx` at boot, beside the renderer registration.

import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { clearPaneState } from '@/modules/workbench/core/shell/dock/paneState'
import { installSurfacePaneLifecycle } from './paneSurfaceHost'
import { revealPane } from './openPane'

export function installShellSurfacePaneLifecycle(): void {
  installSurfacePaneLifecycle({
    // `revealPane` is the shell's own idempotent open: it focuses an existing pane of this kind
    // + ref rather than opening a second, which is exactly the per-surface identity this needs.
    open: (kind, surfaceId) => revealPane(kind, surfaceId),
    close: paneId => {
      if (workbenchDockStore.getState().removePane(paneId)) clearPaneState(paneId)
    },
  })
}
