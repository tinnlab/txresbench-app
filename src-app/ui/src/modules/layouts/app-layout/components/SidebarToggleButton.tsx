import { Tooltip, Button } from '@txresbench/kit'
import {
  sidebarToggleLeftFor,
  titleBarHeightFor,
  useWindowChrome,
  windowDragRegionAttr,
} from '@txresbench/shell'
import { PanelLeft, PanelRight } from 'lucide-react'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { cn } from '@/lib/utils'

export function SidebarToggleButton() {
  const { isSidebarCollapsed, nativeScroll, headerHidden } = AppLayout
  // The enclosing AppLayout's host-window chrome (the macOS desktop window:
  // the traffic lights sit over the top-left corner; null elsewhere).
  const windowChrome = useWindowChrome()

  // Single compact size at every breakpoint. The previous
  // responsive flip (44px on xs viewports for WCAG 2.5.5 touch
  // target) caused a jarring "the button looks weird / out of
  // place" jump when the user resized a desktop browser narrow —
  // and on actual touch devices the icon still gets the full
  // hit slop of the surrounding fixed-positioned wrapper.
  const dimension = '28px'
  const iconFontSize = '20px'

  return (
    <div
      data-testid="layout-sidebar-toggle-bar"
      // The macOS desktop window: the wrapper's band around the button is
      // title bar too (the button itself stays a button).
      data-tauri-drag-region={windowDragRegionAttr(windowChrome)}
      className={cn(
        'flex items-center gap-6 mr-4 fixed',
        // z-index depends on whether the left sidebar Sheet is open:
        //  • sidebar OPEN (!collapsed → Sheet showing, z-50): sit ABOVE it
        //    (z-55) so the toggle stays reachable to close the sidebar.
        //  • sidebar COLLAPSED (Sheet closed): drop to z-35 — still above the
        //    z-30 header, but BELOW a right Drawer's z-40 scrim, so an open
        //    right Drawer paints over the toggle. The two states are mutually
        //    exclusive (a right Drawer only opens while the sidebar is
        //    collapsed), so this single flag covers both without tracking
        //    drawer state.
        nativeScroll
          ? cn('h-[40px]', isSidebarCollapsed ? 'z-[35]' : 'z-[55]')
          : 'h-[50px] z-10',
      )}
      style={{
        // 12, or 8 px past the macOS traffic lights (74 + 8 = 82) in the
        // desktop window (`windowChrome`).
        left: sidebarToggleLeftFor(windowChrome),
        // The band is the title bar's height there (56: the button is
        // centred on the traffic lights), the class's 50 px elsewhere.
        ...(windowChrome && !nativeScroll ? { height: titleBarHeightFor(windowChrome) } : null),
        // Native (mobile Settings): match the header exactly — safe-area (clear
        // the notch) + the header's 5px offset — so the button's center lines up
        // with the header text and the top band stays 50px.
        top: nativeScroll ? 'calc(env(safe-area-inset-top, 0px) + 5px)' : 0,
        // Disappear/reappear together with the auto-hiding header.
        ...(nativeScroll
          ? {
              transform: headerHidden ? 'translateY(-150%)' : 'translateY(0)',
              opacity: headerHidden ? 0 : 1,
              pointerEvents: headerHidden ? 'none' : 'auto',
              // Match the header bar's show animation (duration-300 ease-out) so
              // the toggle and the header arrive/leave in sync rather than on two
              // different easings.
              transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
            }
          : null),
      }}
    >
      {/* One wording, both channels. This said "Open sidebar" on hover and "Open navigation
          menu" to assistive tech — the SAME control described two ways. The longer form is the
          one that says what the panel IS, so it wins in both. */}
      <Tooltip
        title={isSidebarCollapsed ? 'Open navigation menu' : 'Close navigation menu'}
        side="right"
      >
        <Button
          variant="ghost"
          data-testid="layout-sidebar-toggle-button"
          onClick={() => AppLayout.toggleSidebar()}
          // No background in any state — the ghost variant otherwise paints
          // hover:bg-muted AND a persistent aria-expanded:bg-muted (the toggle
          // sets aria-expanded when the sidebar is open). Keep it a bare icon.
          className="flex items-center justify-center hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent"
          style={{
            width: dimension,
            height: dimension,
            padding: 0,
            fontSize: iconFontSize,
            borderRadius: '4px',
            minWidth: dimension,
          }}
          aria-label={isSidebarCollapsed ? 'Open navigation menu' : 'Close navigation menu'}
          aria-expanded={!isSidebarCollapsed}
          aria-controls="app-sidebar"
        >
          {/* Left sidebar: PanelLeft depicts the visible left panel when open;
              PanelRight when collapsed. size-5 (20px) — lucide icons don't scale
              with the button's fontSize the way the old react-icons glyphs did. */}
          {isSidebarCollapsed ? (
            <PanelRight className="size-5" aria-hidden="true" />
          ) : (
            <PanelLeft className="size-5" aria-hidden="true" />
          )}
        </Button>
      </Tooltip>
    </div>
  )
}
