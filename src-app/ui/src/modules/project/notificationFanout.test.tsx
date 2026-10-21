// @vitest-environment jsdom
//
// Accepting a share / transfer from the notification bell is the SAME hole as creating a
// project, in a component instead of a store: `project/handlers.rs` publishes the
// resulting frames to the ACCEPTING user with `origin` applied, so the accepting device
// is the one client the fan-out skips.
//
// The old compensation was a single hand-picked `void Projects.load()` at the call site,
// with a comment noting the suppression. That refreshed the /projects grid and NOTHING
// else — not the sidebar rail, not an open project detail, not the workbench catalog. And
// accepting a TRANSFER is the worst case of the four: BOTH frames the server sends the
// acceptor (`Project`/create and `ProjectTransfer`/update) are suppressed, so the device
// that just received a whole project learned nothing about it.
//
// These cases drive the REAL registered notification renderer, click the REAL button, and
// assert the OUTCOME on the SIDEBAR store — the surface the call site never named.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AppNotification, NotificationRendererCtx } from '@ziee/framework/notification'
import type { ProjectDto } from '@/api-client/types'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

let rows: ProjectDto[] = []
const list = vi.fn(async () => ({ projects: rows, total: rows.length, page: 1, per_page: 20 }))
const acceptShare = vi.fn(async ({ id }: { id: string }) => ({
  id,
  project_id: 'p-shared',
  owner_id: 'u-1',
  recipient_id: 'u-2',
  permission_level: 'editor',
  status: 'accepted',
  created_at: '',
  updated_at: '',
}))
const declineShare = vi.fn(async ({ id }: { id: string }) => ({
  id,
  project_id: 'p-shared',
  owner_id: 'u-1',
  recipient_id: 'u-2',
  permission_level: 'editor',
  status: 'declined',
  created_at: '',
  updated_at: '',
}))
const acceptTransfer = vi.fn(async ({ id }: { id: string }) => ({
  id,
  project_id: 'p-given',
  from_user_id: 'u-1',
  to_user_id: 'u-2',
  status: 'accepted',
  created_at: '',
  updated_at: '',
}))
const declineTransfer = vi.fn(async ({ id }: { id: string }) => ({
  id,
  project_id: 'p-given',
  from_user_id: 'u-1',
  to_user_id: 'u-2',
  status: 'declined',
  created_at: '',
  updated_at: '',
}))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Project: {
      list: (...a: unknown[]) => list(...(a as [])),
      acceptShare: (...a: unknown[]) => acceptShare(...(a as [never])),
      declineShare: (...a: unknown[]) => declineShare(...(a as [never])),
      acceptTransfer: (...a: unknown[]) => acceptTransfer(...(a as [never])),
      declineTransfer: (...a: unknown[]) => declineTransfer(...(a as [never])),
    },
  },
}))

const { getNotificationRenderer } = await import('@ziee/framework/notification')
const { registerProjectNotificationKinds } = await import('./notifications')
const { useRecentProjectsStore } = await import('./stores/RecentProjects.store')

registerProjectNotificationKinds()

const sidebar = () => useRecentProjectsStore.getState()

function notification(kind: string, payload: Record<string, unknown>): AppNotification {
  return {
    id: 'n-1',
    kind,
    title: 't',
    body: null,
    payload,
    read_at: null,
    created_at: '',
  } as unknown as AppNotification
}

const ctx: NotificationRendererCtx = {
  remove: () => {},
  close: () => {},
} as unknown as NotificationRendererCtx

beforeEach(async () => {
  rows = []
  list.mockClear()
  useRecentProjectsStore.setState({
    recentProjects: [], recentTotal: 0, recentPage: 1, recentHasMore: false,
    recentLoading: false, recentLoadingMore: false, recentInitialized: false,
    recentError: null, recentLoadSeq: 0,
  })
  sidebar().__init__.__store__()
  await vi.waitFor(() => expect(sidebar().recentInitialized).toBe(true))
})

afterEach(() => {
  cleanup()
  sidebar().__destroy__()
})

/** Render a kind's action buttons and click one. */
async function clickAction(kind: string, payload: Record<string, unknown>, label: RegExp) {
  const renderer = getNotificationRenderer(kind)
  expect(renderer?.actions, `no actions registered for ${kind}`).toBeTruthy()
  render(<>{renderer!.actions!(notification(kind, payload), ctx)}</>)
  screen.getByRole('button', { name: label }).click()
}

describe('accepting an invite from the bell reaches the sidebar rail', () => {
  it('accepting a TRANSFER puts the received project in the SIDEBAR', async () => {
    rows = [{ id: 'p-given', name: 'Given To Me' } as ProjectDto]
    const before = list.mock.calls.length

    await clickAction('project_transfer_invite', { transfer_id: 't-1' }, /accept/i)

    await vi.waitFor(() => expect(acceptTransfer).toHaveBeenCalled())
    // The rail — a store the call site never mentions — refetched and now holds it.
    await vi.waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThan(before)
      expect(sidebar().recentProjects.map(p => p.name)).toContain('Given To Me')
    })
  })

  it('accepting a SHARE reaches the project-share consumers', async () => {
    const { useProjectsStore } = await import('./stores/Projects.store')
    useProjectsStore.setState({
      projects: [], total: 0, page: 1, search: '', loading: false, loadingMore: false,
      mutating: false, isInitialized: false, error: null, loadSeq: 0,
    })
    useProjectsStore.getState().__init__.__store__()
    await vi.waitFor(() => expect(useProjectsStore.getState().isInitialized).toBe(true))
    rows = [{ id: 'p-shared', name: 'Shared With Me' } as ProjectDto]
    const before = list.mock.calls.length

    await clickAction('project_share_invite', { share_id: 's-1' }, /accept/i)

    await vi.waitFor(() => expect(acceptShare).toHaveBeenCalled())
    await vi.waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThan(before)
      expect(useProjectsStore.getState().projects.map(p => p.name)).toContain('Shared With Me')
    })
    useProjectsStore.getState().__destroy__()
  })

  // WIRE PARITY (supplement, not substitute — see the same block in
  // `stores/localMutationFanout.test.ts`). Accepting a transfer is the only mutation in
  // this module that suppresses TWO frames for the actor, so it is the one case where
  // emitting "a" frame is not the same as emitting the right SET: the sidebar reacts to
  // `project` alone, and a `project_transfer` consumer (the grid, the admin table) would
  // be left behind by an echo that stopped at the first frame.
  it('accepting a TRANSFER echoes BOTH suppressed frames, not just the first', async () => {
    const { useEventBusStore } = await import('@ziee/framework/events')
    const seen: { type: string; action: string; id: string }[] = []
    const bus = useEventBusStore.getState()
    const offs = (['sync:project', 'sync:project_transfer'] as const).map(type =>
      bus.on(type as never, ((e: { type: string; data: { action: string; id: string } }) => {
        seen.push({ type: e.type, action: e.data.action, id: e.data.id })
      }) as never),
    )

    await clickAction('project_transfer_invite', { transfer_id: 't-1' }, /accept/i)
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    for (const off of offs) off()

    expect(seen).toEqual([
      { type: 'sync:project', action: 'create', id: 'p-given' },
      { type: 'sync:project_transfer', action: 'update', id: 't-1' },
    ])
  })

  // The SHARE half of the same wire-parity assertion. It was previously ONE frame,
  // because `accept_share` published the `Project`/create to the actor with
  // `origin: None` — the single frame in the module that arrived on the acting
  // connection instead of being suppressed. That exception is gone: the server now
  // applies `origin` uniformly to every frame addressed to the actor, so accepting a
  // share echoes the same SET accepting a transfer does. Without the second frame, the
  // device that just gained a project would learn nothing about it — exactly the
  // transfer bug, re-created on the share path by a server change.
  it('accepting a SHARE echoes BOTH suppressed frames, not just the share row', async () => {
    const { useEventBusStore } = await import('@ziee/framework/events')
    const seen: { type: string; action: string; id: string }[] = []
    const bus = useEventBusStore.getState()
    const offs = (['sync:project', 'sync:project_share'] as const).map(type =>
      bus.on(type as never, ((e: { type: string; data: { action: string; id: string } }) => {
        seen.push({ type: e.type, action: e.data.action, id: e.data.id })
      }) as never),
    )

    await clickAction('project_share_invite', { share_id: 's-1' }, /accept/i)
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    for (const off of offs) off()

    expect(seen).toEqual([
      { type: 'sync:project_share', action: 'update', id: 's-1' },
      { type: 'sync:project', action: 'create', id: 'p-shared' },
    ])
  })

  it('DECLINING a transfer still notifies the transfer consumers', async () => {
    const { useProjectsStore } = await import('./stores/Projects.store')
    useProjectsStore.setState({
      projects: [], total: 0, page: 1, search: '', loading: false, loadingMore: false,
      mutating: false, isInitialized: false, error: null, loadSeq: 0,
    })
    useProjectsStore.getState().__init__.__store__()
    await vi.waitFor(() => expect(useProjectsStore.getState().isInitialized).toBe(true))
    const before = list.mock.calls.length

    await clickAction('project_transfer_invite', { transfer_id: 't-1' }, /decline/i)

    await vi.waitFor(() => expect(declineTransfer).toHaveBeenCalled())
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
    useProjectsStore.getState().__destroy__()
  })
})
