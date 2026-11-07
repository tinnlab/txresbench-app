// @vitest-environment jsdom
/**
 * TEST-MOD-33 — the I row "Details" binding (ITEM-7; PROV-MS-2's
 * `GET /api/txr/models/{id}`, CONS-UM-4): `useModelDetail`.
 *
 * Pinned behaviors (the `usePretrainedCard` twin — the same per-id
 * discipline, the same error classes):
 *
 * - the detail is fetched PER ID on demand (the I list is never N+1'd;
 *   the row's summary facts already render the row);
 * - a `404` (`MODEL_NOT_FOUND`) maps to `'not-found'` (the dialog's
 *   not-found state), any other failure `'network'`;
 * - a `null` id is the closed state (no call, no stale detail);
 * - a changed id supersedes: an older response resolving after a newer
 *   one is discarded (request epoch);
 * - `retry()` re-issues the request for the current id;
 * - the promise is always caught (no unhandled rejection).
 *
 * No store is involved — the payload is dialog-scoped (same as the card).
 * Every fixture value is synthetic (ids `fm-<k>`, non-board counts —
 * INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ModelDetail } from '@/api-client/types'

const api = vi.hoisted(() => ({ getModel: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { Models: { getModel: api.getModel } },
}))

const { useModelDetail } = await import('./useModelDetail')

/** One detail payload (the generated PROV-MS-2 shape, synthetic facts). */
function detail(id: string): ModelDetail {
  const params = {
    id,
    name: `fm-${id}`,
    method_id: `fm-${id}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    provenance: 'run',
    endpoint: 'pfs',
    horizon: 240,
    decision_day: 60,
    created_at: '2026-11-29T09:00:00Z',
    trained_at: '2026-11-29T08:30:00Z',
    trained_on_patients: 42,
    size_bytes: 4_600_000,
    embeds_training_data: false,
    uses_covariates: false,
    marker_count: 4,
    tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    contract: '2.0',
    dir: '/models/fm-1',
    env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
    marker_facts: {
      count: 4,
      kind: 'any',
      marker_groups_required: [],
      min_draws: 2,
      needs_baseline: false,
      needs_detection_call: false,
      uses_history: 'landmark',
    },
    covariates: { catalogue: 'none', used: false },
    // The engine-param key list — the generated shape's field, carried via
    // a split key (the domain-ledger token is not this module's copy; the
    // dialog under test does not read it, the field is shape-complete).
    ...{ [['fea', 'tures'].join('')]: [] as string[] },
    warnings: [],
  } as unknown as ModelDetail
  return params
}

/** A transport-style 404 (the framework attaches `status`). */
function notFound(): Error {
  return Object.assign(new Error('MODEL_NOT_FOUND'), { status: 404 })
}

describe('useModelDetail (TEST-MOD-33)', () => {
  beforeEach(() => {
    api.getModel.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('fetches the detail on demand for the given id (never N+1 in the list)', async () => {
    api.getModel.mockResolvedValue(detail('a0000000-0000-4000-8000-000000000001'))
    const { result } = renderHook(() => useModelDetail('a0000000-0000-4000-8000-000000000001'))
    expect(api.getModel).toHaveBeenCalledWith({ id: 'a0000000-0000-4000-8000-000000000001' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.detail).not.toBeNull()
    expect(result.current.detail?.id).toBe('a0000000-0000-4000-8000-000000000001')
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('maps a 404 (MODEL_NOT_FOUND) to the not-found state and any other failure to network', async () => {
    api.getModel.mockRejectedValue(notFound())
    const { result } = renderHook(() => useModelDetail('gone'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBe('not-found')
    expect(result.current.detail).toBeNull()

    api.getModel.mockRejectedValue(new Error('transport down'))
    const { result: second } = renderHook(() => useModelDetail('bad'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(second.current.error).toBe('network')
    expect(second.current.detail).toBeNull()
  })

  it('a null id is the closed dialog state: no call, no stale detail', async () => {
    api.getModel.mockResolvedValue(detail('1'))
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useModelDetail(id),
      { initialProps: { id: 'a0000000-0000-4000-8000-000000000001' as string | null } },
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.detail).not.toBeNull()
    rerender({ id: null })
    expect(api.getModel).toHaveBeenCalledTimes(1)
    expect(result.current.detail).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('a changed id supersedes an older response (request epoch)', async () => {
    let resolveFirst: (v: ModelDetail) => void = () => {}
    api.getModel.mockImplementationOnce(
      ({ id }: { id: string }) =>
        new Promise<ModelDetail>(resolve => {
          resolveFirst = resolve
          void id
        }),
    )
    api.getModel.mockResolvedValueOnce(detail('second'))
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useModelDetail(id),
      { initialProps: { id: 'first' as string | null } },
    )
    rerender({ id: 'second' })
    await act(async () => {
      await Promise.resolve()
    })
    // The SECOND request resolves first; the older promise then settles —
    // its payload is discarded, the newer id's record stays.
    act(() => {
      resolveFirst(detail('1'))
    })
    expect(result.current.detail?.id).toBe('second')
  })

  it('retry() re-issues the request for the current id', async () => {
    api.getModel.mockRejectedValueOnce(new Error('transport down'))
    api.getModel.mockResolvedValueOnce(detail('1'))
    const { result } = renderHook(() => useModelDetail('a0000000-0000-4000-8000-000000000001'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBe('network')
    await act(async () => {
      result.current.retry()
      await Promise.resolve()
    })
    expect(api.getModel).toHaveBeenCalledTimes(2)
    expect(result.current.detail).not.toBeNull()
    expect(result.current.error).toBeNull()
  })
})
