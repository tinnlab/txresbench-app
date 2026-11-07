// @vitest-environment jsdom
/**
 * TEST-MOD-35 — the J screen's inventory read (ITEM-8; PROV-MS-2's
 * `GET /api/txr/models` with the server-side `q` filter + the `?set=`
 * focus, CONS-UM-4): `useModelInventory`.
 *
 * Pinned behaviors:
 *
 * - ONE request per (debounced query, set focus) pair: a re-render with
 *   the same pair never refetches; the first read fires immediately (the
 *   debounce is for keystrokes, not mounts);
 * - the query is debounced 250 ms (a burst of keystrokes costs one
 *   round-trip — the `useListEstimate` discipline);
 * - `q` is omitted from the wire body when empty and `set_id` is present
 *   exactly when the set-focus view is active (the provider's optional
 *   params; an empty `q` and an absent `q` are the same read);
 * - the stale-response guard: an older response resolving after a newer
 *   one is discarded (the newer view's rows stay);
 * - a failed read keeps the LAST response (the table never clears to
 *   nothing over a transient error) and surfaces the error line; a failed
 *   FIRST read is the error state with `response === null`;
 * - `refresh()` re-issues the read for the current view (the post-
 *   mutation re-read — import / rename / delete);
 * - `models_dir` rides the response verbatim (the footnote's path, never
 *   per-row).
 *
 * Every fixture value is synthetic (INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ModelListResponse } from '@/api-client/types'

const api = vi.hoisted(() => ({ listModels: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { Models: { listModels: api.listModels } },
}))

const { useModelInventory } = await import('./useModelInventory')
import type { UseModelInventoryResult } from './useModelInventory'

/** A synthetic one-row list payload (the fixture family's counts). */
function listRow(name: string): ModelListResponse {
  return {
    total: 1,
    models_dir: '/home/txr-fixture/models',
    models: [
      {
        id: 'a0000000-0000-4000-8000-000000000011',
        name,
        method_id: 'landmark-cox-current',
        method_version: '2.1.0',
        group: 'g-static-risk',
        group_label: 'Static risk',
        provenance: 'run',
        endpoint: 'pfs',
        horizon: 240,
        decision_day: 60,
        created_at: '2026-11-29T09:00:00Z',
        size_bytes: 4_600_000,
        embeds_training_data: false,
        uses_covariates: true,
      },
    ],
  }
}

const FIRST = listRow('first view')
const SECOND = listRow('second view')

describe('useModelInventory (TEST-MOD-35)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.listModels.mockReset()
    api.listModels.mockResolvedValue(FIRST)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches once per (query, set) pair; the first read fires immediately with no filters', async () => {
    const { result, rerender } = renderHook(() =>
      useModelInventory({ query: '', setId: null }),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledWith({})
    expect(result.current.response).toEqual(FIRST)
    // A re-render with the same pair never refetches.
    rerender()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)
  })

  it('debounces the query 250 ms: one round-trip for a burst of keystrokes', async () => {
    const { rerender } = renderHook(({ q }) => useModelInventory({ query: q, setId: null }), {
      initialProps: { q: '' },
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)

    rerender({ q: 'l' })
    rerender({ q: 'ld' })
    rerender({ q: 'ldh' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249)
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenLastCalledWith({ q: 'ldh' })
  })

  it('carries q when set and set_id when the set-focus view is active', async () => {
    const { rerender } = renderHook<
      UseModelInventoryResult,
      { q: string; setId: string | null }
    >(
      ({ q, setId }) => useModelInventory({ query: q, setId }),
      { initialProps: { q: '', setId: null } },
    )
    await act(async () => {
      await Promise.resolve()
    })
    rerender({ q: 'ldh', setId: 'set-a' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenLastCalledWith({ q: 'ldh', set_id: 'set-a' })

    rerender({ q: '', setId: 'set-a' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenLastCalledWith({ set_id: 'set-a' })
  })

  it('discards an older response that resolves after a newer one', async () => {
    let resolveFirst: (v: ModelListResponse) => void = () => {}
    let resolveSecond: (v: ModelListResponse) => void = () => {}
    api.listModels.mockImplementationOnce(
      () =>
        new Promise<ModelListResponse>(resolve => {
          resolveFirst = resolve
        }),
    )
    api.listModels.mockImplementationOnce(
      () =>
        new Promise<ModelListResponse>(resolve => {
          resolveSecond = resolve
        }),
    )
    const { result, rerender } = renderHook(({ q }) => useModelInventory({ query: q, setId: null }), {
      initialProps: { q: '' },
    })
    rerender({ q: 'ldh' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(api.listModels).toHaveBeenCalledTimes(2)
    act(() => {
      resolveSecond(SECOND)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.response).toEqual(SECOND)
    act(() => {
      resolveFirst(FIRST)
    })
    await act(async () => {
      await Promise.resolve()
    })
    // The stale (older) response is discarded — the newer view's rows stay.
    expect(result.current.response).toEqual(SECOND)
  })

  it('a failed read keeps the last response and surfaces the error line', async () => {
    const { result, rerender } = renderHook(({ q }) => useModelInventory({ query: q, setId: null }), {
      initialProps: { q: '' },
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.response).toEqual(FIRST)
    api.listModels.mockRejectedValue(new Error('transport down'))
    rerender({ q: 'ldh' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
    })
    expect(result.current.response).toEqual(FIRST)
    expect(result.current.error).toBe('transport down')
    expect(result.current.loading).toBe(false)
  })

  it('a failed first read is the error state with no response', async () => {
    api.listModels.mockRejectedValue(new Error('transport down'))
    const { result } = renderHook(() => useModelInventory({ query: '', setId: null }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.response).toBeNull()
    expect(result.current.error).toBe('transport down')
    expect(result.current.loading).toBe(false)
  })

  it('refresh() re-issues the read for the current view', async () => {
    api.listModels.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND)
    const { result } = renderHook(() => useModelInventory({ query: 'ldh', setId: null }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.refresh()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenLastCalledWith({ q: 'ldh' })
    expect(result.current.response).toEqual(SECOND)
  })
})
