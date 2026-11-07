// @vitest-environment jsdom
/**
 * TEST-MOD-26 — the D catalogue bindings (ITEM-5; PROV-PC-3/4,
 * CONS-UM-17/18): `usePretrained` + `usePretrainedCard`.
 *
 * Pinned behaviors:
 *
 * - the list is fetched ONCE per screen mount (a re-render does not
 *   refetch — the "stable key" rule; a remount gets one fresh request);
 * - a failure surfaces `error`, `refetch()` is the force-retry path;
 * - the card is fetched PER ID on demand (never N+1); a `404`
 *   (`PRETRAINED_UNKNOWN`) maps to `'not-found'` (the dialog state), any
 *   other failure `'network'`; the promise is always caught;
 * - a `null` card id is the closed state (no call, no stale card);
 * - a changed id supersedes: an older response resolving after a newer
 *   one is discarded (request epoch).
 *
 * The store runs REAL (the D page's fetch path is the store's
 * `loadPretrained` — the SINGLE source of truth; the mocked boundary is
 * `ApiClient.Pretrained.*` + the intake GAP read, the `Datasets.store.test`
 * precedent). Every fixture value is synthetic (ids `ps-<k>`, non-board
 * counts — INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { PretrainedModel, PretrainedSummary } from '@/api-client/types'

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

/** The intake GAP's inventory source (the validation slice decays to null). */
const intake = vi.hoisted(() => ({ validation: null as unknown }))
vi.mock('@/modules/txrintake', () => ({
  useTxrIntakeStore: { getState: (): unknown => ({ validation: intake.validation }) },
}))

const { useTxrModelsStore } = await import('../stores/TxrModels.store')
const { usePretrained, usePretrainedCard } = await import('./usePretrained')

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-4)
// ─────────────────────────────────────────────────────────────────────────────

/** One catalogue card (the generated PROV-PC-3 shape). */
function card(id: string): PretrainedSummary {
  return {
    id,
    version: '1.0.0',
    kind: 'published-rule',
    name: `${id} rule`,
    description: 'A rule from the paper',
    method_id: `m-${id}`,
    method_version: '1.0.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    decision_day: 60,
    endpoint: 'pfs',
    horizon: 240,
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3 },
    warnings: [],
    research_notice: true,
    licence: 'MIT',
    asset: { bundled: false, file: 'id.txr', sha256: 'ab', size_bytes: 1024 },
    state: 'installed',
    installed_model_id: `inst-${id}`,
  }
}

/** One card payload (the generated PROV-PC-4 shape). */
function payload(id: string): PretrainedModel {
  return {
    id,
    version: '1.0.0',
    kind: 'published-rule',
    name: `${id} rule`,
    description: 'A rule from the paper',
    method_id: `m-${id}`,
    method_version: '1.0.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    contract: 'contract-2.0',
    research_notice: true,
    licence: 'MIT',
    embeds_training_data: false,
    asset: { bundled: false, file: 'id.txr', sha256: 'ab', size_bytes: 1024, signature: '', url: '' },
    env: { base_digest: 'b', layer_digest: 'l' },
    needs: {
      endpoint: 'pfs',
      decision_day: 60,
      horizon: 240,
      covariates: 'none',
      marker_facts: { count: 1, kind: 'any', marker_groups_required: [], min_draws: 1, needs_baseline: false, needs_detection_call: false, uses_history: 'landmark' },
    },
    data_sources: [],
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3, cohorts: [] },
  }
}

/** A transport-style 404 (the framework attaches `status`). */
function notFound(): Error {
  return Object.assign(new Error('PRETRAINED_UNKNOWN'), { status: 404 })
}

const state = () => useTxrModelsStore.getState()

describe('usePretrained (TEST-MOD-26)', () => {
  beforeEach(() => {
    state().reset()
    for (const fn of Object.values(api)) fn.mockReset()
    intake.validation = null
  })

  afterEach(() => {
    cleanup()
  })

  it('fetches the catalogue once on mount and surfaces the rows through the store slice', async () => {
    api.listModels.mockResolvedValueOnce({
      models: [card('ps-1'), card('ps-2')],
      total: 2,
      origin: 'embedded',
    })
    const { result } = renderHook(() => usePretrained())
    expect(api.listModels).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.cards.map(c => c.id)).toEqual(['ps-1', 'ps-2'])
    expect(result.current.error).toBeNull()
  })

  it('a re-render does not refetch (stable key); a remount gets one fresh request (once per screen mount)', async () => {
    api.listModels.mockResolvedValue({ models: [card('ps-1')], total: 1, origin: 'embedded' })
    const first = renderHook(() => usePretrained())
    await act(async () => {
      await Promise.resolve()
    })
    first.rerender()
    first.rerender()
    expect(api.listModels).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = renderHook(() => usePretrained())
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.listModels).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('a failure surfaces the error; refetch is the force-retry path', async () => {
    api.listModels
      .mockRejectedValueOnce(new Error('catalogue down'))
      .mockResolvedValueOnce({ models: [card('ps-1')], total: 1, origin: 'embedded' })
    const { result } = renderHook(() => usePretrained())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBe('catalogue down')
    expect(result.current.cards).toEqual([])

    await act(async () => {
      result.current.refetch()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.cards.map(c => c.id)).toEqual(['ps-1'])
    expect(api.listModels).toHaveBeenCalledTimes(2)
  })
})

describe('usePretrainedCard (TEST-MOD-26)', () => {
  beforeEach(() => {
    state().reset()
    for (const fn of Object.values(api)) fn.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('fetches the card per id on demand and renders the provider payload', async () => {
    api.getModel.mockResolvedValueOnce(payload('ps-1'))
    const { result } = renderHook(() => usePretrainedCard('ps-1'))
    expect(api.getModel).toHaveBeenCalledTimes(1)
    expect(api.getModel).toHaveBeenCalledWith({ id: 'ps-1' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.card?.id).toBe('ps-1')
    expect(result.current.error).toBeNull()
  })

  it('a 404 maps to the not-found state; any other failure is network; retry re-issues', async () => {
    api.getModel
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(payload('ps-2'))
    const { result } = renderHook(() => usePretrainedCard('ps-1'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBe('not-found')
    expect(result.current.card).toBeNull()

    await act(async () => {
      result.current.retry()
      await Promise.resolve()
    })
    expect(result.current.error).toBe('network')

    await act(async () => {
      result.current.retry()
      await Promise.resolve()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.card?.id).toBe('ps-2')
    expect(api.getModel).toHaveBeenCalledTimes(3)
  })

  it('a null id is the closed state: no call, no stale card', async () => {
    api.getModel.mockResolvedValueOnce(payload('ps-1'))
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => usePretrainedCard(id),
      { initialProps: { id: 'ps-1' as string | null } },
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.card?.id).toBe('ps-1')

    rerender({ id: null })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.card).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(api.getModel).toHaveBeenCalledTimes(1)
  })

  it('a changed id supersedes: the older response resolving later is discarded', async () => {
    let resolveOld!: (v: PretrainedModel) => void
    let resolveNew!: (v: PretrainedModel) => void
    api.getModel
      .mockReturnValueOnce(
        new Promise<PretrainedModel>(r => {
          resolveOld = r
        }),
      )
      .mockReturnValueOnce(
        new Promise<PretrainedModel>(r => {
          resolveNew = r
        }),
      )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => usePretrainedCard(id),
      { initialProps: { id: 'ps-1' } },
    )
    rerender({ id: 'ps-2' })
    await act(async () => {
      resolveNew(payload('ps-2'))
      await Promise.resolve()
    })
    expect(result.current.card?.id).toBe('ps-2')

    await act(async () => {
      resolveOld(payload('ps-1'))
      await Promise.resolve()
    })
    expect(result.current.card?.id).toBe('ps-2')
    expect(api.getModel).toHaveBeenCalledTimes(2)
  })
})
