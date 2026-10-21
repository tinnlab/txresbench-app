// ONE channel for `user` and `group` — and the surfaces a parallel channel left stale.
//
// ── What was wrong ──────────────────────────────────────────────────────────────────
//
// This module maintained its own payload-carrying EventBus space (`user.created`,
// `user.updated`, `user.deleted`, `group.created`, `group.updated`, `group.deleted`,
// `group.member_added`, `group.member_removed`). It existed for a good reason: when it
// was written, `sync:user` and `sync:group` had no publisher on any layer, so an admin
// surface that wanted to react to a mutation had nothing else to react to.
//
// Then the sinks were wired, and the same fact started arriving by two mechanisms that
// do not overlap:
//
//   * the LOCAL payload event — emitted by the acting store, so it reaches every
//     subscriber in the ACTING tab and nowhere else; and
//   * `sync:user` / `sync:group` — delivered to every OTHER device and tab.
//
// Anything subscribed to only the first is therefore correct locally and permanently
// stale remotely. That is not a hypothetical split: the four cases in "REMOTE frames"
// below are surfaces that a change made on another device (or by another admin) never
// reached, and each of them fails on the pre-convergence code.
//
// ── What these cases assert ─────────────────────────────────────────────────────────
//
// OUTCOMES on the surface a user is looking at — what the users LIST holds, what the
// open drawer is EDITING, whether a drawer is still open — never "was an event
// emitted". Plus a WIRE-PARITY block that pins the exact frames each mutation puts on
// the bus against what the Rust handler publishes, because an outcome assertion cannot
// see a frame carrying the wrong id or the wrong action.
//
// The stores' real `init` wiring and the real EventBus run FOR REAL; the only boundary
// mocked is `ApiClient.User.*` / `ApiClient.UserGroup.*` and the permission gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

// ── the fake backend ────────────────────────────────────────────────────────────────
let userRows: User[] = []
let groupRows: Group[] = []
/** group id -> member ids (the server's `group_members` join). */
let members: Record<string, string[]> = {}
let seq = 0

function makeUser(username: string): User {
  seq += 1
  return {
    id: `u-${seq}`,
    username,
    email: `${username}@x.test`,
    display_name: username,
    is_active: true,
    is_admin: false,
    created_at: '',
    updated_at: '',
  } as unknown as User
}
function makeGroup(name: string): Group {
  seq += 1
  return {
    id: `g-${seq}`,
    name,
    description: '',
    permissions: [],
    is_active: true,
    created_at: '',
    updated_at: '',
  } as unknown as Group
}

// IMPORTANT: every read returns a fresh CLONE. A fake that hands back the same mutable
// object the store already holds makes "the surface refreshed" unfalsifiable — the row
// updates itself whether or not anything refetched. (That defect produced a false pass
// in the dataset fan-out suite and is called out in `a3a44296`.)
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const listUsers = vi.fn(async ({ page = 1, per_page = 10 }: { page?: number; per_page?: number }) => ({
  users: clone(userRows.slice((page - 1) * per_page, (page - 1) * per_page + per_page)),
  total: userRows.length,
  page,
  per_page,
}))
const getUser = vi.fn(async ({ user_id }: { user_id: string }) => {
  const u = userRows.find(r => r.id === user_id)
  if (!u) throw new Error('404')
  return clone(u)
})
const createUser = vi.fn(async ({ username }: { username: string }) => {
  const u = makeUser(username)
  userRows = [...userRows, u]
  return clone(u)
})
const updateUser = vi.fn(async ({ user_id, username }: { user_id: string; username?: string }) => {
  const u = userRows.find(r => r.id === user_id)!
  if (username) u.username = username
  return clone(u)
})
const toggleActive = vi.fn(async ({ user_id }: { user_id: string }) => {
  const u = userRows.find(r => r.id === user_id)!
  u.is_active = !u.is_active
  return clone(u)
})
const resetPassword = vi.fn(async (_args?: unknown) => undefined)
const deleteUser = vi.fn(async ({ user_id }: { user_id: string }) => {
  userRows = userRows.filter(r => r.id !== user_id)
})

const listGroups = vi.fn(async ({ page = 1, per_page = 10 }: { page?: number; per_page?: number }) => ({
  groups: clone(groupRows.slice((page - 1) * per_page, (page - 1) * per_page + per_page)),
  total: groupRows.length,
  page,
  per_page,
}))
const getGroup = vi.fn(async ({ group_id }: { group_id: string }) => {
  const g = groupRows.find(r => r.id === group_id)
  if (!g) throw new Error('404')
  return clone(g)
})
const createGroup = vi.fn(async ({ name }: { name: string }) => {
  const g = makeGroup(name)
  groupRows = [...groupRows, g]
  members[g.id] = []
  return clone(g)
})
const updateGroup = vi.fn(async ({ group_id, name }: { group_id: string; name?: string }) => {
  const g = groupRows.find(r => r.id === group_id)!
  if (name) g.name = name
  return clone(g)
})
const deleteGroup = vi.fn(async ({ group_id }: { group_id: string }) => {
  groupRows = groupRows.filter(r => r.id !== group_id)
  delete members[group_id]
})
const getGroupMembers = vi.fn(async ({ group_id }: { group_id: string }) => ({
  // The endpoint's key is `users` (see `UserGroups.store::loadUserGroupMembers`).
  users: clone((members[group_id] ?? []).map(id => userRows.find(u => u.id === id)).filter(Boolean) as User[]),
  total: (members[group_id] ?? []).length,
  page: 1,
  per_page: 50,
}))
const assignUser = vi.fn(async ({ user_id, group_id }: { user_id: string; group_id: string }) => {
  members[group_id] = [...new Set([...(members[group_id] ?? []), user_id])]
})
const removeUser = vi.fn(async ({ user_id, group_id }: { user_id: string; group_id: string }) => {
  members[group_id] = (members[group_id] ?? []).filter(id => id !== user_id)
})

vi.mock('@/api-client', () => ({
  ApiClient: {
    User: {
      list: (...a: unknown[]) => listUsers(...(a as [never])),
      get: (...a: unknown[]) => getUser(...(a as [never])),
      create: (...a: unknown[]) => createUser(...(a as [never])),
      update: (...a: unknown[]) => updateUser(...(a as [never])),
      toggleActive: (...a: unknown[]) => toggleActive(...(a as [never])),
      resetPassword: (...a: unknown[]) => resetPassword(...(a as [never])),
      delete: (...a: unknown[]) => deleteUser(...(a as [never])),
    },
    UserGroup: {
      list: (...a: unknown[]) => listGroups(...(a as [never])),
      get: (...a: unknown[]) => getGroup(...(a as [never])),
      create: (...a: unknown[]) => createGroup(...(a as [never])),
      update: (...a: unknown[]) => updateGroup(...(a as [never])),
      delete: (...a: unknown[]) => deleteGroup(...(a as [never])),
      getMembers: (...a: unknown[]) => getGroupMembers(...(a as [never])),
      assignUser: (...a: unknown[]) => assignUser(...(a as [never])),
      removeUser: (...a: unknown[]) => removeUser(...(a as [never])),
    },
  },
}))

const { useEventBusStore } = await import('@ziee/framework/events')
const { EventBus } = await import('@ziee/framework/stores')
const { useUsersStore } = await import('./stores/Users.store')
const { useUserGroupsStore } = await import('./stores/UserGroups.store')
const { useEditUserDrawerStore } = await import('./components/user/EditUserDrawer.store')
const { useUserGroupDrawerStore } = await import('./components/group/EditUserGroupDrawer.store')
const { useGroupMembersDrawerStore } = await import('./components/group/GroupMembersDrawer.store')
const { useResetPasswordDrawerStore } = await import('./components/user/ResetPasswordDrawer.store')

const users = () => useUsersStore.getState()
const groups = () => useUserGroupsStore.getState()
const editDrawer = () => useEditUserDrawerStore.getState()
const groupDrawer = () => useUserGroupDrawerStore.getState()
const membersDrawer = () => useGroupMembersDrawerStore.getState()
const pwDrawer = () => useResetPasswordDrawerStore.getState()

/** The usernames the admin USERS TABLE is rendering. */
const listedUsernames = () => users().users.map(u => u.username)
/** The names the GROUPS list is rendering. */
const listedGroupNames = () => groups().groups.map(g => g.name)
/** The usernames the OPEN group's member panel is rendering. */
const shownMembers = () => groups().currentGroupMembers.map(m => m.username)

/**
 * A frame arriving FROM ANOTHER DEVICE. This is exactly what `core/sync/SyncClient`
 * does with a wire frame — it re-emits it on `sync:<entity>` — so a subscriber cannot
 * tell this from the real thing, which is the property being tested.
 */
const remote = (entity: 'user' | 'group', action: 'create' | 'update' | 'delete', id: string) =>
  EventBus.emit({ type: `sync:${entity}`, data: { action, id } } as never)

/** Record every frame on BOTH namespaces while `fn` runs. */
const WATCHED = [
  'sync:user',
  'sync:group',
  // The retired parallel space. Watched so a case can assert it stays SILENT: the
  // convergence is only real if nothing re-introduces a second mechanism, and that is
  // a fact about what the bus carried at runtime — not about what the source says.
  'user.created',
  'user.updated',
  'user.deleted',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.member_added',
  'group.member_removed',
] as const
async function capture<T>(fn: () => Promise<T>): Promise<{ seen: string[]; result: T }> {
  const seen: string[] = []
  const bus = useEventBusStore.getState()
  const offs = WATCHED.map(type =>
    bus.on(type as never, ((e: { type: string; data?: { action?: string; id?: string } }) => {
      seen.push(e.data?.action ? `${e.type}:${e.data.action}:${e.data.id}` : e.type)
    }) as never),
  )
  try {
    const result = await fn()
    return { seen, result }
  } finally {
    for (const off of offs) off()
  }
}

beforeEach(async () => {
  userRows = []
  groupRows = []
  members = {}
  seq = 0
  for (const m of [
    listUsers, getUser, createUser, updateUser, toggleActive, resetPassword, deleteUser,
    listGroups, getGroup, createGroup, updateGroup, deleteGroup, getGroupMembers, assignUser, removeUser,
  ]) {
    m.mockClear()
  }
  useUsersStore.setState({
    users: [], total: 0, currentPage: 1, pageSize: 10, isInitialized: false,
    loading: false, creating: false, updating: false, deleting: false, error: null,
  })
  useUserGroupsStore.setState({ ...groups(), groups: [], total: 0, currentGroupId: null, currentGroupMembers: [] })
  useEditUserDrawerStore.setState({ isOpen: false, editingUser: null })
  useUserGroupDrawerStore.setState({ isOpen: false, editingGroup: null })
  useGroupMembersDrawerStore.setState({ isOpen: false, selectedGroup: null })
  useResetPasswordDrawerStore.setState({ isOpen: false, user: null })

  // Wire the REAL subscriptions of every store (what mounting the admin pages does).
  users().__init__.__store__()
  groups().__init__.__store__()
  editDrawer().__init__.__store__()
  groupDrawer().__init__.__store__()
  membersDrawer().__init__.__store__()
  pwDrawer().__init__.__store__()
  await vi.waitFor(() => expect(users().isInitialized).toBe(true))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════ REMOTE frames — what the parallel channel never reached ════════════
//
// Every case here emits a frame the way a SECOND DEVICE's mutation arrives. The old
// payload space was emitted only by the acting store, so none of these surfaces heard
// anything at all.

describe('a change made on another device', () => {
  it('refreshes the user an open edit drawer is holding', async () => {
    const u = await users().createUser({ username: 'ada', email: 'a@x.test', password: 'x' } as never)
    editDrawer().openEditUserDrawer(u!)
    expect(editDrawer().editingUser?.username).toBe('ada')

    // Another admin renames her.
    userRows.find(r => r.id === u!.id)!.username = 'ada-renamed'
    await remote('user', 'update', u!.id)

    await vi.waitFor(() => expect(editDrawer().editingUser?.username).toBe('ada-renamed'))
  })

  it('closes an edit drawer whose user was deleted', async () => {
    const u = await users().createUser({ username: 'bob', email: 'b@x.test', password: 'x' } as never)
    editDrawer().openEditUserDrawer(u!)
    expect(editDrawer().isOpen).toBe(true)

    userRows = userRows.filter(r => r.id !== u!.id)
    await remote('user', 'delete', u!.id)

    await vi.waitFor(() => expect(editDrawer().isOpen).toBe(false))
  })

  it('closes a reset-password drawer whose user was deleted', async () => {
    const u = await users().createUser({ username: 'cid', email: 'c@x.test', password: 'x' } as never)
    pwDrawer().openResetPasswordDrawer(u!)
    userRows = userRows.filter(r => r.id !== u!.id)
    await remote('user', 'delete', u!.id)
    await vi.waitFor(() => expect(pwDrawer().isOpen).toBe(false))
  })

  it('refreshes the group an open drawer is holding', async () => {
    const g = await groups().createUserGroup({ name: 'analysts' } as never)
    groupDrawer().openUserGroupDrawer(g!)
    expect(groupDrawer().editingGroup?.name).toBe('analysts')

    groupRows.find(r => r.id === g!.id)!.name = 'analysts-renamed'
    await remote('group', 'update', g!.id)

    await vi.waitFor(() => expect(groupDrawer().editingGroup?.name).toBe('analysts-renamed'))
  })

  it('refreshes the group a members drawer is holding, and closes it on delete', async () => {
    const g = await groups().createUserGroup({ name: 'reviewers' } as never)
    membersDrawer().openGroupMembersDrawer(g!)

    groupRows.find(r => r.id === g!.id)!.name = 'reviewers-v2'
    await remote('group', 'update', g!.id)
    await vi.waitFor(() => expect(membersDrawer().selectedGroup?.name).toBe('reviewers-v2'))

    groupRows = groupRows.filter(r => r.id !== g!.id)
    await remote('group', 'delete', g!.id)
    await vi.waitFor(() => expect(membersDrawer().isOpen).toBe(false))
  })

  it('refreshes the OPEN group’s member list when membership changes elsewhere', async () => {
    const g = await groups().createUserGroup({ name: 'ops' } as never)
    const u = await users().createUser({ username: 'dee', email: 'd@x.test', password: 'x' } as never)
    await groups().loadUserGroupMembers(g!.id)
    expect(shownMembers()).toEqual([])

    // Another admin adds her to the group. The server publishes Group/Update.
    members[g!.id] = [u!.id]
    await remote('group', 'update', g!.id)

    await vi.waitFor(() => expect(shownMembers()).toEqual(['dee']))
  })

  it('drops a deleted user from the OPEN group’s member list', async () => {
    const g = await groups().createUserGroup({ name: 'ops2' } as never)
    const u = await users().createUser({ username: 'eve', email: 'e@x.test', password: 'x' } as never)
    members[g!.id] = [u!.id]
    await groups().loadUserGroupMembers(g!.id)
    expect(shownMembers()).toEqual(['eve'])

    userRows = userRows.filter(r => r.id !== u!.id)
    await remote('user', 'delete', u!.id)

    await vi.waitFor(() => expect(shownMembers()).toEqual([]))
  })
})

// ═══════════════ LOCAL mutations — the surface still updates ════════════════════════
//
// Positive controls: the echo replaced each store's private inline patch, so these must
// hold both before and after. A red here means the convergence dropped a refresh.

describe('a mutation performed in THIS tab', () => {
  it('shows a created user in the list', async () => {
    await users().createUser({ username: 'fay', email: 'f@x.test', password: 'x' } as never)
    await vi.waitFor(() => expect(listedUsernames()).toEqual(['fay']))
  })

  it('shows a renamed user in the list', async () => {
    const u = await users().createUser({ username: 'gil', email: 'g@x.test', password: 'x' } as never)
    await vi.waitFor(() => expect(listedUsernames()).toEqual(['gil']))
    await users().updateUser(u!.id, { username: 'gil2' } as never)
    await vi.waitFor(() => expect(listedUsernames()).toEqual(['gil2']))
  })

  it('drops a deleted user from the list', async () => {
    const u = await users().createUser({ username: 'hal', email: 'h@x.test', password: 'x' } as never)
    await vi.waitFor(() => expect(listedUsernames()).toEqual(['hal']))
    await users().deleteUser(u!.id)
    await vi.waitFor(() => expect(listedUsernames()).toEqual([]))
  })

  it('reflects the SERVER’s active flag after a toggle, not a client guess', async () => {
    const u = await users().createUser({ username: 'ivy', email: 'i@x.test', password: 'x' } as never)
    await vi.waitFor(() => expect(users().users[0]?.is_active).toBe(true))
    await users().toggleUserActiveStatus(u!.id)
    await vi.waitFor(() => expect(users().users[0]?.is_active).toBe(false))
    // The value came from a refetch, not from flipping the row the store already held.
    expect(listUsers.mock.calls.length).toBeGreaterThan(1)
  })

  it('shows created / renamed / deleted groups in the list', async () => {
    const g = await groups().createUserGroup({ name: 'jays' } as never)
    await vi.waitFor(() => expect(listedGroupNames()).toEqual(['jays']))
    await groups().updateUserGroup(g!.id, { name: 'jays2' } as never)
    await vi.waitFor(() => expect(listedGroupNames()).toEqual(['jays2']))
    await groups().deleteUserGroup(g!.id)
    await vi.waitFor(() => expect(listedGroupNames()).toEqual([]))
  })

  it('shows a member added from THIS tab in the open group', async () => {
    const g = await groups().createUserGroup({ name: 'kilo' } as never)
    const u = await users().createUser({ username: 'lee', email: 'l@x.test', password: 'x' } as never)
    await groups().loadUserGroupMembers(g!.id)
    await groups().assignUserToUserGroup(u!.id, g!.id)
    await vi.waitFor(() => expect(shownMembers()).toEqual(['lee']))
    await groups().removeUserFromUserGroup(u!.id, g!.id)
    await vi.waitFor(() => expect(shownMembers()).toEqual([]))
  })
})

// ═══════════════ WIRE PARITY ════════════════════════════════════════════════════════
//
// Pins each mutation's emitted frames against the entity/action/id its Rust handler
// publishes to the acting user WITH `origin` (`modules/user/handlers.rs`). An outcome
// assertion cannot see a frame with the wrong action or the wrong id; a mutant that
// swaps `update` for `create`, or echoes the group id where the user id belongs, dies
// here.

describe('wire parity with modules/user/handlers.rs', () => {
  it('create_user → user/create naming the new user, and nothing else', async () => {
    const { seen, result } = await capture(() =>
      users().createUser({ username: 'mia', email: 'm@x.test', password: 'x' } as never),
    )
    expect(seen).toEqual([`sync:user:create:${result!.id}`])
  })

  it('update_user → user/update naming the edited user', async () => {
    const u = await users().createUser({ username: 'ned', email: 'n@x.test', password: 'x' } as never)
    const { seen } = await capture(() => users().updateUser(u!.id, { username: 'ned2' } as never))
    expect(seen).toEqual([`sync:user:update:${u!.id}`])
  })

  it('toggle_user_active → user/update naming the toggled user', async () => {
    const u = await users().createUser({ username: 'ola', email: 'o@x.test', password: 'x' } as never)
    const { seen } = await capture(() => users().toggleUserActiveStatus(u!.id))
    expect(seen).toEqual([`sync:user:update:${u!.id}`])
  })

  it('delete_user → user/delete naming the removed user', async () => {
    const u = await users().createUser({ username: 'pam', email: 'p@x.test', password: 'x' } as never)
    const { seen } = await capture(() => users().deleteUser(u!.id))
    expect(seen).toEqual([`sync:user:delete:${u!.id}`])
  })

  it('reset_user_password → NOTHING, because the handler publishes nothing', async () => {
    const u = await users().createUser({ username: 'quy', email: 'q@x.test', password: 'x' } as never)
    const { seen } = await capture(() => users().resetUserPassword(u!.id, 'newPassw0rd!'))
    // The old code emitted `user.updated` here carrying the UNCHANGED row it happened
    // to hold — an event announcing a change that had not happened. `reset_user_password`
    // publishes no sync frame (it alters only the password hash), so neither does this.
    expect(seen).toEqual([])
  })

  it('group mutations → group frames naming the GROUP (never the user)', async () => {
    const g = await groups().createUserGroup({ name: 'rho' } as never)
    const u = await users().createUser({ username: 'sam', email: 's@x.test', password: 'x' } as never)

    const created = await capture(() => groups().createUserGroup({ name: 'rho2' } as never))
    expect(created.seen).toEqual([`sync:group:create:${created.result!.id}`])

    const updated = await capture(() => groups().updateUserGroup(g!.id, { name: 'rho3' } as never))
    expect(updated.seen).toEqual([`sync:group:update:${g!.id}`])

    // assign/remove publish Group/Update keyed on the GROUP — `assign_user_to_group`
    // and `remove_user_from_group` both do, and the member id is NOT the frame's id.
    const assigned = await capture(() => groups().assignUserToUserGroup(u!.id, g!.id))
    expect(assigned.seen).toEqual([`sync:group:update:${g!.id}`])

    const removed = await capture(() => groups().removeUserFromUserGroup(u!.id, g!.id))
    expect(removed.seen).toEqual([`sync:group:update:${g!.id}`])

    const deleted = await capture(() => groups().deleteUserGroup(g!.id))
    expect(deleted.seen).toEqual([`sync:group:delete:${g!.id}`])
  })

  it('no mutation puts anything on the retired parallel space', async () => {
    const g = await groups().createUserGroup({ name: 'tau' } as never)
    const { seen } = await capture(async () => {
      const u = await users().createUser({ username: 'uma', email: 'u@x.test', password: 'x' } as never)
      await users().updateUser(u!.id, { username: 'uma2' } as never)
      await users().toggleUserActiveStatus(u!.id)
      await groups().assignUserToUserGroup(u!.id, g!.id)
      await groups().removeUserFromUserGroup(u!.id, g!.id)
      await users().deleteUser(u!.id)
      await groups().deleteUserGroup(g!.id)
    })
    // Every frame is a `sync:` frame. A re-introduced `user.*`/`group.*` emit shows up
    // here as a runtime FACT about what the bus carried — not as a source-text match,
    // which a differently-spelled emit would slip past.
    const legacy = seen.filter(k => !k.startsWith('sync:'))
    expect(legacy).toEqual([])
    expect(seen.length).toBeGreaterThan(0)
  })
})
