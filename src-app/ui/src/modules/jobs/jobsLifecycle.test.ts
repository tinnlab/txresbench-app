// jobsLifecycle unit test (DRIFT-4.4) — proves the ONE thing the hoist has to get
// right: the shared lifecycle's `load` fetches through the injected `buildListQuery`
// seam, so the drawer's default path stays project-less (byte-identical to the
// pre-hoist `ApiClient.Jobs.list({ page, per_page })`) while the pane's scoped path
// carries `project_id`, and a `null` query skips the fetch. vitest (node env), the
// only external boundary mocked is `ApiClient.Jobs.list`.
//
// It ALSO pins the notify-and-refetch contract (§7) that replaced the old 3 s poll:
// `subscribeSync` refetches on `sync:job` / `sync:reconnect`, self-gates on `JobsUse`,
// and installs NO timer — so the list is driven by the backend's `SyncEntity::Job`
// frames, never by a wall clock. Those tests fail if the poll is reintroduced OR if the
// sync refetch is dropped (guard the STATE, not the syntax).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api-client'
import type { JobListResponse } from '@/api-client/types'
import type { StoreSet } from '@ziee/framework/store-kit'
import { hasPermissionNow } from '@/core/permissions'
import { createJobsLifecycle, type JobsLifecycleState, type JobsSyncOn } from './jobsLifecycle'

// `subscribeSync`'s refetch self-gates on `hasPermissionNow(JobsUse)`, which reads a
// global auth view the node harness never registers. Mock it so the gate is a knob.
vi.mock('@/core/permissions', () => ({ hasPermissionNow: vi.fn(() => true) }))

/** A minimal set/get pair over `JobsLifecycleState` (immer-style in-place `set`). */
function makeHarness(initial: Partial<JobsLifecycleState> = {}) {
  const state: JobsLifecycleState = {
    jobs: [],
    total: 0,
    page: 1,
    perPage: 10,
    loading: false,
    error: null,
    selectedId: null,
    detail: null,
    detailLoading: false,
    streaming: false,
    ...initial,
  }
  const get = () => state
  const set: StoreSet<JobsLifecycleState> = updater => {
    if (typeof updater === 'function') {
      const ret = updater(state) // draft mutation happens in place
      if (ret) Object.assign(state, ret)
    } else {
      Object.assign(state, updater)
    }
  }
  return { get, set }
}

const emptyPage = (page: number, perPage: number): JobListResponse => ({
  jobs: [],
  page,
  per_page: perPage,
  total: 0,
  total_pages: 0,
})

describe('createJobsLifecycle — the project-scoping seam (DRIFT-4.4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('the default (drawer) builder omits project_id — byte-identical global list', async () => {
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(2, 10))
    const { get, set } = makeHarness({ page: 2, perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
    })

    await lifecycle.load()

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledWith({ page: 2, per_page: 10 })
    expect(listSpy.mock.calls[0][0]).not.toHaveProperty('project_id')
    expect(get().loading).toBe(false)
  })

  it('a scoped (pane) builder carries project_id on the fetch', async () => {
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    const { get, set } = makeHarness({ perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ project_id: 'proj-9', page, per_page: perPage }),
    })

    await lifecycle.load(1)

    expect(listSpy).toHaveBeenCalledWith({ project_id: 'proj-9', page: 1, per_page: 10 })
  })

  it('a null query (unseeded pane) skips the fetch entirely and leaves state untouched', async () => {
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    const { get, set } = makeHarness()
    const lifecycle = createJobsLifecycle(set, get, { buildListQuery: () => null })

    await lifecycle.load()

    expect(listSpy).not.toHaveBeenCalled()
    expect(get().loading).toBe(false)
    expect(get().error).toBeNull()
  })
})

/** A fake store-kit `on`: captures each event's handlers so a test can EMIT the frame
 *  the SSE stream would deliver, then assert what the lifecycle did in response. */
function makeSyncBus() {
  const handlers: Partial<Record<'sync:job' | 'sync:reconnect', Array<() => void>>> = {}
  const on: JobsSyncOn = (event, handler) => {
    ;(handlers[event] ??= []).push(handler)
  }
  const emit = (event: 'sync:job' | 'sync:reconnect') => {
    for (const h of handlers[event] ?? []) h()
  }
  return { on, emit, handlers }
}

describe('createJobsLifecycle — notify-and-refetch, not a poll (§7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // `vi.restoreAllMocks` blanks the module-mocked fn's implementation; re-arm the default.
    vi.mocked(hasPermissionNow).mockReturnValue(true)
  })

  it('subscribeSync registers BOTH sync:job and sync:reconnect (the live-refetch wiring)', () => {
    const { get, set } = makeHarness({ perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
    })
    const bus = makeSyncBus()
    lifecycle.subscribeSync(bus.on)
    expect(bus.handlers['sync:job']).toHaveLength(1)
    expect(bus.handlers['sync:reconnect']).toHaveLength(1)
  })

  it('a sync:job frame REFETCHES the list through the scoped builder', async () => {
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    const { get, set } = makeHarness({ perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ project_id: 'proj-9', page, per_page: perPage }),
    })
    const bus = makeSyncBus()
    lifecycle.subscribeSync(bus.on)
    expect(listSpy).not.toHaveBeenCalled() // subscribing alone fetches nothing

    bus.emit('sync:job')
    await Promise.resolve() // let the async `load` settle
    // The refetch happened AND carried the pane's scope — proof the path is real, not a
    // no-op sink reading as wired. This assertion fails if the sync refetch is dropped.
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledWith({ project_id: 'proj-9', page: 1, per_page: 10 })
  })

  it('a sync:reconnect frame also refetches (the list may have moved while the stream was down)', async () => {
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    const { get, set } = makeHarness({ perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
    })
    const bus = makeSyncBus()
    lifecycle.subscribeSync(bus.on)

    bus.emit('sync:reconnect')
    await Promise.resolve()
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('the refetch SELF-GATES on JobsUse — no doomed 403 on reconnect', async () => {
    // The negative control for the no-403-on-reconnect rule: without the perm, a
    // `sync:reconnect` (which fans to EVERY store regardless of audience) must NOT fetch.
    vi.mocked(hasPermissionNow).mockReturnValue(false)
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    const { get, set } = makeHarness({ perPage: 10 })
    const lifecycle = createJobsLifecycle(set, get, {
      buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
    })
    const bus = makeSyncBus()
    lifecycle.subscribeSync(bus.on)

    bus.emit('sync:job')
    bus.emit('sync:reconnect')
    await Promise.resolve()
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('installs NO timer — advancing the clock triggers ZERO fetches (guards against a poll)', async () => {
    // The poll this replaced was a 3 s `setInterval`. Prove the state: no timer is armed,
    // so no amount of elapsed wall-clock time drives a fetch. This test FAILS if anyone
    // reintroduces `setInterval`/`setTimeout`-driven polling into the lifecycle.
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage(1, 10))
    try {
      const { get, set } = makeHarness({ perPage: 10 })
      const lifecycle = createJobsLifecycle(set, get, {
        buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
      })
      const bus = makeSyncBus()
      lifecycle.subscribeSync(bus.on)

      // No frame emitted; only time passes — a poll would fire here.
      vi.advanceTimersByTime(30_000) // 10× the old 3 s cadence
      expect(setIntervalSpy).not.toHaveBeenCalled()
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
