import type { BaseEvent } from '@txresbench/framework/events'
import type { SyncAction, SyncEntity } from '@/api-client/types'

// Client-side sync event typing.
//
// The backend `sync` module now emits a concrete `SyncEntity`/`SyncAction`, so
// the OpenAPI regen generates them into `@/api-client/types`. This file derives
// the `sync:<entity>` EventBus key space from that generated union — so a new
// backend entity becomes a valid event key on the next regen, automatically.
//
// Compiled as part of `src` (tsconfig `include`), so its `declare module`
// augmentation is active globally without being imported.

/**
 * A remote change notification for one entity, re-emitted onto the client
 * EventBus as a per-entity `sync:<entity>` event. Carries only the action + id
 * (notify-and-refetch) — the handler refetches via the permission-checked REST
 * endpoint.
 */
export interface SyncEntityEvent<E extends SyncEntity = SyncEntity>
  extends BaseEvent {
  type: `sync:${E}`
  data: { action: SyncAction; id: string }
}

type SyncEntityEvents = {
  [E in SyncEntity as `sync:${E}`]: SyncEntityEvent<E>
}

declare module '@txresbench/framework/events' {
  interface AppEvents extends SyncEntityEvents {
    // Broadcast by the SyncClient on every (re)connect so each store can reload
    // to cover events missed while the stream was down. `data` is an empty
    // object (every AppEvents member carries `data`).
    'sync:reconnect': BaseEvent & {
      type: 'sync:reconnect'
      data: Record<string, never>
    }
  }
}
