// SessionRestoreDialog (ITEM-18) — the reload-gated restore choice. A reloaded session whose
// panes were docked in popup windows can't reopen those windows automatically (`window.open` needs
// a gesture), so `WorkbenchDock.store.ensureProject` lists them in `pendingRestore` and the main
// shell shows this dialog: MERGE the popup panes back into the main window, or REOPEN their windows
// (this click IS the gesture). Reopen is best-effort per window; only the ones that actually opened
// are drained (a blocked one stays pending for a retry / merge — nothing is lost).

import { useStore } from 'zustand'
import { Button, Dialog } from '@ziee/kit'
import { workbenchDockStore } from './WorkbenchDock.store'
import { reopenRestoredWindows } from './popout'

export function SessionRestoreDialog() {
  const pendingRestore = useStore(workbenchDockStore, s => s.pendingRestore)
  if (pendingRestore.length === 0) return null
  const count = pendingRestore.length

  const merge = () => workbenchDockStore.getState().mergeRestoredToMain()
  const reopen = () => {
    const opened = reopenRestoredWindows(pendingRestore)
    workbenchDockStore.getState().resolveRestored(opened)
  }

  return (
    <Dialog
      open
      // Non-dismissable: both actions resolve the pending restore (no bare close), so the
      // restored panes never stay orphaned/invisible. An outside/Escape close is a no-op.
      onOpenChange={() => {}}
      title="Restore your layout"
      description={`This session had ${count} pop-out ${count === 1 ? 'window' : 'windows'}. Reopen ${
        count === 1 ? 'it' : 'them'
      }, or merge those panes back into the main window.`}
      data-testid="workbench-restore-dialog"
      footer={
        <>
          <Button variant="outline" onClick={merge} data-testid="workbench-restore-merge">
            Merge to main
          </Button>
          <Button variant="default" onClick={reopen} data-testid="workbench-restore-reopen">
            {count === 1 ? 'Reopen window' : `Reopen ${count} windows`}
          </Button>
        </>
      }
    />
  )
}
