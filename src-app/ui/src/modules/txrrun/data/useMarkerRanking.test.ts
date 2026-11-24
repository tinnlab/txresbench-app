// @vitest-environment jsdom
/**
 * `useMarkerRanking` (single-marker-choice round 2): the debounced
 * step-4 ranking fetch — ONE call for a burst of endpoint/day/choice
 * changes, keyed by request CONTENT, the stale-response epoch guard, and
 * `null` request (demo / no validation) = nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { MarkerRankingRequest, MarkerRankingResponse } from '@/api-client/types'
import { MARKER_RANKING_DEBOUNCE_MS, useMarkerRanking } from './useMarkerRanking'

const api = vi.hoisted(() => ({
  markerRanking: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      markerRanking: api.markerRanking,
    },
  },
}))

function request(over: Partial<MarkerRankingRequest> = {}): MarkerRankingRequest {
  return {
    decision_day: 56,
    endpoint: 'pfs',
    measurements: {
      columns: ['patient', 'day', 'ctdna_mm'],
      header_row: 1,
      rows: [],
      source: { format: 'csv', name: 'measurements.csv' },
    },
    ...over,
  }
}

function answer(over: Partial<MarkerRankingResponse> = {}): MarkerRankingResponse {
  return {
    markers_by_kind: { any: [], multi: {}, single: [] },
    offered: [],
    ranking: [],
    ranking_patients: 0,
    top: [],
    ...over,
  }
}

beforeEach(() => {
  api.markerRanking.mockReset()
  api.markerRanking.mockResolvedValue(answer({ top: ['ctdna_mm'] }))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanup()
})

describe('useMarkerRanking', () => {
  it('calls the route with the request after the debounce and surfaces the answer', async () => {
    const { result } = renderHook(() => useMarkerRanking(request()))
    expect(result.current.loading).toBe(true)
    expect(api.markerRanking).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    expect(api.markerRanking).toHaveBeenCalledWith(request())
    expect(result.current.response).toEqual(answer({ top: ['ctdna_mm'] }))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('debounces a burst of choice/day changes into ONE call for the last request', async () => {
    const { rerender } = renderHook(
      ({ r }: { r: MarkerRankingRequest }) => useMarkerRanking(r),
      { initialProps: { r: request() } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    rerender({ r: request({ decision_day: 28 }) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    rerender({ r: request({ decision_day: 84, endpoint: 'os' }) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    expect(api.markerRanking).toHaveBeenCalledWith(request({ decision_day: 84, endpoint: 'os' }))
  })

  it('a content-identical rebuild never refetches', async () => {
    const first = request()
    const { rerender } = renderHook(
      ({ r }: { r: MarkerRankingRequest }) => useMarkerRanking(r),
      { initialProps: { r: first } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    rerender({ r: { ...first, measurements: { ...first.measurements } } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
  })

  it('a new request drops the previous answer and waits for its own', async () => {
    const { result, rerender } = renderHook(
      ({ r }: { r: MarkerRankingRequest | null }) => useMarkerRanking(r),
      { initialProps: { r: request() } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    expect(result.current.response).toEqual(answer({ top: ['ctdna_mm'] }))
    rerender({ r: request({ decision_day: 84 }) })
    // The old answer is gone while the new one loads.
    expect(result.current.response).toBeNull()
    expect(result.current.loading).toBe(true)
  })

  it('a failure surfaces the message and no response', async () => {
    api.markerRanking.mockRejectedValue(new Error('route down'))
    const { result } = renderHook(() => useMarkerRanking(request()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.response).toBeNull()
    expect(result.current.error).toBe('route down')
    expect(result.current.loading).toBe(false)
  })

  it('a malformed answer (the mock\'s unseeded `[]`) is a failure, never a response the readers touch (round 2c)', async () => {
    // The gallery mock answers an endpoint without a cassette entry with
    // `[]` — `response.top` would be `undefined` and the old render-time
    // readers threw on it.
    api.markerRanking.mockResolvedValue([] as unknown as MarkerRankingResponse)
    const { result } = renderHook(() => useMarkerRanking(request()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    expect(result.current.response).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).not.toBeNull()
  })

  it('null request (demo / no validation) does nothing', () => {
    const { result } = renderHook(() => useMarkerRanking(null))
    expect(result.current.response).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(api.markerRanking).not.toHaveBeenCalled()
  })

  it('refetch asks again for the settled request', async () => {
    const { result } = renderHook(() => useMarkerRanking(request()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.refetch()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MARKER_RANKING_DEBOUNCE_MS)
    })
    expect(api.markerRanking).toHaveBeenCalledTimes(2)
  })
})
