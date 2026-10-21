import { SettingsPageContainer } from '@ziee/shell'
import { ThemeSettings } from '@/modules/settings-general/components/ThemeSettings'

export default function GeneralSettings() {
  return (
    <SettingsPageContainer title="General">
      <ThemeSettings />
      {/* Future settings cards go here */}
    </SettingsPageContainer>
  )
}
