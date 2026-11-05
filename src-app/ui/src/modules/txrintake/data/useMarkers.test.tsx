// @vitest-environment jsdom
/**
 * TEST-INT-5 [covers ITEM-10] — the two static catalogue fetch hooks
 * (`data/useMarkers.ts`, `data/useRunnableMethodCount.ts`): the
 * CONS-UI-INTAKE-1/3 fetches with the module-level stable-key cache
 * (`data/fetchCache.ts`, ITEM-10).
 *
 * The generated operation ids are `ApiClient.MethodCatalogue.markers` /
 * `ApiClient.MethodCatalogue.list` — the plan's `Markers.list` /
 * `Methods.list` spellings are a recorded reconcile fact (DRIFT-1 ITEM-2
 * #4), so the pins use the real ids.
 *
 * Pinned behaviors:
 *
 * - a mount fetches the vocabulary ONCE and exposes `groups` (the 7 board
 *   group ids + display names) + `markers`, with `loading` → `false` and
 *   `error` `null` on success;
 * - re-renders never re-issue; a LATER mount serves the settled cache
 *   (stable key → one request per session; no refetch storm on mount);
 * - a concurrent second mount JOINS the in-flight request (one round
 *   trip for two mounts);
 * - a failed fetch surfaces `error` with empty groups and is NOT cached —
 *   the next mount genuinely retries and recovers;
 * - `refetch()` drops the key and re-issues (a deliberate retry always
 *   hits the wire, the `useStudyPreview` rule);
 * - `useRunnableMethodCount` fetches `list({runnable: true})` once, reads
 *   `total`, serves the settled count to a later mount, and degrades to
 *   `count: null` on failure (the page's number-free line is TEST-INT-11's
 *   pin — the hook's contract is the null).
 *
 * The cache is module-level by design, so the suite resets its key space
 * per test through the `__resetFetchCacheForTests` seam (the framework's
 * `__resetInflightForTests` precedent); the ApiClient is mocked per the
 * `Datasets.store` precedent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type {
  MarkerGroup,
  MarkerVocabularyResponse,
  MethodListResponse,
  VocabularyMarker,
} from '@/api-client/types'
import { useMarkers } from './useMarkers'
import { useRunnableMethodCount } from './useRunnableMethodCount'
import { __resetFetchCacheForTests } from './fetchCache'

const api = vi.hoisted(() => ({ markers: vi.fn(), list: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      markers: api.markers,
      list: api.list,
    },
  },
}))

/** The 7 board group ids (CONS-UI-INTAKE-1) with their board labels. */
const GROUP_IDS = [
  'ctdna',
  'counts',
  'ldh',
  'tumour-markers',
  'inflammation',
  'methylation-sequencing',
  'other',
] as const

const GROUPS: MarkerGroup[] = [
  { id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' },
  { id: 'counts', display_name: 'Blood counts (platelets, haemoglobin)' },
  { id: 'ldh', display_name: 'LDH' },
  { id: 'tumour-markers', display_name: 'Tumour markers (CEA, CA 19-9)' },
  { id: 'inflammation', display_name: 'Inflammation or cytokines (CRP, IL-6)' },
  { id: 'methylation-sequencing', display_name: 'Methylation or other sequencing' },
  { id: 'other', display_name: 'Other markers' },
]

const MARKERS: VocabularyMarker[] = [
  {
    id: 'ldh',
    system: 'LOINC',
    display_name: 'Lactate dehydrogenase',
    aliases: ['LDH'],
    groups: ['ldh'],
    unit_family: 'concentration_mass',
    canonical_unit: 'U/L',
    n_methods: 3,
  },
  {
    id: 'cea',
    system: 'LOINC',
    display_name: 'CEA',
    aliases: [],
    groups: ['tumour-markers'],
    unit_family: 'concentration_mass',
    canonical_unit: 'ug/L',
    n_methods: 2,
  },
]

function vocabulary(): MarkerVocabularyResponse {
  return { groups: GROUPS, markers: MARKERS }
}

function methodList(total = 64): MethodListResponse {
  return { methods: [], total }
}

/** Flush the promise chain (a macrotask turn covers all pending microtasks). */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  api.markers.mockReset()
  api.list.mockReset()
  api.markers.mockResolvedValue(vocabulary())
  api.list.mockResolvedValue(methodList())
  __resetFetchCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMarkers (TEST-INT-5, ITEM-10)', () => {
  it('fetches the vocabulary once and exposes the 7 group ids + display names + markers', async () => {
    const { result } = renderHook(() => useMarkers())
    expect(result.current.loading).toBe(true)
    expect(result.current.groups).toEqual([])
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
    expect(result.current.groups.map(g => g.id)).toEqual([...GROUP_IDS])
    expect(result.current.groups).toEqual(GROUPS)
    expect(result.current.markers).toEqual(MARKERS)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('never re-issues for re-renders and serves the settled cache to a later mount', async () => {
    const first = renderHook(() => useMarkers())
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
    first.rerender()
    first.rerender()
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
    first.unmount()
    const second = renderHook(() => useMarkers())
    // The stable key hit: the first frame already carries the vocabulary.
    expect(second.result.current.groups).toEqual(GROUPS)
    expect(second.result.current.loading).toBe(false)
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
  })

  it('joins an in-flight request for a concurrent second mount (one round trip)', async () => {
    let resolveMarkers!: (value: MarkerVocabularyResponse) => void
    api.markers
      .mockImplementationOnce(
        () => new Promise<MarkerVocabularyResponse>(resolve => (resolveMarkers = resolve)),
      )
      .mockResolvedValueOnce(vocabulary())
    const first = renderHook(() => useMarkers())
    const second = renderHook(() => useMarkers())
    expect(api.markers).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveMarkers(vocabulary())
      await Promise.resolve()
    })
    expect(first.result.current.groups).toEqual(GROUPS)
    expect(second.result.current.groups).toEqual(GROUPS)
  })

  it('surfaces a failed fetch and retries on the next mount (rejections are never cached)', async () => {
    api.markers
      .mockRejectedValueOnce(new Error('catalogue down'))
      .mockResolvedValueOnce(vocabulary())
    const first = renderHook(() => useMarkers())
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
    expect(first.result.current.error).toBe('catalogue down')
    expect(first.result.current.loading).toBe(false)
    expect(first.result.current.groups).toEqual([])
    first.unmount()
    const second = renderHook(() => useMarkers())
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(2)
    expect(second.result.current.error).toBeNull()
    expect(second.result.current.groups).toEqual(GROUPS)
  })

  it('refetch() drops the key and re-issues even for a settled key', async () => {
    const { result } = renderHook(() => useMarkers())
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.refetch()
    })
    await settle()
    expect(api.markers).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.groups).toEqual(GROUPS)
  })
})

describe('useRunnableMethodCount (TEST-INT-5, ITEM-10)', () => {
  it('fetches the runnable list once, reads total, and serves the settled count to a later mount', async () => {
    const first = renderHook(() => useRunnableMethodCount())
    expect(first.result.current.count).toBeNull()
    await settle()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledWith({ runnable: true })
    expect(first.result.current.count).toBe(64)
    first.unmount()
    const second = renderHook(() => useRunnableMethodCount())
    expect(second.result.current.count).toBe(64)
    await settle()
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('degrades to count: null on failure and recovers on the next mount', async () => {
    api.list
      .mockRejectedValueOnce(new Error('catalogue down'))
      .mockResolvedValueOnce(methodList(64))
    const first = renderHook(() => useRunnableMethodCount())
    await settle()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(first.result.current.count).toBeNull()
    first.unmount()
    const second = renderHook(() => useRunnableMethodCount())
    await settle()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(second.result.current.count).toBe(64)
  })
})
