// @vitest-environment jsdom
/**
 * The filter-options vocabulary hook (`data/useFilterOptions.ts`,
 * step2-filters): the `useMarkers` / `fetchCache.ts` pattern — ONE static
 * response per catalogue, served to later mounts from the cache, one round
 * trip for concurrent mounts, rejections never cached (the next mount
 * retries), `refetch()` drops the key — and the vocabulary's reconcile call
 * into the real TxrIntake store (an unknown persisted answer id is dropped
 * to unanswered, the server's 422 guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { FilterOptions } from '@/api-client/types'
import { useFilterOptions } from './useFilterOptions'
import { __resetFetchCacheForTests } from './fetchCache'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import {
  __resetMethodListRevisionForTests,
  noteMethodListSequence,
} from '@/lib/txr-method-list/revision'

const api = vi.hoisted(() => ({ filterOptions: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      filterOptions: api.filterOptions,
    },
  },
}))

const FILTER_OPTIONS: FilterOptions = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [{ id: 'colorectal cancer', children: [] }, { id: 'breast cancer', children: [] }],
    },
  ],
  treatment_classes: [{ id: 'chemotherapy', label: 'Chemotherapy' }],
}

const state = () => useTxrIntakeStore.getState()

/** Flush the promise chain (a macrotask turn covers all pending microtasks). */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  api.filterOptions.mockReset()
  api.filterOptions.mockResolvedValue(FILTER_OPTIONS)
  __resetFetchCacheForTests()
  __resetMethodListRevisionForTests()
  window.localStorage.clear()
  state().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useFilterOptions (step2-filters)', () => {
  it('fetches the vocabulary once and exposes the categories, the treatment classes and their labels', async () => {
    const { result } = renderHook(() => useFilterOptions())
    expect(result.current.loading).toBe(true)
    expect(result.current.categories).toEqual([])
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    expect(result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
    expect(result.current.treatmentClasses).toEqual(FILTER_OPTIONS.treatment_classes)
    expect(result.current.treatmentClassLabel('chemotherapy')).toBe('Chemotherapy')
    expect(result.current.treatmentClassLabel('unknown')).toBeUndefined()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('serves the settled vocabulary to a later mount (no refetch storm on mount)', async () => {
    const first = renderHook(() => useFilterOptions())
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    first.unmount()
    const second = renderHook(() => useFilterOptions())
    expect(second.result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
    expect(second.result.current.loading).toBe(false)
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
  })

  it('joins an in-flight request for a concurrent second mount (one round trip)', async () => {
    let resolve!: (value: FilterOptions) => void
    api.filterOptions.mockImplementationOnce(
      () => new Promise<FilterOptions>(resolveFn => (resolve = resolveFn)),
    )
    const first = renderHook(() => useFilterOptions())
    const second = renderHook(() => useFilterOptions())
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(FILTER_OPTIONS)
      await Promise.resolve()
    })
    expect(first.result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
    expect(second.result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
  })

  it('surfaces a failed fetch and retries on the next mount (rejections are never cached)', async () => {
    api.filterOptions
      .mockRejectedValueOnce(new Error('catalogue down'))
      .mockResolvedValueOnce(FILTER_OPTIONS)
    const first = renderHook(() => useFilterOptions())
    await settle()
    expect(first.result.current.error).toBe('catalogue down')
    expect(first.result.current.loading).toBe(false)
    first.unmount()
    const second = renderHook(() => useFilterOptions())
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(2)
    expect(second.result.current.error).toBeNull()
    expect(second.result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
  })

  it('refetch() drops the key and re-issues even for a settled key', async () => {
    const { result } = renderHook(() => useFilterOptions())
    await settle()
    act(() => result.current.refetch())
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(2)
  })

  it('drops a persisted answer id the loaded vocabulary does not know (the server 422 guard)', async () => {
    state().patchStudy({
      disease: 'not-in-vocab',
      treatments: ['chemotherapy', 'also-not-in-vocab'],
    })
    renderHook(() => useFilterOptions())
    await settle()
    const s = state().study
    expect(s.disease).toBeNull()
    expect(s.treatments).toEqual(['chemotherapy'])
  })

  it('reconciles on the CACHED path too — a later mount of the same catalogue drops a stale persisted id (5a3)', async () => {
    // First mount settles the cache; the persisted answers are written AFTER,
    // and the second mount takes the cache branch (no wire call) — the
    // vocabulary it hands out must stay the answers' validity gate.
    const first = renderHook(() => useFilterOptions())
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    first.unmount()
    state().patchStudy({ disease: 'not-in-vocab', treatments: ['chemotherapy'] })
    const second = renderHook(() => useFilterOptions())
    expect(second.result.current.vocabulary).not.toBeNull()
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    expect(state().study.disease).toBeNull()
    expect(state().study.treatments).toEqual(['chemotherapy'])
  })

  it('exposes the loaded vocabulary object (null until it loads, null after a failed fetch)', async () => {
    const { result } = renderHook(() => useFilterOptions())
    expect(result.current.vocabulary).toBeNull()
    await settle()
    expect(result.current.vocabulary).toEqual(FILTER_OPTIONS)
    cleanup()
    __resetFetchCacheForTests()
    api.filterOptions.mockRejectedValueOnce(new Error('catalogue down'))
    const failed = renderHook(() => useFilterOptions())
    await settle()
    expect(failed.result.current.vocabulary).toBeNull()
    expect(failed.result.current.error).toBe('catalogue down')
  })
})

describe('a new method list (the catalogue cache rule)', () => {
  it('drops the cached vocabulary and the mounted hook fetches again', async () => {
    const first = renderHook(() => useFilterOptions())
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    // The first sequence a response names only sets the level (no refetch);
    // a NEWER list drops the cached vocabulary and the hook refetches.
    act(() => noteMethodListSequence(1))
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    act(() => noteMethodListSequence(2))
    await settle()
    expect(api.filterOptions).toHaveBeenCalledTimes(2)
    expect(first.result.current.categories).toEqual(FILTER_OPTIONS.disease_categories)
  })
})
