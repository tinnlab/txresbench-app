import { AppLayout } from '@/modules/layouts/app-layout'
import type { LayoutDefinition } from '@ziee/framework/router'
import SettingsPage from '@/modules/settings/SettingsPage'

export function SettingsLayout() {
  return (
    <AppLayout>
      <SettingsPage />
    </AppLayout>
  )
}

export const SettingsLayoutDef: LayoutDefinition = {
  component: SettingsLayout as any,
}

// Default export for backwards compatibility
export default SettingsLayout
