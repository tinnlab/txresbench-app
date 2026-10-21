import { createModule } from '@ziee/framework'
import { UserProfileWidget } from '@/modules/user-profile/UserProfileWidget'

export default createModule({
  metadata: {
    name: 'user-profile',
    version: '1.0.0',
    description: 'User profile widget in sidebar footer',
  },
  slots: {
    sidebarFooter: [
      {
        id: 'user-profile',
        component: UserProfileWidget,
        order: 100,
      },
    ],
  },
  initialize: () => {
    console.log('User Profile module initialized')
  },
})
