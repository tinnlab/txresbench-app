import { Permissions } from '@/api-client/permissions'
import { createModule } from '@ziee/framework'
import { NotificationBell } from './NotificationBell'

/**
 * Notification module — the app-side wiring of the SDK notification feature.
 * Registers the inbox store + mounts the bell into the sidebar. Renderers for
 * each notification `kind` are contributed by the owning module (e.g. `project`)
 * through the SDK `registerNotificationKind` seam.
 */
export default createModule({
  metadata: {
    name: 'notification',
    version: '1.0.0',
    description: 'Notification inbox',
  },
  dependencies: ['router'],
  // `Notifications` is WHOLE-STORE-LAZY (`registerLazyStore` in its own file);
  // `NotificationBell` (the sidebarContent slot below) imports the handle.
  stores: [],
  slots: {
    sidebarContent: [
      {
        id: 'notification-bell',
        component: NotificationBell,
        order: 1,
        permission: Permissions.NotificationsRead,
      },
    ],
  },
})
