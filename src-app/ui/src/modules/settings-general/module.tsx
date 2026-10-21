import { createModule } from '@ziee/framework'
import { IoMdPerson } from 'react-icons/io'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types

const GeneralSettings = lazyWithPreload(() => import('./GeneralSettings'))

export default createModule({
  metadata: {
    name: 'settings-general',
    version: '1.0.0',
    description: 'General user settings',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/general',
      element: GeneralSettings,
      requiresAuth: true,
      layout: SettingsLayoutDef,
    },
  ],
  slots: {
    settingsUserPages: [
      {
        id: 'general',
        icon: <IoMdPerson />,
        label: 'General',
        path: 'general',
        order: 10,
      },
    ],
  },
  initialize: () => {
    console.log('General settings module initialized')
  },
})
