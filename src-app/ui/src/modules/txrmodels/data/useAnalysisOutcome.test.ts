// @vitest-environment jsdom
/**
 * TEST-MOD-34 — the I screen's outcome-facts read (ITEM-7; the
 * "Same outcome as my file" chip's `TxrOutcomeMatch` source):
 * `useAnalysisOutcome`.
 *
 * Pinned behaviors:
 *
 * - fetched ONCE per screen mount (a re-render never refetches; a remount
 *   gets one fresh request);
 * - the engine's sticky analysis config (PROV-EE-8) is read RAW: the
 *   stored endpoint + `look_ahead_day`, NO fallback to the engine's
 *   default settings — an unset config renders `{ endpoint: null,
 *   lookAheadDay: null }`, and the chip's rule (ITEM-4) matches NOTHING
 *   for null facts (a count honest about an unset outcome; a defaulted
 *   fact would fabricate a match);
 * - a read failure also lands the null pair (the chip's honest zero
 *   count; the list's own error surface is untouched by this secondary
 *   read);
 * - unmount discards the response (no write after unmount).
 *
 * Every fixture value is synthetic (INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { TxrAppConfig } from '@/api-client/types'

const api = vi.hoisted(() => ({ getAnalysisConfig: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { Txr: { getAnalysisConfig: api.getAnalysisConfig } },
}))

const { useAnalysisOutcome } = await import('./useAnalysisOutcome')

describe('useAnalysisOutcome (TEST-MOD-34)', () => {
  beforeEach(() => {
    api.getAnalysisConfig.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reads the engine config once per mount: the stored endpoint + look-ahead day pair', async () => {
    api.getAnalysisConfig.mockResolvedValue({
      config: { endpoint: 'pfs', look_ahead_day: 240 },
    } as TxrAppConfig)
    const { result, rerender } = renderHook(() => useAnalysisOutcome())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toEqual({ endpoint: 'pfs', lookAheadDay: 240 })
    // A re-render never refetches.
    rerender()
    expect(api.getAnalysisConfig).toHaveBeenCalledTimes(1)
  })

  it('an unset config is the null pair (no default fallback — a fabricated match is worse than none)', async () => {
    api.getAnalysisConfig.mockResolvedValue({} as TxrAppConfig)
    const { result } = renderHook(() => useAnalysisOutcome())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toEqual({ endpoint: null, lookAheadDay: null })
  })

  it('a config with one half set carries the half and nulls the other', async () => {
    api.getAnalysisConfig.mockResolvedValue({
      config: { endpoint: 'os' },
    } as TxrAppConfig)
    const { result } = renderHook(() => useAnalysisOutcome())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toEqual({ endpoint: 'os', lookAheadDay: null })
  })

  it('a failed read is an unset outcome (the null pair — the chip count 0, no error line)', async () => {
    api.getAnalysisConfig.mockRejectedValue(new Error('transport down'))
    const { result } = renderHook(() => useAnalysisOutcome())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toEqual({ endpoint: null, lookAheadDay: null })
  })

  it('unmount discards the response (no write after unmount)', async () => {
    let resolveConfig: (v: TxrAppConfig) => void = () => {}
    api.getAnalysisConfig.mockImplementation(
      () =>
        new Promise<TxrAppConfig>(resolve => {
          resolveConfig = resolve
        }),
    )
    const { unmount } = renderHook(() => useAnalysisOutcome())
    unmount()
    act(() => {
      resolveConfig({ config: { endpoint: 'pfs', look_ahead_day: 240 } } as TxrAppConfig)
    })
    expect(api.getAnalysisConfig).toHaveBeenCalledTimes(1)
  })
})
