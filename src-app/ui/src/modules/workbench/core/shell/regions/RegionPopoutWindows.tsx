// RegionPopoutWindows — renders every popped-out pane (workbenchRegionsStore.poppedOut) into its own
// OS window via `@ziee/dock`'s `ContainerWindows` (which portals content into the registered popup
// window + reports OS/close). Each popped pane fills its window BARE (no tab/region chrome) and the
// window's title = the pane title; closing the window un-pops the pane (back to its region). The pane
// content renders through the SAME React tree, so `useWorkbench()` context is preserved in the popup.

import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { ContainerWindows, closePopupWindow, getPopupWindow, type ContainerId } from '@ziee/dock'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { resolvePaneRenderer, paneTitle, usePaneSubjectEpoch } from '@/modules/workbench/core/shell/dock/paneModel'
import { workbenchRegionsStore } from './WorkbenchRegions.store'

function paneIdForContainer(poppedOut: Record<string, string>, containerId: string): string | undefined {
  return Object.keys(poppedOut).find(id => poppedOut[id] === containerId)
}

function PoppedPane({ containerId }: { containerId: ContainerId }) {
  // THE WINDOW TITLE IS A PANE TITLE, AND A PANE TITLE ARRIVES.
  //
  // Since `27b19e86` `paneTitle` is not a pure function of the pane map: a `jobs` pane is opened
  // with a job ID and learns the job's NAME on a later fetch, announced through
  // `notifyPaneSubjectsChanged`. The two in-shell readers (`RegionShell`, `PaneBody`) subscribe;
  // this one did not, so a pane popped out before its name landed kept a window titled "Jobs"
  // for the life of the window while the same pane's tab read "Jobs · Nightly filter". The
  // effect below depends on `title`, and `title` could not change.
  //
  // A third window on the same seam, not a special case: one subscription per component that
  // DRAWS a title.
  usePaneSubjectEpoch()
  const poppedOut = useStore(workbenchRegionsStore, s => s.poppedOut)
  const paneId = paneIdForContainer(poppedOut, containerId)
  const pane = useStore(workbenchDockStore, s => (paneId ? s.cells[paneId] : undefined))
  const title = pane ? paneTitle(pane) : ''

  useEffect(() => {
    const win = getPopupWindow(containerId)
    if (win && !win.closed && title) {
      try {
        win.document.title = title
      } catch {
        /* window torn down */
      }
    }
  }, [containerId, title])

  if (!pane) return null
  const Renderer = resolvePaneRenderer(pane.kind)
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
      data-pane-popout="true"
      data-testid={`region-popout-pane-${pane.id}`}
    >
      <Renderer pane={pane} />
    </div>
  )
}

export function RegionPopoutWindows() {
  const poppedOut = useStore(workbenchRegionsStore, s => s.poppedOut)
  const containers = Object.values(poppedOut) as ContainerId[]

  // Close the OS window of any pane that left `poppedOut` by a NON-window path — its pane was
  // removed from cells (entity self-close / view reconciliation / an action's removePane → the
  // RegionShell reconcilePanes effect prunes poppedOut) or a project switch reset the store. The
  // user-initiated OS/Return close is handled by onWindowClosed; without this, ContainerWindows
  // just unmounts the portal and leaves a blank orphaned window + a leaked popupWindowRegistry ref.
  const prev = useRef<ContainerId[]>([])
  useEffect(() => {
    for (const id of prev.current) if (!containers.includes(id)) closePopupWindow(id)
    prev.current = containers
  }, [containers.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  // Host teardown (navigate away / logout → WorkbenchDockHost unmounts): close every popup so none
  // outlives the workbench, orphaned + registered forever (parity with the removed WorkbenchWindows).
  useEffect(
    () => () => {
      for (const id of Object.values(workbenchRegionsStore.getState().poppedOut) as ContainerId[])
        closePopupWindow(id)
    },
    [],
  )

  return (
    <ContainerWindows
      containers={containers}
      renderContainer={id => <PoppedPane containerId={id} />}
      onWindowClosed={id => {
        const pid = paneIdForContainer(workbenchRegionsStore.getState().poppedOut, id)
        if (pid) workbenchRegionsStore.getState().unpop(pid)
        closePopupWindow(id)
      }}
      pendingClose={[]}
      onAcknowledgeClose={() => {}}
    />
  )
}
