import { ApiClient } from '@/api-client'
import { type Notification as NotificationRow } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import type { AppNotification } from '@ziee/framework/notification'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { message } from '@ziee/kit'

/** A bulk mutation has no single row id; the subscriber refetches the list regardless. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Map the generated row (payload: unknown) to the SDK renderer's shape. */
function toApp(n: NotificationRow): AppNotification {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    interrupt: n.interrupt,
    payload: (n.payload ?? {}) as Record<string, unknown>,
    read_at: n.read_at ?? null,
    created_at: n.created_at,
  }
}

/**
 * The durable notification inbox (app-side wiring of the SDK notification
 * feature). Fetches the SDK-owned `/api/notifications` endpoints; subscribes to
 * `sync:notification` / `sync:reconnect` (self-gated on `notifications::read`)
 * so a new invite arrives live; toasts newly-arrived interrupt notifications
 * once.
 */
const NotificationsDef = defineStore('Notifications', {
  state: {
    items: [] as AppNotification[],
    unread: 0,
    loading: false,
    isInitialized: false,
    // Ids already surfaced as a toast — so a reload doesn't re-toast.
    toastedIds: [] as string[],
  },
  actions: (set, get) => {
    const load = async () => {
      if (!hasPermissionNow(Permissions.NotificationsRead)) return
      set({ loading: true })
      try {
        const res = await ApiClient.Notification.list({ page: 1, per_page: 20 })
        const items = (res.items ?? []).map(toApp)
        // Toast newly-arrived unread interrupt notifications, once each.
        const toasted = new Set(get().toastedIds)
        const firstLoad = !get().isInitialized
        const newlyToasted: string[] = []
        for (const n of items) {
          if (!n.read_at && n.interrupt && !toasted.has(n.id)) {
            // Don't storm toasts on the very first load (existing unread inbox).
            if (!firstLoad) message.info(n.title, { description: n.body })
            newlyToasted.push(n.id)
          }
        }
        set({
          items,
          unread: res.unread,
          loading: false,
          isInitialized: true,
          toastedIds: [...get().toastedIds, ...newlyToasted].slice(-200),
        })
      } catch {
        set({ loading: false })
      }
    }
    return {
      load,
      // Each of these publishes `Notification` to the acting user WITH `origin` (the
      // SDK notification module's sync seam, wired in `lib.rs`), so this tab is the one
      // connection the fan-out skips. The echo IS the refresh path — an inline `load()`
      // alongside it would be a second fetch, and an inline `load()` INSTEAD of it is
      // how a store stops being able to tell a local mutation from a remote one.
      markRead: async (id: string) => {
        await ApiClient.Notification.markRead({ id })
        await echoLocalSync('notification', 'update', id)
      },
      readAll: async () => {
        await ApiClient.Notification.markAllRead()
        // No single id — `markAllRead` touches every unread row, so the refetch is the
        // whole point and the id is a formality the subscriber ignores.
        await echoLocalSync('notification', 'update', NIL_UUID)
      },
      remove: async (id: string) => {
        await ApiClient.Notification.delete({ id })
        await echoLocalSync('notification', 'delete', id)
      },
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.NotificationsRead)) return
      void actions.load()
    }
    on('sync:notification', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.NotificationsRead)) void actions.load()
  },
})

export const useNotificationsStore = NotificationsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Notifications'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Notifications = registerLazyStore(NotificationsDef)
