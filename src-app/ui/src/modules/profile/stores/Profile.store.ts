import { ApiClient } from '@/api-client'
import type {
  ChangePasswordRequest,
  UpdateProfileRequest,
} from '@/api-client/types'
import { echoLocalSync } from '@/core/sync/localEcho'
import { emitProfileUpdated } from '@/modules/profile/events'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const ProfileDef = defineStore('Profile', {
  immer: true,
  state: { savingProfile: false, savingPassword: false },
  actions: set => ({
    // Update the current user's own profile. Throws on failure (the page surfaces the
    // message).
    //
    // This used to `await Auth.refreshCurrentUser()` — one subscriber, hand-picked at the
    // mutation site, reaching across a module boundary. `ziee-auth .../handlers.rs:867`
    // publishes `Profile`/`Update` to the acting user with `origin` applied, so the
    // acting tab is the one client the fan-out skips; echoing that frame serves `Auth`
    // (the sidebar) AND the admin `Users` table through the one channel a second device
    // already uses. See `core/sync/localEcho.ts`.
    updateProfile: async (patch: UpdateProfileRequest) => {
      set(s => {
        s.savingProfile = true
      })
      try {
        const user = await ApiClient.Auth.updateProfile(patch)
        await echoLocalSync('profile', 'update', user.id)
        try {
          await emitProfileUpdated(user)
        } catch (eventError) {
          console.error('Failed to emit profile.updated event:', eventError)
        }
      } finally {
        set(s => {
          s.savingProfile = false
        })
      }
    },
    changePassword: async (patch: ChangePasswordRequest) => {
      set(s => {
        s.savingPassword = true
      })
      try {
        await ApiClient.Auth.changePassword(patch)
      } finally {
        set(s => {
          s.savingPassword = false
        })
      }
    },
  }),
})

export const useProfileStore = ProfileDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Profile'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Profile = registerLazyStore(ProfileDef)

