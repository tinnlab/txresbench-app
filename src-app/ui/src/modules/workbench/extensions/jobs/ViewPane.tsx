// ViewPane (ITEM-12 host) — a contributed `ViewContribution` rendered as a movable pane. Its
// `ref` is the view id; it resolves the view from the registry and hosts it via `ViewHost` (the
// same named-component resolver the P6 dock tabs used). The reconciliation (mount on availability,
// self-close on loss) lives in `dock/paneReconcile`.

import { Empty } from '@txresbench/kit'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { ViewHost } from '../../core/shell/ViewHost'
import type { WorkbenchPane } from '../../core/shell/dock/paneModel'

export function ViewPane({ pane }: { pane: WorkbenchPane }) {
  const { api } = useWorkbench()
  const view = pane.ref ? api.registry.views.all().find(v => v.id === pane.ref) : undefined
  return (
    <div data-testid={`workbench-view-pane-${pane.id}`} className="flex min-h-0 flex-1 flex-col">
      {view ? (
        // chrome={false}: the PANE FRAME already shows the title — a chromed ViewHost here would render
        // a SECOND title under it (the "double title" waste). The pane owns the title; the view fills.
        <ViewHost view={view} chrome={false} />
      ) : (
        <Empty
          data-testid={`workbench-view-pane-empty-${pane.id}`}
          title="View unavailable"
          description="This contributed view is no longer available for the project."
        />
      )}
    </div>
  )
}
