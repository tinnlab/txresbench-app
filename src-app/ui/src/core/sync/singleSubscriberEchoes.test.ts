// A store that refreshed itself instead of the channel.
//
// `Notifications.markRead/readAll/remove` each ended with a private inline `load()`.
// It has exactly ONE subscriber today, so it was not a HOLE — nothing on screen was
// stale. It was DRIFT: the acting tab refreshed by one mechanism (a call at the
// mutation site) and every other device by another (`sync:<entity>` → refetch), which
// is the precise shape that produced the project-sidebar bug (`c4ce3b4e`) and the
// dataset-catalog bug (`a3a44296`). In both of those the second consumer arrived later,
// and the mutation site was not updated, because nothing about a private reload says
// "there is a channel you are bypassing".
//
// The fix is the same one `localEcho.ts` argues for: the echo IS the acting tab's
// refresh path, so a store cannot tell a local mutation from a remote one, and the next
// consumer to subscribe is served with no edit at the mutation site.
//
// These cases assert BOTH halves — the surface still refreshes (outcome), and the frame
// that makes it refresh went on the shared channel (wire parity). The outcome alone
// passes against the inline reload; the parity assertion is what distinguishes them.
//
// STRIP (single-cell): the `Provenance.recordCapture` half left with the removed
// provenance module; the notification half remains.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

// ── notifications ───────────────────────────────────────────────────────────────────
let notifRows: { id: string; read_at: string | null }[] = []
const notifList = vi.fn(async (_args?: unknown) => ({
  items: notifRows.map(n => ({
    id: n.id,
    kind: 'x',
    title: `n-${n.id}`,
    body: '',
    interrupt: false,
    payload: {},
    read_at: n.read_at,
    created_at: '',
  })),
  unread: notifRows.filter(n => !n.read_at).length,
  total: notifRows.length,
  page: 1,
  per_page: 20,
}))
const markRead = vi.fn(async ({ id }: { id: string }) => {
  const n = notifRows.find(r => r.id === id)
  if (n) n.read_at = 'now'
})
const markAllRead = vi.fn(async (_args?: unknown) => {
  notifRows = notifRows.map(n => ({ ...n, read_at: 'now' }))
})
const notifDelete = vi.fn(async ({ id }: { id: string }) => {
  notifRows = notifRows.filter(r => r.id !== id)
})

vi.mock('@/api-client', () => ({
  ApiClient: {
    Notification: {
      list: (...a: unknown[]) => notifList(...(a as [never])),
      markRead: (...a: unknown[]) => markRead(...(a as [never])),
      markAllRead: () => markAllRead(),
      delete: (...a: unknown[]) => notifDelete(...(a as [never])),
    },
  },
}))

vi.mock('@txresbench/kit', () => ({ message: { info: () => {}, error: () => {}, success: () => {} } }))

const { useEventBusStore } = await import('@txresbench/framework/events')
const { useNotificationsStore } = await import('@/modules/notification/Notifications.store')

const notifs = () => useNotificationsStore.getState()

/** Record frames on the entity under test while `fn` runs. */
async function capture(
  keys: readonly string[],
  fn: () => Promise<unknown>,
): Promise<{ type: string; action: string; id: string }[]> {
  const seen: { type: string; action: string; id: string }[] = []
  const bus = useEventBusStore.getState()
  const offs = keys.map(type =>
    bus.on(type as never, ((e: { type: string; data: { action: string; id: string } }) => {
      seen.push({ type: e.type, action: e.data.action, id: e.data.id })
    }) as never),
  )
  try {
    await fn()
    return seen
  } finally {
    for (const off of offs) off()
  }
}

beforeEach(async () => {
  notifRows = [
    { id: 'n-1', read_at: null },
    { id: 'n-2', read_at: null },
  ]
  for (const m of [notifList, markRead, markAllRead, notifDelete]) {
    m.mockClear()
  }
  useNotificationsStore.setState({ items: [], unread: 0, loading: false, isInitialized: false, toastedIds: [] })
  notifs().__init__.__store__()
  await vi.waitFor(() => expect(notifs().isInitialized).toBe(true))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the notification inbox', () => {
  it('still shows the unread count falling after markRead (outcome)', async () => {
    expect(notifs().unread).toBe(2)
    await notifs().markRead('n-1')
    await vi.waitFor(() => expect(notifs().unread).toBe(1))
  })

  it('still drops a removed notification (outcome)', async () => {
    await notifs().remove('n-1')
    await vi.waitFor(() => expect(notifs().items.map(i => i.id)).toEqual(['n-2']))
  })

  it('refreshes THROUGH the shared channel, not a private reload (wire parity)', async () => {
    const read = await capture(['sync:notification'], () => notifs().markRead('n-1'))
    expect(read).toEqual([{ type: 'sync:notification', action: 'update', id: 'n-1' }])

    const removed = await capture(['sync:notification'], () => notifs().remove('n-2'))
    expect(removed).toEqual([{ type: 'sync:notification', action: 'delete', id: 'n-2' }])

    const all = await capture(['sync:notification'], () => notifs().readAll())
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('sync:notification')
    expect(all[0].action).toBe('update')
  })
})

