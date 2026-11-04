// @vitest-environment jsdom
/**
 * TEST-UL-7 — txrlist `useListEstimate` (PROV-UI-LIST-3): the bottom-bar
 * total hook.
 *
 * Pinned behaviors:
 *
 * - the selection change is debounced 250 ms — a burst of selection changes
 *   issues ONE `MethodCatalogue.estimate` call, with the last selection's
 *   ids, `patients`, `cpus` (4 default) and `at_a_time`;
 * - the response's `total_seconds` / `schedule_seconds` become the totals;
 * - loading is true while a request is in flight and the previous totals are
 *   kept (the bottom bar's "…" slot);
 * - a stale (out-of-order) response is discarded — only the newest request
 *   writes state;
 * - an empty selection: null totals and NO call; the per-set estimate cache
 *   survives the empty selection, so re-selecting the same set restores the
 *   totals without a call (selection-contract "does NOT clear the estimate
 *   cache"); the cache is keyed on the estimate's arguments too, so a
 *   changed `atATime` re-estimates;
 * - a failed call: error + null totals.
 *
 * The ApiClient is mocked per the `Datasets.store` test precedent; the
 * fixtures are the provider's generated wire types (DEC-11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EstimateResponse } from '@/api-client/types'
import { useListEstimate } from './useListEstimate'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  eligibility: vi.fn(),
  estimate: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
      eligibility: api.eligibility,
      estimate: api.estimate,
    },
  },
}))

/** An estimate response fixture with the two totals the bar renders. */
function estimateResponse(totalSeconds: number, scheduleSeconds: number): EstimateResponse {
  return { methods: [], at_a_time: 3, total_seconds: totalSeconds, schedule_seconds: scheduleSeconds }
}

/** A manually resolvable promise (the request stays in flight until told). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  api.estimate.mockReset()
  api.estimate.mockResolvedValue(estimateResponse(120, 840))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useListEstimate (TEST-UL-7)', () => {
  it('debounces 250 ms and issues ONE estimate call for a burst of selection changes', async () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useListEstimate(ids, { patients: 151, atATime: 3 }),
      { initialProps: { ids: ['direct-on'] } },
    )
    // A burst before the debounce elapses: only the NEWEST selection is sent.
    rerender({ ids: ['direct-on', 'dynforest'] })
    rerender({ ids: ['direct-on', 'dynforest', 'shallow'] })
    expect(api.estimate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249)
    })
    expect(api.estimate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(api.estimate).toHaveBeenCalledTimes(1)
    expect(api.estimate).toHaveBeenCalledWith({
      method_ids: ['direct-on', 'dynforest', 'shallow'],
      patients: 151,
      cpus: 4,
      at_a_time: 3,
    })
    expect(result.current.totalSeconds).toBe(120)
    expect(result.current.scheduleSeconds).toBe(840)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('passes the host cpus override and atATime in the estimate body', async () => {
    renderHook(() => useListEstimate(['a'], { patients: 38, cpus: 2, atATime: 1 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledWith({
      method_ids: ['a'],
      patients: 38,
      cpus: 2,
      at_a_time: 1,
    })
  })

  it('reports loading while in flight and keeps the previous totals (the "…" slot)', async () => {
    const first = deferred<EstimateResponse>()
    api.estimate.mockReturnValueOnce(first.promise)
    const { result, rerender } = renderHook(
      ({ ids }) => useListEstimate(ids, { patients: 151, atATime: 3 }),
      { initialProps: { ids: ['a'] } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.loading).toBe(true)
    expect(result.current.scheduleSeconds).toBeNull()

    await act(async () => {
      first.resolve(estimateResponse(120, 840))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.scheduleSeconds).toBe(840)

    const second = deferred<EstimateResponse>()
    api.estimate.mockReturnValueOnce(second.promise)
    rerender({ ids: ['a', 'b'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.loading).toBe(true)
    expect(result.current.scheduleSeconds).toBe(840)

    await act(async () => {
      second.resolve(estimateResponse(180, 1000))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.scheduleSeconds).toBe(1000)
    expect(result.current.loading).toBe(false)
  })

  it('discards an out-of-order response (only the newest request writes state)', async () => {
    const older = deferred<EstimateResponse>()
    const newer = deferred<EstimateResponse>()
    api.estimate.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderHook(
      ({ ids }) => useListEstimate(ids, { patients: 151, atATime: 3 }),
      { initialProps: { ids: ['a'] } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledTimes(1)

    rerender({ ids: ['a', 'b'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledTimes(2)

    // The newer response lands first, then the older one — the older epoch
    // must be discarded, and the newer totals stay.
    await act(async () => {
      newer.resolve(estimateResponse(200, 140))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      older.resolve(estimateResponse(800, 700))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.totalSeconds).toBe(200)
    expect(result.current.scheduleSeconds).toBe(140)
    expect(result.current.error).toBeNull()
  })

  it('empty selection: null totals and NO estimate call; the cache survives re-selection', async () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useListEstimate(ids, { patients: 151, atATime: 3 }),
      { initialProps: { ids: ['a'] } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledTimes(1)
    expect(result.current.scheduleSeconds).toBe(840)

    // Unchecking the last row: null totals, no new request.
    rerender({ ids: [] })
    expect(result.current.totalSeconds).toBeNull()
    expect(result.current.scheduleSeconds).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(api.estimate).toHaveBeenCalledTimes(1)

    // The per-set estimate cache is NOT cleared by the empty selection:
    // re-selecting the same set restores the totals with no request.
    rerender({ ids: ['a'] })
    expect(result.current.scheduleSeconds).toBe(840)
    expect(result.current.loading).toBe(false)
    expect(api.estimate).toHaveBeenCalledTimes(1)
  })

  it('a changed atATime re-estimates (the cache is keyed on the arguments too)', async () => {
    const { result, rerender } = renderHook(
      ({ atATime }) => useListEstimate(['a'], { patients: 151, atATime }),
      { initialProps: { atATime: 3 } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledWith(
      expect.objectContaining({ at_a_time: 3 }),
    )

    rerender({ atATime: 5 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.estimate).toHaveBeenCalledTimes(2)
    expect(api.estimate).toHaveBeenLastCalledWith(
      expect.objectContaining({ at_a_time: 5 }),
    )
    expect(result.current.loading).toBe(false)
  })

  it('a failed call: error + null totals (the thrown message)', async () => {
    api.estimate.mockRejectedValueOnce(new Error('estimate exploded'))
    const { result } = renderHook(() => useListEstimate(['a'], { patients: 151, atATime: 3 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.error).toBe('estimate exploded')
    expect(result.current.totalSeconds).toBeNull()
    expect(result.current.scheduleSeconds).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('a non-Error throw falls back to the constant error line', async () => {
    api.estimate.mockRejectedValueOnce('nope')
    const { result } = renderHook(() => useListEstimate(['a'], { patients: 151, atATime: 3 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.error).toBe('Failed to estimate methods')
  })
})
