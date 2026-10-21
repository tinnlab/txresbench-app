// TEST-6 (#49) — the jobs.updateSettings admin settings-save mutation is a permissioned defineAction
// dispatched via runAction in its settings section cards (not a human-only form submit), with the
// exact permission that gates the settings PUT.
// TEST-14 (#54) — the action's params accept + forward the new SSE + admission knobs.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './jobsActions' // register
import { getActionMeta, getActionRegistry } from '../defineAction'

const ID = 'jobs.updateSettings'
const PERMISSION = 'jobs::settings::manage'
// Dispatch moved from the page into the three section cards (#54); each is a
// permissioned runAction, not an inline onClick.
const DISPATCH_COMPONENTS = [
  'src/modules/jobs/components/JobConcurrencyCard.tsx',
  'src/modules/jobs/components/JobStreamingCard.tsx',
  'src/modules/jobs/components/JobAdmissionCard.tsx',
  'src/modules/jobs/components/JobSchedulerCard.tsx',
]

describe('TEST-6 — jobs.updateSettings is a permissioned, AI-drivable settings defineAction', () => {
  it('is registered, mutating, AI-surfaced with the exact permission', () => {
    const meta = getActionMeta(ID)
    expect(meta, ID + ' not registered').toBeTruthy()
    expect(meta?.permission).toBe(PERMISSION)
    expect(meta?.mutating).toBe(true)
    expect(meta?.surfaces?.ai).not.toBe(false)
  })
  it('is dispatched via runAction in each settings section card', () => {
    for (const component of DISPATCH_COMPONENTS) {
      const src = readFileSync(resolve(process.cwd(), component), 'utf8')
      expect(src, component + ' must dispatch via runAction').toContain("runAction('" + ID + "'")
    }
  })
})

describe('TEST-14 — jobs.updateSettings accepts + forwards the SSE + admission knobs', () => {
  const params = () => {
    const entry = getActionRegistry().get(ID)
    expect(entry, ID + ' not registered').toBeTruthy()
    return entry!.params
  }

  it('accepts the four new optional knobs at the zod boundary', () => {
    const parsed = params().safeParse({
      sse_keep_alive_secs: 30,
      sse_max_clients: 512,
      admission_wait_secs: 20,
      admission_poll_ms: 500,
    })
    expect(parsed.success, JSON.stringify(parsed)).toBe(true)
  })

  it('rejects a non-integer knob at the zod boundary (before any store call)', () => {
    expect(params().safeParse({ sse_max_clients: 3.5 }).success).toBe(false)
    expect(params().safeParse({ admission_wait_secs: 1.5 }).success).toBe(false)
  })

  it('forwards every new knob from run() into JobSettings.update', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/actions/builtin/jobsActions.ts'),
      'utf8',
    )
    for (const key of [
      'sse_keep_alive_secs',
      'sse_max_clients',
      'admission_wait_secs',
      'admission_poll_ms',
    ]) {
      // the key is both destructured from params AND passed into JobSettings.update(...)
      expect(src, `run() must forward ${key}`).toContain(key)
    }
    expect(src).toContain('JobSettings.update({')
  })
})

describe('TEST-11 (#56) — jobs.updateSettings accepts + forwards the scheduler/reaper knobs', () => {
  const params = () => {
    const entry = getActionRegistry().get(ID)
    expect(entry, ID + ' not registered').toBeTruthy()
    return entry!.params
  }
  const SCHEDULER_KEYS = [
    'heartbeat_secs',
    'reaper_tick_secs',
    'stale_threshold_secs',
    'max_reclaims',
    'reclaim_batch',
    'dispatch_tick_ms',
    'metric_tick_secs',
  ]

  it('accepts the seven new optional scheduler knobs at the zod boundary', () => {
    const parsed = params().safeParse({
      heartbeat_secs: 20,
      reaper_tick_secs: 30,
      stale_threshold_secs: 120,
      max_reclaims: 8,
      reclaim_batch: 250,
      dispatch_tick_ms: 1000,
      metric_tick_secs: 3,
    })
    expect(parsed.success, JSON.stringify(parsed)).toBe(true)
  })

  it('rejects a non-integer scheduler knob at the zod boundary', () => {
    expect(params().safeParse({ heartbeat_secs: 2.5 }).success).toBe(false)
    expect(params().safeParse({ reclaim_batch: 100.5 }).success).toBe(false)
  })

  it('forwards every scheduler knob from run() into JobSettings.update', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/actions/builtin/jobsActions.ts'),
      'utf8',
    )
    for (const key of SCHEDULER_KEYS) {
      expect(src, `run() must forward ${key}`).toContain(key)
    }
  })
})
