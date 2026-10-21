import type { BaseEvent } from '@ziee/framework/events'
import type { User } from '@/api-client/types'

export interface ProfileUpdatedEvent extends BaseEvent {
  type: 'profile.updated'
  data: { user: User }
}

export type ProfileModuleEvent = ProfileUpdatedEvent

declare module '@ziee/framework/events' {
  interface AppEvents {
    'profile.updated': ProfileUpdatedEvent
  }
}
