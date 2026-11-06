// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useKeepCopies } from './useKeepCopies'

const api = vi.hoisted(() => ({
  getPrefs: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    History: {
      getPreferences: api.getPrefs,
    },
  },
}))

beforeEach(() => {
  api.getPrefs.mockReset()
  api.getPrefs.mockResolvedValue({ keep_file_copies: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useKeepCopies', () => {
  it('reads the preference once at mount and surfaces its value', async () => {
    api.getPrefs.mockResolvedValue({ keep_file_copies: false })
    const { result } = renderHook(() => useKeepCopies())
    expect(api.getPrefs).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(result.current.keepCopies).toBe(false)
    })
  })

  it('a failed read falls back to the builder default true', async () => {
    api.getPrefs.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useKeepCopies())
    await waitFor(() => {
      expect(result.current).toBeDefined()
    })
    expect(result.current.keepCopies).toBe(true)
  })
})
