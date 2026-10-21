// @vitest-environment jsdom
//
// An admin renaming THEMSELVES did not update the admin users list.
//
// ── The two separate faults behind that one symptom ──────────────────────────────────
//
// 1. `Profile.updateProfile` reached ACROSS modules with a hand-picked
//    `await Auth.refreshCurrentUser()`. That is the same shape as the `void
//    Projects.load()` at the invite call site that `c4ce3b4e` removed: one subscriber,
//    chosen at the mutation site, with every other interested surface left out. The
//    server (`ziee-auth .../handlers.rs:867`) publishes `Profile`/`Update` to the acting
//    user with `origin` applied, so the acting tab is the one client that never hears it.
//
// 2. The admin `Users` list subscribes to `sync:user` ONLY. A self-service profile edit
//    is not a `user` frame in any layer — no `SyncEntity::User` is published anywhere in
//    this backend (see `syncChannelParity.test.ts`) — so the row the admin had just
//    renamed kept its old name until a reload.
//
// Both cases below assert the OUTCOME on a store that did NOT perform the mutation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

let me = { id: 'u-1', username: 'admin', display_name: 'Admin' }
let userRows = [me]

const updateProfile = vi.fn(async ({ username }: { username?: string }) => {
  me = { ...me, username: username ?? me.username }
  userRows = userRows.map(u => (u.id === me.id ? { ...me } : u))
  return { ...me }
})
const authMe = vi.fn(async () => ({
  user: { ...me },
  permissions: ['*'],
  has_password: true,
}))
const listUsers = vi.fn(async () => ({
  users: userRows.map(u => ({ ...u })),
  total: userRows.length,
  page: 1,
  per_page: 20,
}))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Auth: {
      updateProfile: (...a: unknown[]) => updateProfile(...(a as [never])),
      me: () => authMe(),
    },
    User: { list: () => listUsers() },
  },
}))

const { useProfileStore } = await import('./stores/Profile.store')
const { useUsersStore } = await import('@/modules/user/stores/Users.store')
const { useAuthStore } = await import('@/modules/auth/Auth.store')
const { useEventBusStore } = await import('@ziee/framework/events')

const profile = () => useProfileStore.getState()
const admins = () => useUsersStore.getState()
/** The usernames the ADMIN USERS TABLE is rendering — the surface that stayed stale. */
const adminNames = () => admins().users.map(u => u.username)

beforeEach(async () => {
  me = { id: 'u-1', username: 'admin', display_name: 'Admin' }
  userRows = [me]
  updateProfile.mockClear()
  authMe.mockClear()
  listUsers.mockClear()
  useUsersStore.setState({ users: [], total: 0, currentPage: 1, pageSize: 10, isInitialized: false, loading: false, error: null })
  // A live session, so `Auth`'s sync handler is not short-circuited by its `!token` guard.
  useAuthStore.setState({ token: 't', isLoading: false, user: { ...me } as never })
  // Both stores' REAL `init` wiring — `Auth` registers its `sync:profile` listener there.
  useAuthStore.getState().__init__.__store__()
  useAuthStore.setState({ token: 't', isLoading: false, user: { ...me } as never })
  admins().__init__.__store__()
  await vi.waitFor(() => expect(adminNames()).toContain('admin'))
})

afterEach(() => {
  admins().__destroy__()
  void useAuthStore.getState().__destroy__()
  useEventBusStore.getState().removeGroupListeners('AuthStore')
})

describe('a self-service profile edit reaches the surfaces it did not perform', () => {
  it('renames the row in the ADMIN USERS list', async () => {
    await profile().updateProfile({ username: 'admin2' })

    // THE REPORTED OUTCOME. Nothing in `Profile.store` names `Users` — it reaches it
    // through the same `sync:profile` frame a second device would receive.
    await vi.waitFor(() => expect(adminNames()).toContain('admin2'))
    expect(adminNames()).not.toContain('admin')
  })

  it('still refreshes the signed-in user (the surface the direct call used to serve)', async () => {
    const before = authMe.mock.calls.length

    await profile().updateProfile({ username: 'admin3' })

    // The inline `Auth.refreshCurrentUser()` was removed in favour of the echo:
    // `Auth`'s own `sync:profile` subscription is the refresh path now, exactly as it is
    // for another device. Drop the echo and the author's OWN sidebar goes stale first.
    await vi.waitFor(() => expect(authMe.mock.calls.length).toBeGreaterThan(before))
    await vi.waitFor(() => expect(useAuthStore.getState().user?.username).toBe('admin3'))
  })

  it('echoes profile/update with the USER id — the frame the handler withheld', async () => {
    const seen: { type: string; action: string; id: string }[] = []
    const bus = useEventBusStore.getState()
    const off = bus.on('sync:profile' as never, ((e: {
      type: string
      data: { action: string; id: string }
    }) => {
      seen.push({ type: e.type, action: e.data.action, id: e.data.id })
    }) as never)
    try {
      await profile().updateProfile({ username: 'admin4' })
    } finally {
      off()
    }
    // `update_profile` publishes `Profile`/`Update` for `updated_user.id` — not a `user`
    // frame (no `SyncEntity::User` is ever published) and not the acting session.
    expect(seen).toEqual([{ type: 'sync:profile', action: 'update', id: 'u-1' }])
  })
})
