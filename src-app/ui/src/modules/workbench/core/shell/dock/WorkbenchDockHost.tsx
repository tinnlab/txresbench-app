// WorkbenchDockHost — the dock frame the shell mounts: the MAIN container rendered via
// `ContainerRenderer`, the popup windows via `WorkbenchWindows`, the reload-gated
// `SessionRestoreDialog`, and the contributed-view reconciliation (ITEM-12). Binds this project's
// dock layout on mount (`ensureProject`, per-project localStorage restore). Replaces the P6
// fixed L/R/bottom/center dock regions — every surface is now a movable pane.

import { useEffect, useState } from 'react'
import { useWhenContext, useWorkbench } from '../WorkbenchContext'
import { workbenchDockStore } from './WorkbenchDock.store'
import { RegionShell } from '@/modules/workbench/core/shell/regions/RegionShell'
import { RegionPopoutWindows } from '@/modules/workbench/core/shell/regions/RegionPopoutWindows'
import { SessionRestoreDialog } from './SessionRestoreDialog'
import { useViewReconciliation } from './paneReconcile'
import { useEntitySelfClose } from './entityLifecycle'
import './panes' // register the real pane-kind renderers (import side-effect)

export function WorkbenchDockHost() {
  const { api, projectId, lattice } = useWorkbench()
  const whenCtx = useWhenContext()

  // Bind this project's dock layout (per-project localStorage; popups per-tab sessionStorage,
  // reload-gated). Switching projects swaps the whole workspace.
  //
  // SYNCHRONOUS first bind (before this component returns its JSX, so BEFORE `ContainerRenderer`
  // mounts): react-resizable-panels latches each panel's size from `defaultSize` at MOUNT and
  // ignores later `defaultSize` changes, so binding in the effect below (which runs AFTER the
  // first render) would mount the panels at the DEFAULT sizes and never apply the persisted
  // divider positions on a reload. Binding here also means `useViewReconciliation` reads the
  // HYDRATED cells on its first pass — so restored `view` panes are recognised (not re-added as
  // duplicates). The lazy `useState` initialiser runs exactly once, on mount; the effect below
  // covers a later `projectId` change. `ensureProject` is idempotent (no-op when already bound).
  useState(() => {
    if (workbenchDockStore.getState().activeProjectId !== projectId) {
      workbenchDockStore.getState().ensureProject(projectId)
    }
    return null
  })
  useEffect(() => {
    workbenchDockStore.getState().ensureProject(projectId)
  }, [projectId])

  // Reconcile contributed views ↔ panes (mount on availability, self-close on loss).
  useViewReconciliation(api.registry, whenCtx, lattice)
  // Self-close entity-bound panes when their entity is deleted (local + sync/SSE).
  useEntitySelfClose(api)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="workbench-dock-host">
      <RegionShell />
      <RegionPopoutWindows />
      <SessionRestoreDialog />
    </div>
  )
}
