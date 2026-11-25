// `models.openModelFile` (predict-card merge round 1): the registered,
// permissioned wrapper the Start card's "Open a model file" and the Models
// page's import affordance share — the human path (a mounted picker host
// answers, the `.txr` picker opens in place), the agent path (no host/gesture
// → navigate to the Models page + the result text), and the demo refusal.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('../navigateBridge', () => ({
  navigateViaBridge: nav.navigate,
  currentPathViaBridge: vi.fn(() => '/'),
}))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: { importModel: vi.fn() },
  },
}))

import './modelFileActions'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { seedDemoMode, resetDemoMode } from '@/modules/demo/test-utils/demoSeed'
import {
  registerModelFilePicker,
  requestModelFilePicker,
} from '@/modules/txrmodels/lib/modelFilePicker'

beforeEach(() => {
  nav.navigate.mockReset()
  resetDemoMode()
})

describe('models.openModelFile', () => {
  it('is registered: McpUse, mutating, global, both surfaces, no params', () => {
    const meta = getActionMeta('models.openModelFile')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe('global')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
    expect(meta?.title).toBe('Open a model file')
  })

  it('a mounted picker host answers: the picker opens in place, nothing navigates', async () => {
    const unregister = registerModelFilePicker(() => true)
    try {
      await expect(runAction('models.openModelFile', {})).resolves.toEqual({ status: 'picker' })
      expect(nav.navigate).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('no host (the agent path): navigates to the Models page and returns the choose-there text', async () => {
    // No handler registered — the action must not report a picker nobody opened.
    expect(requestModelFilePicker()).toBe(false)
    await expect(runAction('models.openModelFile', {})).resolves.toEqual({
      status: 'navigated',
      text: 'Choose the model file on the Models page.',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/models')
  })

  it('refused in demo mode (import is blocked there) with the demo refusal line', async () => {
    seedDemoMode('demo')
    await expect(runAction('models.openModelFile', {})).rejects.toThrow('Not available in the demo')
    expect(nav.navigate).not.toHaveBeenCalled()
  })
})
