// The step-flow actions (`./stepActions.ts`): the registered metadata the palette
// and the AI read, the refusals, and what each does — `flow.back` (navigation +
// trail cut), `models.switchList` (the D/I switch that replaces the step) and
// `flow.startPath` (the Start cards) and `help.backToStep` (Help opened from a step).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigate: vi.fn(), current: vi.fn(() => '/') }))
vi.mock('../navigateBridge', () => ({
  navigateViaBridge: nav.navigate,
  currentPathViaBridge: nav.current,
}))

// `flow.useExample`'s example-path fetches (the action drives the same
// lib/example flow the Start cards did).
const api = vi.hoisted(() => ({ example: vi.fn(), exampleSet: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: { example: api.example },
    Models: { exampleSet: api.exampleSet },
  },
}))

import './stepActions'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { registerActiveContext, unregisterActiveContext } from '../activeContext'
import { useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
// At module scope (the action itself loads this store on use): the
// beforeEach needs `reset()` without a per-hook dynamic-import cost — a
// cold transform of the store's graph once crossed the hook timeout.
import { useTxrModelsStore } from '@/modules/txrmodels/stores/TxrModels.store'
import type { ValidationResponse } from '@/api-client/types'
import {
  HELP_BACK_NO_STEP,
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_LEAVING,
  STEP_BACK_NO_STEP,
  TXR_HELP_FROM_STEP_CONTEXT,
  TXR_MODEL_STEP_CONTEXT,
  useStepTrailStore,
  type TxrCurrentStep,
} from '@/modules/txrintake/lib/stepTrail'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'

function onStep(current: Partial<TxrCurrentStep> & Pick<TxrCurrentStep, 'step' | 'url'>): void {
  useStepTrailStore.setState({
    current: { fallback: '/', blockedReason: null, dialogOpen: false, ...current },
  })
}

beforeEach(() => {
  nav.navigate.mockReset()
  nav.current.mockReset()
  nav.current.mockReturnValue('/')
  api.example.mockReset()
  api.exampleSet.mockReset()
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
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

  it('a second Back before the router commits the first does nothing (no fallback hop)', async () => {
    useStepTrailStore.setState({ trail: ['/history', '/choose-methods'] })
    onStep({ step: 'choose-methods', url: '/choose-methods', fallback: '/files' })
    await runAction('flow.back', {})
    // The router has not committed yet: E is still the current step.
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_LEAVING)
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith('/history')
  })

  it('with an empty trail (a reload), goes to the step fallback', async () => {
    onStep({ step: 'files', url: '/files', fallback: '/study' })
    await runAction('flow.back', {})
    expect(nav.navigate).toHaveBeenCalledWith('/study')
  })
})

describe('help.backToStep', () => {
  beforeEach(() => {
    unregisterActiveContext(TXR_HELP_FROM_STEP_CONTEXT)
  })

  it('is registered: McpUse, mutating, global kind, the txr.helpFromStep context, on both surfaces, no params', () => {
    const meta = getActionMeta('help.backToStep')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe(TXR_HELP_FROM_STEP_CONTEXT)
    expect(TXR_HELP_FROM_STEP_CONTEXT).toBe('txr.helpFromStep')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('goes back to the step Help was opened from and keeps the trail', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files'] })
    registerActiveContext(TXR_HELP_FROM_STEP_CONTEXT, { entityId: '/files' })
    await expect(runAction('help.backToStep', {})).resolves.toEqual({ path: '/files' })
    expect(nav.navigate).toHaveBeenCalledWith('/files')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study', '/files'])
  })

  it('refuses when Help was not opened from a step', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files'] })
    await expect(runAction('help.backToStep', {})).rejects.toThrow(HELP_BACK_NO_STEP)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('refuses a stale step (a new path started since) and a URL that is not a step', async () => {
    useStepTrailStore.setState({ trail: ['/help'] })
    registerActiveContext(TXR_HELP_FROM_STEP_CONTEXT, { entityId: '/files' })
    await expect(runAction('help.backToStep', {})).rejects.toThrow(HELP_BACK_NO_STEP)
    useStepTrailStore.setState({ trail: ['/', '/models'] })
    registerActiveContext(TXR_HELP_FROM_STEP_CONTEXT, { entityId: '/models' })
    await expect(runAction('help.backToStep', {})).rejects.toThrow(HELP_BACK_NO_STEP)
    expect(nav.navigate).not.toHaveBeenCalled()
  })
})

describe('models.switchList', () => {
  const checked = { problems: [], markers: [] } as unknown as ValidationResponse

  beforeEach(() => {
    useTxrIntakeStore.getState().reset()
    useTxrIntakeStore.setState({
      intent: 'predict',
      predictSource: 'lab',
      mode: 'predict',
      validation: checked,
    })
  })

  it('is registered: McpUse, mutating, the model-step context (offered on D, I and the merged list), a list param', () => {
    const meta = getActionMeta('models.switchList')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.context).toBe(TXR_MODEL_STEP_CONTEXT)
    expect(TXR_MODEL_STEP_CONTEXT).toBe('txr.modelStep')
  })

  it('from the empty published list: the merged list takes the step\u2019s place, Saved + Imported on, the checked file kept', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/pretrained-models'] })
    onStep({ step: 'pretrained-models', url: '/pretrained-models', fallback: '/predict-files' })
    await expect(runAction('models.switchList', { list: 'saved' })).resolves.toEqual({
      path: '/choose-models',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/choose-models')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/choose-models'])
    expect(useTxrIntakeStore.getState().intent).toBe('predict')
    expect(useTxrIntakeStore.getState().predictSource).toBe('saved')
    expect(useTxrIntakeStore.getState().mode).toBe('predict')
    expect(useTxrIntakeStore.getState().validation).toBe(checked)
    // The alias mapping: the Saved + Imported chips of the ONE list.
    expect(useTxrModelsStore.getState().filters).toEqual(['source-saved', 'source-imported'])
  })

  it('and back the other way: From the lab on, the lab source', async () => {
    useTxrIntakeStore.setState({ intent: 'predict', predictSource: 'saved' })
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/saved-models'] })
    onStep({ step: 'saved-models', url: '/saved-models', fallback: '/predict-files' })
    await runAction('models.switchList', { list: 'published' })
    expect(nav.navigate).toHaveBeenCalledWith('/choose-models')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/choose-models'])
    expect(useTxrIntakeStore.getState().intent).toBe('predict')
    expect(useTxrIntakeStore.getState().predictSource).toBe('lab')
    expect(useTxrModelsStore.getState().filters).toEqual(['source-lab'])
  })

  it('a second switch before the router commits the first does nothing (the trail holds the list once)', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/pretrained-models'] })
    onStep({ step: 'pretrained-models', url: '/pretrained-models', fallback: '/predict-files' })
    await runAction('models.switchList', { list: 'saved' })
    await expect(runAction('models.switchList', { list: 'saved' })).rejects.toThrow(STEP_BACK_LEAVING)
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/choose-models'])
  })

  it('already on the merged list: only the chips are set (the step is not exchanged)', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/choose-models'] })
    onStep({ step: 'choose-models', url: '/choose-models', fallback: '/predict-files' })
    await runAction('models.switchList', { list: 'saved' })
    expect(nav.navigate).toHaveBeenCalledWith('/choose-models')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/choose-models'])
    expect(useTxrModelsStore.getState().filters).toEqual(['source-saved', 'source-imported'])
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
    expect(useTxrIntakeStore.getState().intent).toBe('predict')
    expect(useTxrIntakeStore.getState().predictSource).toBe('lab')
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

  it('starts the trail on the page it is started from (Help, Your models, a results page)', async () => {
    nav.current.mockReturnValue('/help')
    await runAction('flow.startPath', { intent: 'pretrained' })
    expect(useStepTrailStore.getState().trail).toEqual(['/help'])
    nav.current.mockReturnValue('/analysis/run-1/results')
    await runAction('flow.startPath', { intent: 'reuse' })
    expect(useStepTrailStore.getState().trail).toEqual(['/analysis/run-1/results'])
  })

  it('started from a step view (D "Learn from my data"), the new path starts at Start', async () => {
    nav.current.mockReturnValue('/pretrained-models')
    onStep({ step: 'pretrained-models', url: '/pretrained-models' })
    await runAction('flow.startPath', { intent: 'train' })
    expect(useStepTrailStore.getState().trail).toEqual(['/'])
    // The learn path starts with its files (the study questions come after).
    expect(nav.navigate).toHaveBeenLastCalledWith('/files')
  })

  it('startAtFiles still opens the path\u2019s file step (every path starts there now)', async () => {
    nav.current.mockReturnValue('/help')
    await runAction('flow.startPath', { intent: 'train', startAtFiles: true })
    expect(nav.navigate).toHaveBeenLastCalledWith('/files')
    expect(useStepTrailStore.getState().trail).toEqual(['/help'])
    await runAction('flow.startPath', { intent: 'reuse', startAtFiles: true })
    expect(nav.navigate).toHaveBeenLastCalledWith('/predict-files')
  })

  it('refuses while a run is starting or a page dialog is open on the step view', async () => {
    onStep({ step: 'saved-models', url: '/saved-models', blockedReason: 'Starting the run…' })
    await expect(runAction('flow.startPath', { intent: 'reuse' })).rejects.toThrow('Starting the run…')
    onStep({ step: 'pretrained-models', url: '/pretrained-models', dialogOpen: true })
    await expect(runAction('flow.startPath', { intent: 'reuse' })).rejects.toThrow(STEP_BACK_DIALOG_OPEN)
    expect(nav.navigate).not.toHaveBeenCalled()
    expect(useTxrIntakeStore.getState().intent).toBe('train') // the birth intent, untouched
    expect(useTxrIntakeStore.getState().mode).toBe('study')
  })

  it('each intent opens its first step, starts the trail at Start and keeps the files', async () => {
    const predict = { source: { name: 'p.csv' } } as never
    useTxrIntakeStore.setState({ predictMeasurements: predict })
    useStepTrailStore.setState({ trail: ['/history', '/choose-methods'] })

    await runAction('flow.startPath', { intent: 'train' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/files')
    expect(useTxrIntakeStore.getState()).toMatchObject({ intent: 'train', mode: 'study' })
    expect(useStepTrailStore.getState().trail).toEqual(['/'])

    await runAction('flow.startPath', { intent: 'pretrained' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: 'lab',
      mode: 'predict',
    })

    await runAction('flow.startPath', { intent: 'reuse' })
    expect(nav.navigate).toHaveBeenLastCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: 'saved',
      mode: 'predict',
    })
    expect(useTxrIntakeStore.getState().predictMeasurements).toBe(predict)

    // The ONE predict intent itself pins no source (round 1's bridge then
    // continues to the saved-models list; round 2's /choose-models reads it).
    await runAction('flow.startPath', { intent: 'predict' })
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: null,
      mode: 'predict',
    })
  })
})

describe('flow.useExample', () => {
  beforeEach(() => {
    useTxrIntakeStore.getState().reset()
    // The example-family bytes (the Start cards' fixtures, one per kind).
    api.example.mockImplementation(({ kind }: { kind: string }) =>
      Promise.resolve(
        kind === 'patients'
          ? 'patient_id,pfs_days,pfs_event\nP0001,214,1\n'
          : kind === 'measurements'
            ? 'patient_id,day,marker,value,unit\nP0001,0,ldh,210,U/L\n'
            : 'patient_id,day,marker,value,unit\nJ1000,0,M1,1.2,a.u.\n',
      ),
    )
  })

  afterEach(() => {
    resetDemoMode()
  })

  it('is registered: McpUse, mutating, global, the predict/train intent params', () => {
    const meta = getActionMeta('flow.useExample')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.context).toBe('global')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
    expect(meta?.title).toBe('Use the example data in a flow')
  })

  it('train: adopts both example files + the example answers, begins the trail here, opens /files', async () => {
    nav.current.mockReturnValue('/help')
    await expect(runAction('flow.useExample', { intent: 'train' })).resolves.toEqual({
      path: '/files',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/files')
    expect(useStepTrailStore.getState().trail).toEqual(['/help'])
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'train',
      mode: 'study',
      exampleLoaded: true,
    })
    expect(useTxrIntakeStore.getState().exampleSlots.patients).toBe(true)
    expect(useTxrIntakeStore.getState().exampleSlots.measurements).toBe(true)
    expect(api.example).toHaveBeenCalledWith({ kind: 'patients' })
    expect(api.example).toHaveBeenCalledWith({ kind: 'measurements' })
  })

  it('predict: adopts the example predict table, ensures the example set, ticks it later, opens /predict-files', async () => {
    api.exampleSet.mockResolvedValueOnce({
      state: 'ready',
      set_id: 'set-1',
      methods: ['kelim'],
      run_id: undefined,
      run_status: undefined,
      error: undefined,
    })
    await expect(runAction('flow.useExample', { intent: 'predict' })).resolves.toEqual({
      path: '/predict-files',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: 'saved',
      mode: 'predict',
    })
    expect(useTxrIntakeStore.getState().exampleSlots.predictMeasurements).toBe(true)
    expect(useTxrIntakeStore.getState().pendingExampleSetId).toBe('set-1')
    expect(api.example).toHaveBeenCalledWith({ kind: 'predict-measurements' })
    expect(api.exampleSet).toHaveBeenCalledTimes(1)
  })

  it('streams the set-training state through the progress channel', async () => {
    api.exampleSet
      .mockResolvedValueOnce({
        state: 'creating',
        run_id: 'r1',
        run_status: 'running',
        methods: ['kelim'],
        set_id: undefined,
        error: undefined,
      })
      .mockResolvedValueOnce({
        state: 'ready',
        set_id: 'set-2',
        methods: ['kelim'],
        run_id: undefined,
        run_status: undefined,
        error: undefined,
      })
    const notes: unknown[] = []
    const { createActionContext } = await import('../ctx')
    const ctx = createActionContext({
      onProgress: (_message, data) => notes.push(data),
    })
    await runAction('flow.useExample', { intent: 'predict' }, ctx)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ state: 'creating', methods: ['kelim'] })
  })

  it('demo: the predict path still ensures the example set (the demo answers it from the recorded bundle)', async () => {
    seedDemoMode('demo')
    api.exampleSet.mockResolvedValueOnce({
      state: 'ready',
      set_id: 'set-demo',
      methods: ['kelim'],
      run_id: undefined,
      run_status: undefined,
      error: undefined,
    })
    await expect(runAction('flow.useExample', { intent: 'predict' })).resolves.toEqual({
      path: '/predict-files',
    })
    expect(nav.navigate).toHaveBeenCalledWith('/predict-files')
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: 'saved',
      mode: 'predict',
    })
    expect(useTxrIntakeStore.getState().pendingExampleSetId).toBe('set-demo')
    expect(api.example).toHaveBeenCalledWith({ kind: 'predict-measurements' })
    expect(api.exampleSet).toHaveBeenCalledTimes(1)
  })

  it('refuses while a run is starting or a page dialog is open on the step view', async () => {
    onStep({ step: 'files', url: '/files', blockedReason: 'Starting the run…' })
    await expect(runAction('flow.useExample', { intent: 'train' })).rejects.toThrow(
      'Starting the run…',
    )
    onStep({ step: 'predict-files', url: '/predict-files', dialogOpen: true })
    await expect(runAction('flow.useExample', { intent: 'predict' })).rejects.toThrow(
      STEP_BACK_DIALOG_OPEN,
    )
    expect(nav.navigate).not.toHaveBeenCalled()
    expect(useTxrIntakeStore.getState().intent).toBe('train')
  })

  it('rejects an intent it does not know', async () => {
    await expect(runAction('flow.useExample', { intent: 'pretrained' })).rejects.toThrow(
      /invalid params/,
    )
  })
})

describe('models.useModel (Your models "Use")', () => {
  beforeEach(() => {
    useTxrIntakeStore.getState().reset()
    useTxrModelsStore.getState().reset()
  })

  it('is registered: McpUse, mutating, global', () => {
    const meta = getActionMeta('models.useModel')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.context).toBe('global')
  })

  it('sets the predict intent + the saved source and the model to tick, starts the trail where it is used, opens N naming the model', async () => {
    nav.current.mockReturnValue('/models?set=set-a')
    await expect(
      runAction('models.useModel', { modelId: 'm-1', name: 'CRC cohort, day 60' }),
    ).resolves.toEqual({ path: '/predict-files?use=m-1&name=CRC%20cohort%2C%20day%2060' })
    expect(nav.navigate).toHaveBeenCalledWith('/predict-files?use=m-1&name=CRC%20cohort%2C%20day%2060')
    expect(useTxrIntakeStore.getState()).toMatchObject({
      intent: 'predict',
      predictSource: 'saved',
      mode: 'predict',
    })
    expect(useTxrModelsStore.getState().pendingUseModelId).toBe('m-1')
    expect(useStepTrailStore.getState().trail).toEqual(['/models?set=set-a'])
  })

  it('without a name, N names no model', async () => {
    await runAction('models.useModel', { modelId: 'm-2' })
    expect(nav.navigate).toHaveBeenCalledWith('/predict-files?use=m-2')
  })
})
