import { Seam } from '@ziee/framework/overrides'

/**
 * Top spacer in the LeftSidebar that clears the area covered by
 * SidebarToggleButton (fixed-positioned over the top 50px).
 *
 * Core renders a plain 50px-tall div. The desktop adds Tauri window-drag
 * (mousedown → `startDragging`, dblclick → `toggleMaximize`) so the user can
 * drag the window from the empty area above the sidebar nav — a change to this
 * ONE element, so it's a `<Seam>` (not a whole-file shadow): the desktop
 * registers `layout.sidebar-header-spacer`
 * (`desktop/ui/src/modules/desktop-base/overrides/sidebar-header-spacer.tsx`).
 */
declare module '@ziee/framework/overrides' {
  interface UIOverrides {
    'layout.sidebar-header-spacer': Record<string, never>
  }
}

export function SidebarHeaderSpacer() {
  return (
    <Seam id="layout.sidebar-header-spacer">
      <div className="h-[50px] flex-shrink-0" />
    </Seam>
  )
}
