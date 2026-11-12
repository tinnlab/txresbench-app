import type { StoreProxy } from '@txresbench/framework/stores'
import type { useAppLayoutStore } from '@/modules/layouts/app-layout/AppLayout.store'
// Sidebar SLOT types + their `Slots` declaration-merge now come from
// @txresbench/shell (B-1). The side-effect import activates the augmentation; the
// re-export keeps every existing `@/modules/layouts/app-layout/types` (and
// `.../app-layout`) importer working unchanged.
import '@txresbench/shell/layouts/appLayoutSlots'

// AppLayout STORE registration (app-owned — the shell reads this store through
// a typed seam, never its concrete type).
declare module '@txresbench/framework/stores' {
  interface RegisteredStores {
    AppLayout: StoreProxy<ReturnType<typeof useAppLayoutStore.getState>>
  }
}

export type {
  SidebarNavItem,
  SidebarToolItem,
  SidebarActionItem,
  SidebarWidgetItem,
} from '@txresbench/shell'

// App-side augmentation: a tools-group entry may open a drawer (or run any
// action) instead of navigating to `path`. Mirrors `SidebarActionItem.onClick`;
// `LeftSidebar.handleToolsMenuClick` runs `onClick` when present, else navigates
// to `path`. Logged as an SDK_GAP (the shell should carry `onClick` on
// `SidebarToolItem` natively). Declaration-merged onto the shell interface so no
// SDK edit is needed.
declare module '@txresbench/shell/layouts/appLayoutSlots' {
  interface SidebarToolItem {
    /** When set, the tools entry runs this instead of navigating to `path`. */
    onClick?: () => void
  }
}

// App-side NEW slot (A4 DEC-5): the sidebar HEADER region, rendered at the very
// top of `LeftSidebar` (just under `SidebarHeaderSpacer`) — where the account
// switcher lives (the GitHub/Clerk chrome position). Same widget shape +
// permission-filter semantics as `sidebarContent`/`sidebarBottom`. Declaration-
// merged onto the module-system `Slots` interface (mirrors how the shell declares
// the other sidebar slots) so no SDK edit is needed to add the key.
declare module '@txresbench/framework/module-system/types' {
  interface Slots {
    /** Sidebar header-region widgets (the account switcher). */
    sidebarHeader: import('@txresbench/shell').SidebarWidgetItem[]
  }
}
