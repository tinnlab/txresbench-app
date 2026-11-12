// PlacedArea (ITEM-55) — the ONE dock-region body: it renders `placeViews(registry, area)`
// for ANY area (center / left / right / bottom), so extensions contribute tabs/panes into
// any dock, not just bottom. Replaces the hardcoded region→component map (the desktop pane
// renderers + the mobile `dockBody` switch both delegate here). A single placed view
// renders bare (the pane frame already supplies the title); multiple placed views render as
// quiet underline tabs (dense-container discipline). The persisted active tab per area
// survives reload via the layout store.
//
// The `center` area is the HERO: its single view renders chrome-less + full-bleed (no tab
// strip, no header) — canvas-hero discipline (IA §4.5.3).

import { Empty, Tabs } from '@txresbench/kit'
import { WorkbenchLayout } from '@/modules/workbench/core/shell/stores/WorkbenchLayout.store'
import type { DockArea } from './types'
import { useCurrentLayout } from './stores/WorkbenchLayout.store'
import { useWhenContext, useWorkbench } from './WorkbenchContext'
import { placeViews } from './placement'
import { ViewHost } from './ViewHost'

export function PlacedArea({ area }: { area: DockArea }) {
  const { api, lattice } = useWorkbench()
  const whenCtx = useWhenContext()
  const views = placeViews(api.registry, area, whenCtx, lattice)
  const persistedTab = useCurrentLayout().activeTab[area]

  if (views.length === 0) {
    return (
      <div data-testid={`workbench-area-${area}-empty`} className="flex min-h-0 flex-1 items-center justify-center">
        <Empty
          data-testid={`workbench-area-empty-${area}`}
          title="Nothing here yet"
          description="No panels are contributed to this area for the current project."
        />
      </div>
    )
  }

  // Single view → render bare (center = the hero; L/R/bottom = the pane frame owns the title).
  if (views.length === 1) {
    return (
      <div data-testid={`workbench-area-${area}`} className="flex min-h-0 flex-1 flex-col">
        <ViewHost view={views[0]} chrome={false} />
      </div>
    )
  }

  // Multiple views → quiet underline tabs (the tab label IS each view's title).
  const active = persistedTab && views.some(v => v.id === persistedTab) ? persistedTab : views[0].id
  return (
    <div data-testid={`workbench-area-${area}`} className="flex min-h-0 flex-1 flex-col">
      <Tabs
        variant="line"
        fill
        value={active}
        onValueChange={t => WorkbenchLayout.setActiveTab(area, t)}
        data-testid={`workbench-area-tabs-${area}`}
        items={views.map(v => ({
          key: v.id,
          label: v.title,
          // NO flex-column wrapper here, deliberately — there was one, and it is gone because
          // the kit fixed the cause. The `fill` tab panel used to be `flex-1 min-h-0
          // overflow-hidden`: bounded and clipping, but a BLOCK, under which `ViewHost`'s own
          // `min-h-0 flex-1` (and the whole pane below it) was inert, so the pane sized to its
          // content and the panel's `overflow-hidden` swallowed the excess. An `h-full flex
          // flex-col` wrapper here restored a track for THIS caller and left every other
          // `Tabs fill` consumer clipping. The panel is now a flex column itself (kit
          // `tabs.tsx`, pinned by `tabs-fill-panel.test.tsx`), so `ViewHost`'s `flex-1`
          // resolves against it directly and the wrapper would only re-state it.
          children: <ViewHost view={v} chrome={false} />,
        }))}
      />
    </div>
  )
}
