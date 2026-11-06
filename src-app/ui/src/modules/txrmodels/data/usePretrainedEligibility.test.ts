// @vitest-environment jsdom
/**
 * TEST-MOD-27 — the D verdict binding (ITEM-5; PROV-PC-8, CONS-UM-19):
 * `usePretrainedEligibility`.
 *
 * Pinned behaviors:
 *
 * - one request per stable key: content-identical inventory rebuilds (same
 *   `stableInventoryKey` hash — the ONE canonicalization) do NOT refetch;
 * - a changed inventory or a changed id set refetches, and the body
 *   carries the ONE inventory object verbatim (the ui-list DEC-15 pin);
 * - single-shot, stale-guarded: an older response resolving after a newer
 *   one never overwrites the newer verdicts (request epoch);
 * - a null inventory is the not-ready state (no call, no verdicts); an
 *   empty id set is the no-models state (synthesized empty response, NO
 *   call — the provider body bounds `model_ids` at 1..=200);
 * - a failed call surfaces `error` and KEEPS the last good response;
 *   `refetch()` re-issues;
 * - defensive: a smaller (partial) provider payload renders the honest
 *   empty/zero verdict set, never a crash.
 *
 * The store runs REAL (its verdict slice is the SAVED-model one — PROV-MS-9
 * — this hook owns the D verdicts; the mocked boundary is
 * `ApiClient.Pretrained.checkEligibility` + the intake GAP read). Every
 * fixture value is synthetic (ids `ps-<k>`, non-board counts — INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type {
  InventoryEligibilityRequest,
  PretrainedEligibilityResponse,
} from '@/api-client/types'

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  checkEligibility: vi.fn(),
  downloadModel: vi.fn(),
  listDownloads: vi.fn(),
  savedList: vi.fn(),
  savedEligibility: vi.fn(),
  setsList: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Pretrained: {
      listModels: api.listModels,
      getModel: api.getModel,
      checkEligibility: api.checkEligibility,
      downloadModel: api.downloadModel,
      listDownloads: api.listDownloads,
    },
    Models: { listModels: api.savedList, checkEligibility: api.savedEligibility },
    ModelSets: { listSets: api.setsList },
  },
}))

const intake = vi.hoisted(() => ({ validation: null as unknown }))
vi.mock('@/modules/txrintake', () => ({
  useTxrIntakeStore: { getState: (): unknown => ({ validation: intake.validation }) },
}))

const { useTxrModelsStore } = await import('../stores/TxrModels.store')
const { usePretrainedEligibility } = await import('./usePretrainedEligibility')

/** A host-shaped analysis inventory (the generated request type). */
function inventory(over: Partial<InventoryEligibilityRequest> = {}): InventoryEligibilityRequest {
  return {
    baseline_max_day: 0,
    covariates: [],
    decision_day: 60,
    markers: [],
    patients: 42,
    ...over,
  }
}

/** One synthetic verdict response (the generated PROV-PC-8 shape). */
function verdicts(ids: string[]): PretrainedEligibilityResponse {
  return {
    models: ids.map(id => ({
      id,
      status: 'can_run' as const,
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate' as const,
      estimated_seconds: 60,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    })),
    total_fit: ids.length,
    total_some: 0,
    total_cannot: 0,
  }
}

const state = () => useTxrModelsStore.getState()

/** Flush the pending promise chain of the mocked client. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('usePretrainedEligibility (TEST-MOD-27)', () => {
  beforeEach(() => {
    state().reset()
    for (const fn of Object.values(api)) fn.mockReset()
    intake.validation = null
  })

  afterEach(() => {
    cleanup()
  })

  it('scores once per stable key and posts the ONE inventory object verbatim', async () => {
    const invA = inventory()
    api.checkEligibility.mockResolvedValueOnce(verdicts(['ps-1', 'ps-2']))
    const { result, rerender } = renderHook(
      ({ inv, ids }: { inv: InventoryEligibilityRequest; ids: string[] }) =>
        usePretrainedEligibility(inv, ids),
      { initialProps: { inv: invA, ids: ['ps-1', 'ps-2'] } },
    )
    await flush()
    expect(api.checkEligibility).toHaveBeenCalledTimes(1)
    const call = api.checkEligibility.mock.calls[0][0] as {
      model_ids: string[]
      inventory: unknown
    }
    expect(call.inventory).toBe(invA)
    expect(call.model_ids).toEqual(['ps-1', 'ps-2'])
    expect(result.current.response?.total_fit).toBe(2)

    // A content-identical rebuild (new object, same hash) never refetches.
    rerender({ inv: inventory(), ids: ['ps-1', 'ps-2'] })
    await flush()
    expect(api.checkEligibility).toHaveBeenCalledTimes(1)
  })

  it('a changed inventory or a changed id set refetches', async () => {
    const invA = inventory()
    const invB = inventory({ patients: 84 })
    // The mock answers per request id set — the response's model list is
    // the ids passed, so the verdict growth is observable.
    api.checkEligibility.mockImplementation((req: { model_ids: string[] }) =>
      Promise.resolve(verdicts(req.model_ids)),
    )
    const { result, rerender } = renderHook(
      ({ inv, ids }: { inv: InventoryEligibilityRequest; ids: string[] }) =>
        usePretrainedEligibility(inv, ids),
      { initialProps: { inv: invA, ids: ['ps-1'] } },
    )
    await flush()
    expect(api.checkEligibility).toHaveBeenCalledTimes(1)

    rerender({ inv: invA, ids: ['ps-1', 'ps-2'] })
    await flush()
    expect(api.checkEligibility).toHaveBeenCalledTimes(2)
    expect(result.current.response?.models.length).toBe(2)

    rerender({ inv: invB, ids: ['ps-1', 'ps-2'] })
    await flush()
    expect(api.checkEligibility).toHaveBeenCalledTimes(3)
    expect((api.checkEligibility.mock.calls[2][0] as { inventory: unknown }).inventory).toBe(invB)
  })

  it('discards a stale resolve — the newer key\'s verdicts stay', async () => {
    const invA = inventory()
    const invB = inventory({ patients: 84 })
    let resolveA!: (v: PretrainedEligibilityResponse) => void
    let resolveB!: (v: PretrainedEligibilityResponse) => void
    api.checkEligibility
      .mockReturnValueOnce(
        new Promise<PretrainedEligibilityResponse>(r => {
          resolveA = r
        }),
      )
      .mockReturnValueOnce(
        new Promise<PretrainedEligibilityResponse>(r => {
          resolveB = r
        }),
      )
    const { result, rerender } = renderHook(
      ({ inv }: { inv: InventoryEligibilityRequest }) => usePretrainedEligibility(inv, ['ps-1']),
      { initialProps: { inv: invA } },
    )
    rerender({ inv: invB })
    await act(async () => {
      resolveB(verdicts(['ps-1']))
      await Promise.resolve()
    })
    expect(result.current.response?.total_fit).toBe(1)

    await act(async () => {
      resolveA(verdicts(['ps-1', 'ps-2']))
      await Promise.resolve()
    })
    // The newer (B) verdicts win even though A resolves later.
    expect(result.current.response?.total_fit).toBe(1)
    expect(result.current.response?.models.length).toBe(1)
  })

  it('a null inventory is the not-ready state: no call, no verdicts', async () => {
    const { result } = renderHook(() => usePretrainedEligibility(null, ['ps-1']))
    await flush()
    expect(api.checkEligibility).not.toHaveBeenCalled()
    expect(result.current.response).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('an empty id set is the no-models state: a synthesized empty response, no call', async () => {
    const { result } = renderHook(() => usePretrainedEligibility(inventory(), []))
    await flush()
    expect(api.checkEligibility).not.toHaveBeenCalled()
    expect(result.current.response).toEqual({ models: [], total_fit: 0, total_some: 0, total_cannot: 0 })
  })

  it('a failed call surfaces the error and keeps the last response; refetch re-issues', async () => {
    const invA = inventory()
    api.checkEligibility
      .mockResolvedValueOnce(verdicts(['ps-1']))
      .mockRejectedValueOnce(new Error('verdicts down'))
      .mockResolvedValueOnce(verdicts(['ps-1', 'ps-2']))
    const { result } = renderHook(() => usePretrainedEligibility(invA, ['ps-1']))
    await flush()
    expect(result.current.response?.total_fit).toBe(1)

    await act(async () => {
      result.current.refetch()
      await Promise.resolve()
    })
    expect(result.current.error).toBe('verdicts down')
    expect(result.current.response?.total_fit).toBe(1) // kept across the failure

    await act(async () => {
      result.current.refetch()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.response?.models.length).toBe(2)
    expect(api.checkEligibility).toHaveBeenCalledTimes(3)
  })

  it('defensive: a partial payload renders the honest empty verdict set, never a crash', async () => {
    // A provider payload smaller than the declared shape (the drift-guard
    // case): the `?? []` / `?? 0` reads keep the screen alive.
    api.checkEligibility.mockResolvedValueOnce({} as unknown as PretrainedEligibilityResponse)
    const { result } = renderHook(() => usePretrainedEligibility(inventory(), ['ps-1']))
    await flush()
    expect(result.current.loading).toBe(false)
    expect(result.current.response).toEqual({ models: [], total_fit: 0, total_some: 0, total_cannot: 0 })
    expect(result.current.error).toBeNull()
  })
})
