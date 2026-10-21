// @vitest-environment jsdom
//
// The status-bar jobs store refetches on `sync:job` now, not on a 3 s poll. Its `load` keeps an
// in-flight guard (so a burst of frames can't run two loads that both read `prevStatus` before
// either writes and double-evaluate a transition). With the recovering poll GONE, that guard must
// not simply DROP a frame that lands mid-load: the last transition of a concurrent-completion
// burst would be lost — no completion toast, and the running count stranded above zero until some
// unrelated later frame. So a frame arriving while a load is in flight sets `pending`, and the
// in-flight load re-runs ONCE on completion (trailing edge). This pins that: a `load()` issued
// during an in-flight `load()` produces exactly ONE follow-up fetch — not zero (dropped) and not
// one-per-frame. Delete the trailing-edge re-run and this fails; drop the in-flight guard and it
// also fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: vi.fn(() => true) }))
vi.mock('@/modules/jobs/jobNames', () => ({ rememberJobNames: vi.fn() }))
vi.mock('./regions/openPane', () => ({ revealPane: vi.fn() }))

import { ApiClient } from '@/api-client'
import type { JobListResponse } from '@/api-client/types'
import { StatusBarJobsStore } from './statusBarJobsStore'

const emptyPage: JobListResponse = { jobs: [], page: 1, per_page: 50, total: 0, total_pages: 0 }
const flush = () => new Promise(r => setTimeout(r, 0))

describe('StatusBarJobsStore — a mid-load sync frame is coalesced, never dropped', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => cleanup())

  it('a load() during an in-flight load() triggers exactly ONE trailing refetch', async () => {
    // The first list call hangs until we release it (a load still in flight); later calls resolve.
    let releaseFirst!: () => void
    const listSpy = vi.spyOn(ApiClient.Jobs, 'list').mockResolvedValue(emptyPage)
    listSpy.mockImplementationOnce(
      () => new Promise<JobListResponse>(res => (releaseFirst = () => res(emptyPage))),
    )

    const { result } = renderHook(() => StatusBarJobsStore.use({ projectId: 'p1' }))

    // Load #1 — begins and hangs (in flight).
    act(() => result.current.start('p1'))
    expect(listSpy).toHaveBeenCalledTimes(1)

    // A `sync:job` frame lands WHILE #1 is in flight → the guard defers it (no immediate fetch).
    act(() => void result.current.load())
    expect(listSpy).toHaveBeenCalledTimes(1)

    // Release #1: its trailing edge fires the deferred refetch exactly once.
    await act(async () => {
      releaseFirst()
      await flush()
    })
    expect(listSpy).toHaveBeenCalledTimes(2)

    // …and it settles — no runaway re-run loop once the queue is drained.
    await act(async () => {
      await flush()
    })
    expect(listSpy).toHaveBeenCalledTimes(2)
  })
})
