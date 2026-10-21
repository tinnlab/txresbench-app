// revealPane — idempotently reveal a workbench pane of `kind` from an affordance OUTSIDE
// the workbench instance (the status bar, a widget): focus an existing pane of that kind
// (else add one), then bring its EFFECTIVE region (drag override ?? home) to the front,
// expanding a collapsed side/bottom region. Returns the pane id ('' if the add was
// blocked). Mirrors `WorkbenchSection.openPaneOnce`, but resolves the post-drag region so
// the pane is revealed WHERE IT ACTUALLY LIVES (a jobs pane dragged to the bottom opens in
// the bottom, not its `right` home).

import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import type { PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'
import { regionOfKind } from './regionModel'
import { workbenchRegionsStore } from './WorkbenchRegions.store'

export function revealPane(kind: PaneKind, ref?: string): string {
  const dock = workbenchDockStore.getState()
  const existing = Object.values(dock.cells).find(c => c.kind === kind && (ref === undefined || c.ref === ref))
  const id = existing ? existing.id : dock.requestAddPane(kind, ref)
  if (!id) return ''
  const rs = workbenchRegionsStore.getState()
  const region = rs.regionOverride[id] ?? regionOfKind(kind)
  rs.setActive(region, id)
  if (region !== 'center' && rs.collapsed[region]) rs.toggleCollapse(region)
  return id
}
