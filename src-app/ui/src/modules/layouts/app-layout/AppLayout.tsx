import type { ReactNode } from 'react'
import { AppLayout as ShellAppLayout } from '@ziee/shell'
import { LeftSidebar } from '@/modules/layouts/app-layout/components/LeftSidebar'
import { SidebarToggleButton } from '@/modules/layouts/app-layout/components/SidebarToggleButton'

// CytoAnalyst's AppLayout = the SDK shell's generic AppLayout (@ziee/shell B-1)
// with this app's sidebar leaves injected. The shell owns the resizable /
// collapsible sidebar shell, the mobile Sheet, and all the touch gestures; the
// app owns only `LeftSidebar` + `SidebarToggleButton` (this `@/`-import site is
// where a future desktop `localOverridePlugin` would swap in `.desktop`
// variants — the shell can't own those platform leaves). No copied layout logic
// remains in the app.
export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ShellAppLayout
      LeftSidebar={LeftSidebar}
      SidebarToggleButton={SidebarToggleButton}
    >
      {children}
    </ShellAppLayout>
  )
}

export default AppLayout
