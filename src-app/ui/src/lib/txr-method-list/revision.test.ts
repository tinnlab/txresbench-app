// @vitest-environment jsdom
/**
 * The method list revision (PR 5): the sequence the screens last saw, the revision that
 * moves when it changes (and drops the registered caches first), and the status poll of
 * a mounted method screen (mount, window focus, every 10 minutes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { MethodListStatus } from '@/api-client/types'
import {
  STATUS_POLL_MS,
  __resetMethodListRevisionForTests,
  checkForMethodUpdates,
  noteMethodListSequence,
  onMethodListChange,
  shownMethodListSequence,
  useMethodListRevision,
  useMethodListUpdates,
} from './revision'

const api = vi.hoisted(() => ({ updates: vi.fn(), checkUpdates: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { MethodList: { updates: api.updates, checkUpdates: api.checkUpdates } },
}))

function status(sequence: number, over: Partial<MethodListStatus> = {}): MethodListStatus {
  return {
    sequence,
    origin: 'builtin',
    assembled_at: '2026-11-20T10:00:00Z',
    updates_enabled: true,
    last_check: 'current',
    ...over,
  }
}

beforeEach(() => {
  __resetMethodListRevisionForTests()
  api.updates.mockReset()
  api.checkUpdates.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('noteMethodListSequence', () => {
  it('the first sequence only sets it; a new one moves the revision and drops the caches first', () => {
    const dropped = vi.fn()
    const off = onMethodListChange(dropped)
    const { result } = renderHook(() => useMethodListRevision())
    act(() => noteMethodListSequence(3))
    expect(shownMethodListSequence()).toBe(3)
    expect(result.current).toBe(0)
    expect(dropped).not.toHaveBeenCalled()
    act(() => noteMethodListSequence(3))
    expect(result.current).toBe(0)
    act(() => noteMethodListSequence(4))
    expect(result.current).toBe(1)
    expect(dropped).toHaveBeenCalledTimes(1)
    act(() => noteMethodListSequence(undefined))
    expect(shownMethodListSequence()).toBe(4)
    off()
  })
})

describe('useMethodListUpdates', () => {
  it('reads the status on mount, on window focus and every 10 minutes', async () => {
    vi.useFakeTimers()
    api.updates.mockResolvedValue(status(1))
    const { result, unmount } = renderHook(() => useMethodListUpdates())
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.updates).toHaveBeenCalledTimes(1)
    expect(result.current?.sequence).toBe(1)

    api.updates.mockResolvedValue(status(2))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(api.updates).toHaveBeenCalledTimes(2)
    expect(result.current?.sequence).toBe(2)
    expect(shownMethodListSequence()).toBe(2)

    await act(async () => {
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await Promise.resolve()
    })
    expect(api.updates).toHaveBeenCalledTimes(3)

    // Unmounted: no more reads.
    unmount()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      vi.advanceTimersByTime(STATUS_POLL_MS)
      await Promise.resolve()
    })
    expect(api.updates).toHaveBeenCalledTimes(3)
  })

  it('a failed read keeps the last status', async () => {
    api.updates.mockResolvedValueOnce(status(5)).mockRejectedValueOnce(new Error('down'))
    const { result } = renderHook(() => useMethodListUpdates())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(result.current?.sequence).toBe(5)
  })
})

describe('checkForMethodUpdates', () => {
  it('asks the server to check and notes the new list', async () => {
    noteMethodListSequence(1)
    api.checkUpdates.mockResolvedValue(status(2, { last_check: 'updated', origin: 'live' }))
    const answer = await checkForMethodUpdates()
    expect(answer.last_check).toBe('updated')
    expect(api.checkUpdates).toHaveBeenCalledTimes(1)
    expect(shownMethodListSequence()).toBe(2)
  })
})
