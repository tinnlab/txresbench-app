// statusBarItems — the built-in status-bar indicators, registered into the ninth
// contribution registry (`workbenchRegistry.statusBarItems`) so an analysis/extension can
// contribute its OWN indicator the same way (register a zero-prop component with a
// `side`/`order`) instead of editing the status bar. The shell renders whatever is
// registered (`WorkbenchStatusBar`). These built-ins are the first registrants: project,
// datasets, produced-types, running-jobs, connection. (ITEM-9 removed the SELECTION
// indicator with the workbench selection feature — it could only ever read `false`.)
//
// Each item is a self-contained component reading its own live signal (a global store,
// the workbench context, a project-scoped local store, or `navigator.onLine`) — so the
// status bar itself is a dumb renderer.

import { useEffect, useState } from 'react'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import {
  workbenchRegistry,
  WORKBENCH_API_VERSION,
  type StatusBarItemContribution,
  type StatusBarSide,
} from '@/modules/workbench/core'
import { Activity, Database, FlaskConical, Layers, Wifi, WifiOff } from 'lucide-react'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { SHELL_EXTENSION_ID } from '../host/createHost'
import { revealPane } from './regions/openPane'
import { useWorkbench } from './WorkbenchContext'
import { StatusBarJobsStore } from './statusBarJobsStore'

function ProjectStatusItem() {
  const { project } = ProjectDetail
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-foreground" data-testid="statusbar-project">
      <FlaskConical aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{project?.name ?? 'Workbench'}</span>
    </span>
  )
}

function DatasetsStatusItem() {
  const { datasetsTotal } = ProjectDetail
  return (
    <span className="flex items-center gap-1" data-testid="statusbar-datasets">
      <Database aria-hidden className="size-3" />
      {datasetsTotal} dataset{datasetsTotal === 1 ? '' : 's'}
    </span>
  )
}

function DataTypesStatusItem() {
  const { producedTypeIds } = useWorkbench()
  const count = producedTypeIds.length
  if (count === 0) return null
  return (
    <span className="flex items-center gap-1" data-testid="statusbar-types">
      <Layers aria-hidden className="size-3" />
      {count} data type{count === 1 ? '' : 's'}
    </span>
  )
}

/** Running-jobs indicator — the live count of the project's running jobs; clicking opens
 *  (reveals) the Jobs pane in its home/effective region. Persistent affordance: shows
 *  "N running" (emphasized, pulsing) while work is in flight, else a quiet "Jobs" opener.
 *  Hidden entirely for a user WITHOUT `jobs::use` (the pane it opens is gated by it). */
function RunningJobsStatusItem() {
  const { projectId } = useWorkbench()
  const canUseJobs = usePermission(Permissions.JobsUse)
  const store = StatusBarJobsStore.use({ projectId })
  const { running } = store
  // Bind/re-bind the store to the CURRENT project — the shell (and this bar) stays mounted
  // across an in-place project switch, so binding must react to `projectId`, not be a
  // one-shot at mount. Liveness after binding is the store's `sync:job` subscription (no poll).
  // Gated on the perm + a real project so nothing fetches otherwise.
  useEffect(() => {
    if (canUseJobs && projectId) store.start(projectId)
  }, [projectId, canUseJobs, store])
  if (!canUseJobs) return null
  const active = running > 0
  return (
    <button
      type="button"
      onClick={() => revealPane('jobs')}
      data-testid="statusbar-jobs"
      data-running={active ? 'true' : 'false'}
      title={active ? `${running} running job${running === 1 ? '' : 's'} — open Jobs` : 'Open Jobs'}
      className={`flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-accent-foreground ${
        active ? 'text-foreground' : ''
      }`}
    >
      <Activity aria-hidden className={`size-3 ${active ? 'animate-pulse text-primary' : ''}`} />
      {active ? `${running} running` : 'Jobs'}
    </button>
  )
}

function ConnectionStatusItem() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return (
    <span className="flex items-center gap-1" data-testid="statusbar-connection" data-online={online ? 'true' : 'false'}>
      {online ? (
        <>
          <Wifi aria-hidden className="size-3 text-success" /> Online
        </>
      ) : (
        <>
          <WifiOff aria-hidden className="size-3 text-destructive" /> Offline
        </>
      )}
    </span>
  )
}

function item(
  id: string,
  title: string,
  render: StatusBarItemContribution['render'],
  side: StatusBarSide,
  order: number,
): StatusBarItemContribution {
  return { id, extensionId: SHELL_EXTENSION_ID, apiVersion: WORKBENCH_API_VERSION, title, render, side, order }
}

let done = false

/** Register the built-in status-bar items (idempotent). Called at app boot + gallery/shell
 *  mount (mirrors `registerBuiltinShellViews`). */
export function registerBuiltinStatusItems(): void {
  if (done) return
  done = true
  const items: StatusBarItemContribution[] = [
    item('workbench.status.project', 'Project', ProjectStatusItem, 'start', 0),
    item('workbench.status.datasets', 'Datasets', DatasetsStatusItem, 'start', 10),
    item('workbench.status.types', 'Data types', DataTypesStatusItem, 'start', 20),
    item('workbench.status.jobs', 'Running jobs', RunningJobsStatusItem, 'end', 10),
    item('workbench.status.connection', 'Connection', ConnectionStatusItem, 'end', 20),
  ]
  for (const it of items) {
    if (!workbenchRegistry.statusBarItems.get(it.id)) workbenchRegistry.statusBarItems.register(it)
  }
}
