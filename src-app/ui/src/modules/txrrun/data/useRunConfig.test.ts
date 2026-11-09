// @vitest-environment jsdom
/**
 * TEST-RUN-07 — txrrun `useRunConfig` (PROV-UI-RUN-4's sticky settings
 * hook, CONS-UI-RUN-6; ITEM-4). The hook is the E screen's engine-bound
 * settings layer: GET `Txr.getAnalysisConfig` on mount, the debounced 400 ms
 * write-through PUT `Txr.updateAnalysisConfig`, the stale guard, the error
 * + retry, and the never-PUT-on-mount rule.
 *
 * Pinned behaviors:
 *
 * - mount issues EXACTLY the GET (never a PUT, whatever the response);
 * - the honest never-configured answer (`config: null`) yields `null`
 *   settings; a present (even partial) config yields the engine-side merge
 *   (`mergeRunSettings`: the engine's fields, the engine's defaults for
 *   whatever the stored config omits);
 * - `update` is debounced + coalesced: a burst of updates within 400 ms
 *   issues ONE PUT carrying the newest value, and every queued update
 *   promise settles with that flush (never rejects, even on failure);
 * - the PUT body is the settings-only write wrapped in `TxrAppConfig`
 *   (`{ ...engine, config: toRunConfig(next) }` — the carried-through
 *   `last_input_summary` from the GET is preserved; the hook never clobbers
 *   data it does not own);
 * - a failed PUT surfaces `error` and keeps the optimistic view; `retry()`
 *   re-PUTs the value the store did not take;
 * - a failed GET surfaces `error`; `retry()` re-GETs and clears it;
 * - the stale guard: `retry()` while a slow GET is in flight discards the
 *   older response entirely;
 * - writes are serialized: an update landing while a PUT is on the wire
 *   queues the next debounce — two PUTs never race, so the engine's sticky
 *   singleton always ends at the newest value (and the older PUT's late
 *   settlement never overwrites the newer local view).
 *
 * The ApiClient is mocked (the `useListEstimate` test precedent); fixtures
 * are the generated wire types, so a regen that reshapes `TxrAppConfig` or
 * `RunConfig` breaks the typecheck here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { RunConfig, TxrAppConfig } from '@/api-client/types'
import { RUN_CONFIG_DEBOUNCE_MS, useRunConfig } from './useRunConfig'
import { toRunConfig, type RunSettings } from '../lib/settings'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getAnalysisConfig: api.get,
      updateAnalysisConfig: api.put,
    },
  },
}))

/** A fully-populated engine config — every field distinct from the default. */
const engineConfig: RunConfig = {
  endpoint: 'os',
  decision_day: 84,
  look_ahead_day: 365,
  covariates: true,
  at_a_time: 4,
  cpus: 2,
  save_models: true,
}

/** A settings value with every field distinct from the defaults. */
const settingsB: RunSettings = {
  endpoint: 'os',
  decision_day: 28,
  look_ahead_day: 180,
  covariates: true,
  at_a_time: 1,
  cpus: 2,
  save_models: true,
}

/** The DEFAULT_RUN_SETTINGS bytes (the defaults of engineConfig's siblings). */
const defaultSettings: RunSettings = {
  endpoint: 'pfs',
  decision_day: 56,
  look_ahead_day: 238,
  covariates: false,
  at_a_time: 3,
  cpus: null,
  save_models: false,
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
  api.get.mockReset()
  api.put.mockReset()
  api.get.mockResolvedValue({ config: null })
  api.put.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the pending promise microtasks + timers (the mount GET's settle). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Advance the run-config debounce (or exactly the window bound). */
async function advanceDebounce(ms: number = RUN_CONFIG_DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useRunConfig (TEST-RUN-07)', () => {
  it('GETs the sticky config once on mount and never PUTs on mount', async () => {
    const { result } = renderHook(() => useRunConfig())
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.put).not.toHaveBeenCalled()
    await settle()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.put).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('maps the honest never-configured answer to null settings (the engine response kept)', async () => {
    api.get.mockResolvedValue({ config: null })
    const { result } = renderHook(() => useRunConfig())
    await settle()
    expect(result.current.settings).toBeNull()
    expect(result.current.engine).toEqual({ config: null })
    expect(result.current.error).toBeNull()
  })

  it('merges a full sticky config over the defaults (the engine-side view)', async () => {
    api.get.mockResolvedValue({ config: engineConfig })
    const { result } = renderHook(() => useRunConfig())
    await settle()
    // The ONE exception to the sticky restore: at_a_time is a RUN option,
    // never sticky (qa-fixes ITEM-2) — the merge lands at the default 3.
    expect(result.current.settings).toEqual({ ...engineConfig, at_a_time: 3 })
    expect(result.current.engine).toEqual({ config: engineConfig })
  })

  it('fills the engine defaults for the fields a partial stored config omits', async () => {
    api.get.mockResolvedValue({ config: { endpoint: 'os' } })
    const { result } = renderHook(() => useRunConfig())
    await settle()
    expect(result.current.settings).toEqual({ ...defaultSettings, endpoint: 'os' })
  })

  it('debounces 400 ms and PUTs ONE coalesced write for a burst of updates', async () => {
    api.get.mockResolvedValue({ config: null })
    const { result } = renderHook(() => useRunConfig())
    await settle()

    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = result.current.update(defaultSettings)
      second = result.current.update(settingsB)
    })
    // The two calls coalesce: the newest value is the optimistic view.
    expect(result.current.settings).toEqual(settingsB)
    expect(api.put).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_CONFIG_DEBOUNCE_MS - 1)
    })
    expect(api.put).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith({ config: toRunConfig(settingsB) })
    // Both queued updates settle with the same flush; neither rejects.
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(result.current.error).toBeNull()
    expect(result.current.settings).toEqual(settingsB)
    expect(result.current.loading).toBe(false)
  })

  it('carries the loaded input summary through the PUT body (writes only the settings fields)', async () => {
    const summary = { patients: 151, predict_patients: 38, markers: 5 }
    api.get.mockResolvedValue({ config: engineConfig, last_input_summary: summary })
    const { result } = renderHook(() => useRunConfig())
    await settle()

    await act(async () => {
      void result.current.update(defaultSettings)
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledWith({
      config: toRunConfig(defaultSettings),
      last_input_summary: summary,
    })
  })

  it('a failed PUT surfaces the error, keeps the optimistic view, and retry re-writes the value', async () => {
    api.get.mockResolvedValue({ config: null })
    api.put.mockRejectedValueOnce(new Error('store full'))
    const { result } = renderHook(() => useRunConfig())
    await settle()

    let write!: Promise<void>
    await act(async () => {
      write = result.current.update(settingsB)
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe('store full')
    // The screen keeps showing what the user chose; the hook's view and the
    // update promise stay honest.
    expect(result.current.settings).toEqual(settingsB)
    await expect(write).resolves.toBeUndefined()

    api.put.mockResolvedValueOnce(undefined)
    await act(async () => {
      result.current.retry()
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(api.put).toHaveBeenLastCalledWith({ config: toRunConfig(settingsB) })
    expect(result.current.error).toBeNull()
    expect(result.current.settings).toEqual(settingsB)
  })

  it('a failed GET surfaces the error and retry re-runs the load', async () => {
    api.get.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ config: null })
    const { result } = renderHook(() => useRunConfig())
    await settle()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe('boom')
    expect(result.current.settings).toBeNull()
    expect(result.current.loading).toBe(false)

    await act(async () => {
      result.current.retry()
    })
    await settle()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.settings).toBeNull()
    expect(result.current.engine).toEqual({ config: null })
    expect(result.current.loading).toBe(false)
  })

  it('discards the older response when retry lands during a slow load (stale guard)', async () => {
    const older = deferred<TxrAppConfig>()
    const newer = deferred<TxrAppConfig>()
    api.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result } = renderHook(() => useRunConfig())
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)

    await act(async () => {
      result.current.retry()
    })
    expect(api.get).toHaveBeenCalledTimes(2)

    // The retry's response lands first, then the stale first response —
    // the stale one must be discarded.
    await act(async () => {
      newer.resolve({ config: engineConfig })
      await vi.advanceTimersByTimeAsync(0)
    })
    // The ONE exception to the sticky restore: at_a_time is a RUN option,
    // never sticky (qa-fixes ITEM-2) — the merge lands at the default 3.
    expect(result.current.settings).toEqual({ ...engineConfig, at_a_time: 3 })

    await act(async () => {
      older.resolve({ config: { endpoint: 'os' } })
      await vi.advanceTimersByTimeAsync(0)
    })
    // The ONE exception to the sticky restore: at_a_time is a RUN option,
    // never sticky (qa-fixes ITEM-2) — the merge lands at the default 3.
    expect(result.current.settings).toEqual({ ...engineConfig, at_a_time: 3 })
    expect(result.current.engine).toEqual({ config: engineConfig })
    expect(result.current.error).toBeNull()
  })

  it('a change saved during the mount load keeps the newer view (the pre-save GET response never reverts it)', async () => {
    const load = deferred<TxrAppConfig>()
    api.get.mockReturnValue(load.promise)
    const { result } = renderHook(() => useRunConfig())

    // The user changes a setting while the mount GET is still in flight.
    await act(async () => {
      void result.current.update(settingsB)
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledTimes(1)

    // The GET resolves AFTER the save with the PRE-save store — the view
    // must stay at the user's newer settings.
    await act(async () => {
      load.resolve({ config: engineConfig })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.settings).toEqual(settingsB)
    expect(result.current.engine?.config).toEqual(toRunConfig(settingsB))
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('serializes writes: an update while a PUT is on the wire waits one more debounce', async () => {
    api.get.mockResolvedValue({ config: null })
    const firstPut = deferred<void>()
    api.put.mockReturnValueOnce(firstPut.promise)
    const { result } = renderHook(() => useRunConfig())
    await settle()

    let first!: Promise<void>
    await act(async () => {
      first = result.current.update(defaultSettings)
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledTimes(1)

    // The change lands while PUT #1 is still on the wire: its timer runs
    // but the flush defers — no second PUT races the first.
    let second!: Promise<void>
    await act(async () => {
      second = result.current.update(settingsB)
    })
    await advanceDebounce()
    expect(api.put).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstPut.resolve()
      await vi.advanceTimersByTimeAsync(RUN_CONFIG_DEBOUNCE_MS)
    })
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(api.put).toHaveBeenLastCalledWith({ config: toRunConfig(settingsB) })
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(result.current.settings).toEqual(settingsB)
    expect(result.current.error).toBeNull()
  })
})
