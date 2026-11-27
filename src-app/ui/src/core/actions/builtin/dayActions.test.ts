// The day choices' actions (`./dayActions.ts`): the registered metadata the
// palette and the AI read, `flow.setLastDrawDay` (the questions step's last
// draw, also the decision day) and `runSettings.setDay` (step 4's settings,
// an instance action routed to the page's handler).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigate: vi.fn(), current: vi.fn(() => '/') }))
vi.mock('../navigateBridge', () => ({
  navigateViaBridge: nav.navigate,
  currentPathViaBridge: nav.current,
}))

import './dayActions'
import { LAST_DRAW_NOT_ON_STEP } from './dayActions'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { registerInstance, unregisterInstance } from '../instanceRegistry'
import { useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import { useStepTrailStore } from '@/modules/txrintake/lib/stepTrail'
import {
  RUN_SETTINGS_SET_COVARIATES,
  RUN_SETTINGS_SET_DAY,
  TXR_RUN_SETTINGS_CONTEXT,
} from '@/modules/txrrun/lib/settings'
import type { FileTimeline } from '@/api-client/types'

const FACTS: FileTimeline = {
  draw_days: [[21, 42]],
  outcomes: [],
  limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10, crosscheck_min_patients: 15, crosscheck_min_per_class: 3 },
}

function onStudyStep(): void {
  useStepTrailStore.setState({
    current: { step: 'study', url: '/study', fallback: '/files', blockedReason: null, dialogOpen: false },
  })
}

beforeEach(() => {
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  useTxrIntakeStore.getState().reset()
})

describe('flow.setLastDrawDay', () => {
  it('is registered: McpUse, mutating, global, the txr.step context', () => {
    const meta = getActionMeta('flow.setLastDrawDay')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe('txr.step')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('stores the answer and the decision day together, keeping the day facts', async () => {
    onStudyStep()
    useTxrIntakeStore.setState({ dayFacts: FACTS })
    await expect(runAction('flow.setLastDrawDay', { day: 41 })).resolves.toEqual({ day: 41 })
    const s = useTxrIntakeStore.getState()
    expect(s.study.lastDrawDay).toBe(41)
    expect(s.parameters.decision_day).toBe(41)
    expect(s.validation).toBeNull()
    expect(s.dayFacts).toBe(FACTS)
  })

  it('refuses away from the questions step', async () => {
    await expect(runAction('flow.setLastDrawDay', { day: 41 })).rejects.toThrow(LAST_DRAW_NOT_ON_STEP)
    expect(useTxrIntakeStore.getState().study.lastDrawDay).toBeNull()
  })

  it('refuses a day outside the limits', async () => {
    onStudyStep()
    useTxrIntakeStore.setState({ dayFacts: FACTS })
    await expect(runAction('flow.setLastDrawDay', { day: 0 })).rejects.toThrow(
      'Choose a whole day from 1 to 729.',
    )
    await expect(runAction('flow.setLastDrawDay', { day: 730 })).rejects.toThrow(
      'Choose a whole day from 1 to 729.',
    )
    useTxrIntakeStore.setState({ dayFacts: null })
    await expect(runAction('flow.setLastDrawDay', { day: 0 })).rejects.toThrow('Choose a whole day from 1.')
    expect(useTxrIntakeStore.getState().study.lastDrawDay).toBeNull()
  })
})

describe('runSettings.setDay', () => {
  it('is registered: McpUse, mutating, an instance action of the run settings', () => {
    const meta = getActionMeta(RUN_SETTINGS_SET_DAY)
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('instance')
    expect(meta?.context).toBe(TXR_RUN_SETTINGS_CONTEXT)
  })

  it('calls the page handler of the named settings', async () => {
    const handler = vi.fn(() => ({ decision_day: 56, look_ahead_day: 300 }))
    registerInstance('settings-1', {
      type: TXR_RUN_SETTINGS_CONTEXT,
      getHandlers: () => ({ [RUN_SETTINGS_SET_DAY]: handler }),
      getSnapshot: () => ({ decision_day: 56, look_ahead_day: 238, _state_token: 'settings-1@0' }),
    })
    try {
      await expect(
        runAction(RUN_SETTINGS_SET_DAY, { view_id: 'settings-1', field: 'look_ahead_day', day: 300 }),
      ).resolves.toEqual({ decision_day: 56, look_ahead_day: 300 })
      expect(handler).toHaveBeenCalledWith({ field: 'look_ahead_day', day: 300 }, expect.anything())
    } finally {
      unregisterInstance('settings-1')
    }
  })

  it('refuses an unknown settings view', async () => {
    await expect(
      runAction(RUN_SETTINGS_SET_DAY, { view_id: 'nope', field: 'decision_day', day: 40 }),
    ).rejects.toThrow()
  })
})

describe('runSettings.setCovariates', () => {
  it('is registered: McpUse, mutating, an instance action of the run settings', () => {
    const meta = getActionMeta(RUN_SETTINGS_SET_COVARIATES)
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('instance')
    expect(meta?.context).toBe(TXR_RUN_SETTINGS_CONTEXT)
    expect(meta?.stateful).toBe(false)
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('calls the page handler of the named settings', async () => {
    const handler = vi.fn(() => ({ covariates: true }))
    registerInstance('settings-1', {
      type: TXR_RUN_SETTINGS_CONTEXT,
      getHandlers: () => ({ [RUN_SETTINGS_SET_COVARIATES]: handler }),
      getSnapshot: () => ({ covariates: false, _state_token: 'settings-1@0' }),
    })
    try {
      await expect(
        runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: 'settings-1', on: true }),
      ).resolves.toEqual({ covariates: true })
      expect(handler).toHaveBeenCalledWith({ on: true }, expect.anything())
    } finally {
      unregisterInstance('settings-1')
    }
  })

  it('refuses an unknown settings view', async () => {
    await expect(
      runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: 'nope', on: false }),
    ).rejects.toThrow()
  })
})
