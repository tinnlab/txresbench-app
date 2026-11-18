import { SettingsPageContainer } from '@txresbench/shell'
import { ThemeSettings } from '@/modules/settings-general/components/ThemeSettings'
import { MethodListSettings } from '@/modules/settings-general/components/MethodListSettings'

export default function GeneralSettings() {
  return (
    <SettingsPageContainer title="General">
      <ThemeSettings />
      <MethodListSettings />
      {/* Future settings cards go here */}
    </SettingsPageContainer>
  )
}
