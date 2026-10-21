import { EventBus } from '@ziee/framework/stores'
import type { User } from '@/api-client/types'

export const emitProfileUpdated = async (user: User) => {
  await EventBus.emit({ type: 'profile.updated', data: { user } })
}
