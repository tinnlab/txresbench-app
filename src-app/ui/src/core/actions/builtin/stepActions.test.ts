// The step-flow actions (`./stepActions.ts`): the registered metadata the palette
// and the AI read, the refusals, and what each does — `flow.back` (navigation +
// trail cut), `models.switchList` (the D/I switch that replaces the step) and
// `flow.startPath` (the Start cards).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('../navigateBridge', () => ({ navigateViaBridge: nav.navigate }))

import './stepActions'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import type { ValidationResponse } from '@/api-client/types'
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

describe('models.switchList', () => {
  const checked = { problems: [], markers: [] } as unknown as ValidationResponse

  beforeEach(() => {
    useTxrIntakeStore.getState().reset()
    useTxrIntakeStore.setState({ intent: 'pretrained', mode: 'predict', validation: checked })
  })

  it('is registered: McpUse, mutating, the txr.step context, a list param', () => {
    const meta = getActionMeta('models.switchList')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.context).toBe('txr.step')
  })

  it('from the empty published list: the saved list takes the step\u2019s place, intent reuse, the checked file kept', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/pretrained-models'] })
    onStep({ step: 'pretrained-models', url: '/pretrained-models', fallback: '/predict-files' })
    await expect(runAction('models.switchList', { list: 'saved' })).resolves.toEqual({
      path: '/saved-models',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/saved-models')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/saved-models'])
    expect(useTxrIntakeStore.getState().intent).toBe('reuse')
    expect(useTxrIntakeStore.getState().mode).toBe('predict')
    expect(useTxrIntakeStore.getState().validation).toBe(checked)
  })

  it('and back the other way: the published list, intent pretrained', async () => {
    useTxrIntakeStore.setState({ intent: 'reuse' })
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/saved-models'] })
    onStep({ step: 'saved-models', url: '/saved-models', fallback: '/predict-files' })
    await runAction('models.switchList', { list: 'published' })
    expect(nav.navigate).toHaveBeenCalledWith('/pretrained-models')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/pretrained-models'])
    expect(useTxrIntakeStore.getState().intent).toBe('pretrained')
  })

  it('already on that list: nothing moves', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/saved-models'] })
    onStep({ step: 'saved-models', url: '/saved-models', fallback: '/predict-files' })
    await runAction('models.switchList', { list: 'saved' })
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('refuses off the model step, while a run is starting, and while a dialog is open', async () => {
    await expect(runAction('models.switchList', { list: 'saved' })).rejects.toThrow(
      'Open the model step of a new analysis first.',
    )
    onStep({ step: 'files', url: '/files', fallback: '/study' })
    await expect(runAction('models.switchList', { list: 'saved' })).rejects.toThrow(
      'Open the model step of a new analysis first.',
    )
    onStep({ step: 'pretrained-models', url: '/pretrained-models', blockedReason: 'Starting the run…' })
    await expect(runAction('models.switchList', { list: 'saved' })).rejects.toThrow(
      'Starting the run…',
    )
    onStep({ step: 'pretrained-models', url: '/pretrained-models', dialogOpen: true })
    await expect(runAction('models.switchList', { list: 'saved' })).rejects.toThrow(
      STEP_BACK_DIALOG_OPEN,
    )
    expect(nav.navigate).not.toHaveBeenCalled()
    expect(useTxrIntakeStore.getState().intent).toBe('pretrained')
  })

  it('rejects a list it does not know', async () => {
    onStep({ step: 'pretrained-models', url: '/pretrained-models' })
    await expect(runAction('models.switchList', { list: 'other' })).rejects.toThrow(/invalid params/)
  })
})

describe('flow.startPath', () => {
  beforeEach(() => {
    useTxrIntakeStore.getState().reset()
  })

  it('is registered: McpUse, mutating, global (the Start cards work from anywhere)', () => {
    const meta = getActionMeta('flow.startPath')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.context).toBe('global')
  })

  it('each intent opens its first step, starts the trail at Start and keeps the files', async () => {
    const predict = { source: { name: 'p.csv' } } as never
    useTxrIntakeStore.setState({ predictMeasurements: predict })
    useStepTrailStore.setState({ trail: ['/history', '/choose-methods'] })

    await runAction('flow.startPath', { intent: 'train' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/study')
    expect(useTxrIntakeStore.getState()).toMatchObject({ intent: 'train', mode: 'study' })
    expect(useStepTrailStore.getState().trail).toEqual(['/'])

    await runAction('flow.startPath', { intent: 'pretrained' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({ intent: 'pretrained', mode: 'predict' })

    await runAction('flow.startPath', { intent: 'reuse' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({ intent: 'reuse', mode: 'predict' })
    expect(useTxrIntakeStore.getState().predictMeasurements).toBe(predict)
  })
})
