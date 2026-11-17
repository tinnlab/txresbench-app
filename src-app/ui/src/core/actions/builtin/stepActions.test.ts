// The step-flow actions (`./stepActions.ts`): the registered metadata the palette
// and the AI read, the refusals, and the navigation + trail cut of `flow.back`.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('../navigateBridge', () => ({ navigateViaBridge: nav.navigate }))

import './stepActions'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import {
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_NO_STEP,
  useStepTrailStore,
  type TxrCurrentStep,
} from '@/modules/txrintake/lib/stepTrail'

function onStep(current: Partial<TxrCurrentStep> & Pick<TxrCurrentStep, 'step' | 'url'>): void {
  useStepTrailStore.setState({
    current: { fallback: '/', blockedReason: null, dialogOpen: false, ...current },
  })
}

beforeEach(() => {
  nav.navigate.mockReset()
  useStepTrailStore.setState({ trail: [], current: null })
})

describe('flow.back', () => {
  it('is registered: McpUse, mutating, global kind, the txr.step context, on both surfaces, no params', () => {
    const meta = getActionMeta('flow.back')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe('txr.step')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
    expect(meta?.title).toBe('Go back to the previous step')
  })

  it('refuses with no step view on screen, and navigates nowhere', async () => {
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_NO_STEP)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('refuses with the blocked reason while a run is starting', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/pretrained-models'] })
    onStep({ step: 'pretrained-models', url: '/pretrained-models', blockedReason: 'Starting the run…' })
    await expect(runAction('flow.back', {})).rejects.toThrow('Starting the run…')
    expect(nav.navigate).not.toHaveBeenCalled()
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/pretrained-models'])
  })

  it('refuses while a page dialog is open', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files', '/choose-methods'] })
    onStep({ step: 'choose-methods', url: '/choose-methods', dialogOpen: true })
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_DIALOG_OPEN)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('navigates to the previous step of the trail and cuts the current step', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files', '/choose-methods'] })
    onStep({ step: 'choose-methods', url: '/choose-methods', fallback: '/files' })
    await expect(runAction('flow.back', {})).resolves.toEqual({ path: '/files' })
    expect(nav.navigate).toHaveBeenCalledWith('/files')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study', '/files'])
  })

  it('keeps the search of the step it returns to (the "Use" handoff on N)', async () => {
    const withUse = '/predict-files?use=m1&name=Model%201'
    useStepTrailStore.setState({ trail: ['/models', withUse, '/saved-models'] })
    onStep({ step: 'saved-models', url: '/saved-models', fallback: '/predict-files' })
    await runAction('flow.back', {})
    expect(nav.navigate).toHaveBeenCalledWith(withUse)
  })

  it('with an empty trail (a reload), goes to the step fallback', async () => {
    onStep({ step: 'files', url: '/files', fallback: '/study' })
    await runAction('flow.back', {})
    expect(nav.navigate).toHaveBeenCalledWith('/study')
  })
})
