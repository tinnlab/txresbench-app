// TEST-9 [ITEM-14] — the ProcessorsAdmin store maps the discovered-set list
// response + the reload action. vitest (node env); the only external boundaries
// mocked are `ApiClient.Processor.list/reload` and the permission gate.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackageLoadStatus, ProcessorReloadResponse } from '@/api-client/types'

// The store self-gates every fetch on the read perm; make it pass in the unit.
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

const list = vi.fn<() => Promise<PackageLoadStatus[]>>()
const reload = vi.fn<() => Promise<ProcessorReloadResponse>>()
vi.mock('@/api-client', () => ({
  ApiClient: { Processor: { list: () => list(), reload: () => reload() } },
}))

// Imported AFTER the mocks so the store closes over the mocked ApiClient.
const { useProcessorsAdminStore } = await import('./ProcessorsAdmin.store')
const state = () => useProcessorsAdminStore.getState()

const LOADED: PackageLoadStatus[] = [
  { id: 'qc', ok: true, version: '0.1.0' },
  { id: 'broken-pkg', ok: false, version: '0.1.0', error: 'broken-pkg: unknown key `bogus`' },
]

beforeEach(() => {
  list.mockReset()
  reload.mockReset()
  useProcessorsAdminStore.setState({
    packages: [],
    registered: null,
    loading: false,
    reloading: false,
    error: null,
  })
})

describe('ProcessorsAdmin store', () => {
  it('loadProcessors maps GET /api/processors into the discovered set + clears loading', async () => {
    list.mockResolvedValue(LOADED)
    await state().loadProcessors()

    expect(list).toHaveBeenCalledOnce()
    expect(state().packages).toEqual(LOADED)
    expect(state().packages.find(p => p.id === 'broken-pkg')?.error).toContain('unknown key')
    expect(state().loading).toBe(false)
    expect(state().error).toBeNull()
  })

  it('loadProcessors records the error + clears loading on failure', async () => {
    list.mockRejectedValue(new Error('boom'))
    await state().loadProcessors()

    expect(state().error).toBe('boom')
    expect(state().loading).toBe(false)
    expect(state().packages).toEqual([])
  })

  it('reload calls POST /api/processors/reload, refreshes packages + registered, returns true', async () => {
    const RES: ProcessorReloadResponse = { packages: LOADED, registered: 5 }
    reload.mockResolvedValue(RES)

    const ok = await state().reload()

    expect(ok).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    expect(state().packages).toEqual(LOADED)
    expect(state().registered).toBe(5)
    expect(state().reloading).toBe(false)
  })

  it('reload sets the error + returns false on failure', async () => {
    reload.mockRejectedValue(new Error('reload failed'))

    const ok = await state().reload()

    expect(ok).toBe(false)
    expect(state().error).toBe('reload failed')
    expect(state().reloading).toBe(false)
  })
})
