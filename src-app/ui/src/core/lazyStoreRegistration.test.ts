// Whole-store-lazy registration — the DOUBLE-LIFECYCLE guard.
//
// Every store in this app is authored as
//
//     const XDef = defineStore('X', { … })
//     export const X = registerLazyStore(XDef)
//
// and consumed through the exported PROXY, not through a global registry lookup
// (the app-local `@/core/stores` shim that re-declared the SDK's removed `Stores`
// proxy is gone). The failure mode that migration invites is SILENT:
//
//   Hand-rolling a second proxy for a store that is ALSO registered by name —
//   `createStoreProxy(XDef.store)` next to a module's `stores: [{ name: 'X',
//   store: useXStore }]` entry — yields TWO proxies over ONE zustand store, each
//   with its own `storeInitialized` latch. Both run `init`. Nothing throws; the
//   store just fetches twice on boot.
//
// `registerLazyStore` is the fix: it builds the proxy ONCE, self-registers it,
// and the module system's `selfOwnedStores` set makes a `stores: [...]` entry for
// that same name REUSE the instance instead of constructing a rival.
//
// ── WHY THIS MEASURES FETCHES, NOT LISTENERS ────────────────────────────────────
//
// The obvious probe — "count the `sync:*` handlers" — is a FALSE NEGATIVE, and it
// passed against a deliberately-doubled proxy while being written. store-kit's
// `ctx.on` passes the store's GROUP NAME to `EventBus.on`, and the bus
// deduplicates by `group + event`: a second `init` REPLACES the handler instead of
// adding one, so the handler count reads 1 either way. What actually doubles is
// the WORK `init` does — `void actions.loadUsers()` — so the subject here is
// `Users` (whose `init` fetches) and the oracle is the API call count.

import { describe, expect, it, vi } from 'vitest'

const list = vi.fn()

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))
vi.mock('@/api-client', () => ({
  ApiClient: { User: { list: (...a: unknown[]) => list(...a) } },
}))

/** A pristine module graph: fresh EventBus, fresh module-system registry, and a
 *  fresh store proxy whose `storeInitialized` latch is unset. Required because the
 *  latch lives on the PROXY and is cleared only by the ref tracker's own destroy
 *  path — so without this, case 2+ would silently observe case 1's initialised
 *  proxy and assert nothing. */
async function freshGraph() {
  vi.resetModules()
  list.mockReset().mockResolvedValue({ users: [], total: 0, page: 1, per_page: 10 })
  const { useEventBusStore } = await import('@ziee/framework/events')
  const { useModuleSystemStore } = await import('@ziee/framework')
  const { createStoreProxy } = await import('@ziee/framework/stores')
  const { Users, useUsersStore } = await import('@/modules/user/stores/Users.store')
  return { Users, useUsersStore, useModuleSystemStore, createStoreProxy, useEventBusStore }
}

/** `proxy.$` is a SPECIAL property that returns `getState()` and returns EARLY —
 *  before the init block — so it does NOT run `init`. An ACTION read is the
 *  hook-free property access that does. */
const touch = (proxy: { loadUsers?: unknown }) => void proxy.loadUsers

describe('registerLazyStore — one proxy, one lifecycle', () => {
  it('touching the direct handle many times runs `init` (and its fetch) EXACTLY once', async () => {
    const g = await freshGraph()
    expect(list, 'precondition: nothing fetched before first touch').not.toHaveBeenCalled()

    touch(g.Users)
    expect(list).toHaveBeenCalledTimes(1)

    // Every subsequent touch — another action, another component/module reaching
    // for the same handle — must be a no-op for `init`.
    touch(g.Users)
    void g.Users.createUser
    void g.Users.deleteUser
    expect(
      list,
      'a repeat handle read re-ran `init` — the store refetches once per consumer',
    ).toHaveBeenCalledTimes(1)
  })

  it('ALSO registering the store by name (a `stores: [...]` entry) reuses the SAME proxy', async () => {
    const g = await freshGraph()
    touch(g.Users)
    expect(list).toHaveBeenCalledTimes(1)

    // What a module's `stores: [{ name: 'Users', store: useUsersStore }]` entry
    // drives. `registerLazyStore` already put the name in `selfOwnedStores`, so
    // this must keep the self-registered proxy rather than build a rival.
    g.useModuleSystemStore.getState().registerStore('Users', g.Users as never)
    const registered = g.useModuleSystemStore.getState().stores.Users as {
      loadUsers?: unknown
    }

    expect(registered, 'the registry must hand back the SELF-REGISTERED instance').toBe(
      g.Users,
    )
    touch(registered)
    expect(
      list,
      'dual registration produced a second lifecycle — the doubled-fetch bug',
    ).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL: a hand-rolled second proxy DOES double the fetch', async () => {
    const g = await freshGraph()
    touch(g.Users)
    expect(list).toHaveBeenCalledTimes(1)

    // Exactly the anti-pattern the migration must not reintroduce: a rival proxy
    // over the same zustand store, with its own `storeInitialized` latch. If this
    // does NOT reach 2, the two cases above prove nothing.
    const rival = g.createStoreProxy(g.useUsersStore) as { loadUsers?: unknown }
    touch(rival)

    expect(
      list,
      'the guard above cannot fail — this subject never double-fetches, so the ' +
        'other two cases are vacuous',
    ).toHaveBeenCalledTimes(2)
  })
})
