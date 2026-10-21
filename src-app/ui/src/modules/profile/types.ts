import type { StoreProxy } from '@ziee/framework/stores'
import type { useProfileStore } from './stores/Profile.store'

declare module '@ziee/framework/stores' {
  interface RegisteredStores {
    Profile: StoreProxy<ReturnType<typeof useProfileStore.getState>>
  }
}

export {}
