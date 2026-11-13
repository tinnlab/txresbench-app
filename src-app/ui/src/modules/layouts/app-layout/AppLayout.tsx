import type { ReactNode } from 'react'
import { AppLayout as ShellAppLayout } from '@txresbench/shell'
import { MAC_WINDOW_CHROME } from '@/core/macTitleBar'
import { isMacDesktop } from '@/core/platform'
import { LeftSidebar } from '@/modules/layouts/app-layout/components/LeftSidebar'
import { SidebarToggleButton } from '@/modules/layouts/app-layout/components/SidebarToggleButton'

// TxResBench's AppLayout = the SDK shell's generic AppLayout (@txresbench/shell B-1)
// with this app's sidebar leaves injected. The shell owns the resizable /
// collapsible sidebar shell, the mobile Sheet, and all the touch gestures; the
// app owns only `LeftSidebar` + `SidebarToggleButton` (this `@/`-import site is
// where a future desktop `localOverridePlugin` would swap in `.desktop`
// variants — the shell can't own those platform leaves). No copied layout logic
// remains in the app.
//
// The macOS desktop window draws its title bar in the page (Tauri's overlay
// title bar): there the shell's AppLayout gets the traffic lights' geometry
// (`windowChrome`, core/macTitleBar.ts), read on every render, so every
// AppLayout screen has the clearance and the drag region, and nothing
// outside an AppLayout gets them. The web and the Windows/Linux windows pass
// nothing and keep the web chrome.
export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ShellAppLayout
      LeftSidebar={LeftSidebar}
      SidebarToggleButton={SidebarToggleButton}
      windowChrome={isMacDesktop() ? MAC_WINDOW_CHROME : undefined}
    >
      {children}
    </ShellAppLayout>
  )
}

export default AppLayout
