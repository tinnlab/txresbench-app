// @vitest-environment jsdom
/**
 * TEST-RUN-08 — txrrun `useMethodDetail` (PROV-UI-RUN-4's About source,
 * CONS-UI-RUN-5; ITEM-4). The hook fetches the one-method catalogue payload
 * (`ApiClient.MethodCatalogue.detail` — the generated id; the payload type
 * is the generated `Method`) for the About dialog.
 *
 * Pinned behaviors:
 *
 * - the fetch goes out with the hook's id, once per id, and the detail
 *   passes through;
 * - a changed id resets the previous detail and re-fetches (a stale detail
 *   never renders under a new id; an older response resolving after the
 *   change is discarded);
 * - a `404` maps to the `'not-found'` state (the catalogue's
 *   `METHOD_NOT_FOUND` — the dialog renders `METHOD_NOT_FOUND_LINE`, never a
 *   blank card); any other failure is `'network'`; the promise is always
 *   caught — a rejection cannot escape as an unhandled rejection;
 * - `retry()` re-issues the fetch and clears the error on success;
 * - `null` id is the closed-dialog state: no request, no detail.
 *
 * The ApiClient is mocked (the `useListEstimate` precedent); the fixture is
 * the generated `Method` wire type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Method, Timing } from '@/api-client/types'
import {
  METHOD_NOT_FOUND_LINE,
  useMethodDetail,
  type TxrMethodDetailError,
} from './useMethodDetail'

const api = vi.hoisted(() => ({
  detail: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      detail: api.detail,
    },
  },
}))

const TIMING: Timing = { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' }

/** A one-method catalogue detail fixture (the wire shape the dialog renders). */
function methodDetail(over: Partial<Method> = {}): Method {
  return {
    description: 'A published longitudinal response method.',
    citations: 3,
    container: true,
    covariates: 'optional',
    embeds_training_data: false,
    env: {
      contract: '2.0',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      image: 'ghcr.io/tinnlab/txresbench-direct-on:1.0',
    },
    fitted: true,
    frozen_model: false,
    gate: { pass: true, report_name: 'methods-gate' },
    group: 'response-probability',
    group_label: 'Response probability',
    id: 'direct-on',
    journal: 'J. Methods',
    language: 'R',
    licence: 'MIT',
    marker_groups_required: [],
    markers: { kind: 'panel', count: 3 },
    min_draws: 3,
    needs_baseline: true,
    needs_detection_call: false,
    own_outputs: [],
    paper_doi: '10.1000/example',
    params: {},
    references: ['10.1000/ref1'],
    runnable: true,
    saves_model: false,
    software: { language: 'R', packages: {} },
    spec_status: 'published',
    tasks: ['response-probability'],
    timing: TIMING,
    uses_history: 'landmark',
    version: '1.0.0',
    year: 2021,
    performance: { c_index_median: 0.64, n_datasets: 10, n_units: 151 },
    ...over,
  }
}

const METHOD_404 = Object.assign(new Error('HTTP error! status: 404'), { status: 404 })

const settled = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  api.detail.mockReset()
  api.detail.mockResolvedValue(methodDetail())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useMethodDetail (TEST-RUN-08)', () => {
  it('GETs the method detail once for the id and passes the payload through', async () => {
    const { result } = renderHook(() => useMethodDetail('direct-on'))
    expect(api.detail).toHaveBeenCalledTimes(1)
    expect(api.detail).toHaveBeenCalledWith({ method_id: 'direct-on' })
    expect(result.current.loading).toBe(true)
    expect(result.current.detail).toBeNull()

    await settled()
    expect(api.detail).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.detail).toEqual(methodDetail())
  })

  it('a changed id resets the previous detail and re-fetches for the new id', async () => {
    const { result, rerender } = renderHook(({ id }) => useMethodDetail(id), {
      initialProps: { id: 'direct-on' },
    })
    await settled()
    expect(result.current.detail?.id).toBe('direct-on')

    rerender({ id: 'dynforest' })
    expect(result.current.detail).toBeNull()
    expect(result.current.loading).toBe(true)
    expect(api.detail).toHaveBeenCalledTimes(2)
    expect(api.detail).toHaveBeenLastCalledWith({ method_id: 'dynforest' })

    await settled()
    expect(result.current.detail).toEqual(methodDetail())
    expect(result.current.error).toBeNull()
  })

  it('discards an older response resolving after an id change (the stale guard)', async () => {
    const slower = new Promise<Method>(resolve => {
      setTimeout(() => resolve(methodDetail({ id: 'direct-on' })), 100)
    })
    api.detail.mockReturnValueOnce(slower)
    api.detail.mockResolvedValueOnce(methodDetail({ id: 'dynforest' }))
    const { result, rerender } = renderHook(({ id }) => useMethodDetail(id), {
      initialProps: { id: 'direct-on' },
    })
    rerender({ id: 'dynforest' })
    await settled()
    expect(api.detail).toHaveBeenCalledTimes(2)
    expect(result.current.detail?.id).toBe('dynforest')
    // The slow first response lands now — it must not resurrect the old id.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150))
    })
    expect(result.current.detail?.id).toBe('dynforest')
    expect(result.current.error).toBeNull()
  })

  it('maps a 404 METHOD_NOT_FOUND to the not-found state (never an uncaught rejection)', async () => {
    api.detail.mockRejectedValueOnce(METHOD_404)
    const { result } = renderHook(() => useMethodDetail('gone'))
    await settled()
    expect(result.current.error).toBe('not-found' as TxrMethodDetailError)
    expect(result.current.detail).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('maps any other failure to the network state', async () => {
    api.detail.mockRejectedValueOnce(new Error('down'))
    const { result } = renderHook(() => useMethodDetail('direct-on'))
    await settled()
    expect(result.current.error).toBe('network' as TxrMethodDetailError)
    expect(result.current.detail).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('retry re-issues the fetch for the same id and clears the failure', async () => {
    api.detail.mockRejectedValueOnce(new Error('down'))
    const retried = new Promise<Method>(resolve => {
      setTimeout(() => resolve(methodDetail()), 50)
    })
    api.detail.mockReturnValueOnce(retried)
    const { result } = renderHook(() => useMethodDetail('direct-on'))
    await settled()
    expect(result.current.error).toBe('network')
    expect(api.detail).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.retry()
    })
    expect(api.detail).toHaveBeenCalledTimes(2)
    expect(api.detail).toHaveBeenLastCalledWith({ method_id: 'direct-on' })
    expect(result.current.loading).toBe(true)

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.detail).toEqual(methodDetail())
  })

  it('null id is the closed-dialog state: no request, no detail, not loading', async () => {
    const { result } = renderHook(() => useMethodDetail(null))
    await settled()
    expect(api.detail).not.toHaveBeenCalled()
    expect(result.current.detail).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('exports the About fallback line for the 404 rendering (never blank)', () => {
    expect(METHOD_NOT_FOUND_LINE.length).toBeGreaterThan(0)
  })
})
