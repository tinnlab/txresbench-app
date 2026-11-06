// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { MethodSummary } from '@/api-client/types'
import { useMethodList } from './useMethodList'

const api = vi.hoisted(() => ({
  list: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
    },
  },
}))

/** One synthetic catalogue entry (INV-6). */
function entry(id: string, group: MethodSummary['group']): MethodSummary {
  return {
    id,
    year: 2021,
    language: 'R',
    group,
    group_label: group,
    journal: 'Example Journal',
    runnable: true,
    spec_status: 'final',
    container: true,
    covariates: 'optional',
    embeds_training_data: false,
    frozen_model: false,
    marker_groups_required: [],
    markers: { count: 1, kind: 'any' },
    min_draws: 1,
    needs_baseline: false,
    needs_detection_call: false,
    paper_doi: '10.0000/example',
    tasks: ['pfs'],
    timing: { base_seconds_per_fold: 120, benchmarked_units: 3, quality: 'measured' },
    uses_history: 'landmark',
  }
}

beforeEach(() => {
  api.list.mockReset()
  api.list.mockResolvedValue({ methods: [entry('direct-on', 'response-probability')], total: 1 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useMethodList', () => {
  it('GETs the catalogue list on mount and surfaces its methods', async () => {
    const { result } = renderHook(() => useMethodList())
    expect(api.list).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.methods.map(m => m.id)).toEqual(['direct-on'])
    expect(result.current.error).toBeNull()
  })

  it('a failure surfaces the error and refresh re-issues the request', async () => {
    api.list.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({
      methods: [entry('dynforest', 'dynamic-risk')],
      total: 1,
    })
    const { result } = renderHook(() => useMethodList())
    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
    })
    expect(result.current.methods).toEqual([])
    result.current.refetch()
    await waitFor(() => {
      expect(result.current.methods.map(m => m.id)).toEqual(['dynforest'])
    })
    expect(api.list).toHaveBeenCalledTimes(2)
  })
})
