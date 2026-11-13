import { Seam } from '@txresbench/framework/overrides'
import { titleBarHeightFor, useWindowChrome, windowDragRegionAttr } from '@txresbench/shell'

/**
 * Top spacer in the LeftSidebar that clears the area covered by
 * SidebarToggleButton (fixed-positioned over the top 50px) — and, in the
 * macOS desktop window, the traffic lights.
 *
 * A plain 50px-tall div. In the macOS desktop window (the enclosing
 * AppLayout's `windowChrome`) it is the window's title bar over the sidebar:
 * the title bar's height (56, the traffic lights are centred on it), and
 * Tauri's drag script moves the window from it and a double-click zooms.
 * Still a `<Seam>`, so a build can replace the element
 * (`layout.sidebar-header-spacer`); none does today.
 */
declare module '@txresbench/framework/overrides' {
  interface UIOverrides {
    'layout.sidebar-header-spacer': Record<string, never>
  }
}

export function SidebarHeaderSpacer() {
  const windowChrome = useWindowChrome()
  return (
    <Seam id="layout.sidebar-header-spacer">
      <div
        className="h-[50px] flex-shrink-0"
        data-testid="layout-sidebar-header-spacer"
        data-tauri-drag-region={windowDragRegionAttr(windowChrome)}
        style={windowChrome ? { height: titleBarHeightFor(windowChrome) } : undefined}
      />
    </Seam>
  )
}
