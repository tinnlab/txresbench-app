import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerAffordance,
  getAffordance,
  unregisterAffordance,
  awaitAffordance,
  __resetAffordancesForTests,
} from './affordances'

// TEST-5 (richer-actions ITEM-5) — the affordance registry: round-trip, the
// readiness gate (`awaitAffordance` resolves on later registration, rejects on
// abort/timeout), and the element-guarded unregister (a stale unmount can't
// clobber a remount).

// The registry only STORES the element (no DOM ops), so a stub object suffices in
// the node test env.
const stubEl = () => ({}) as unknown as HTMLElement

describe('affordance registry (ITEM-5)', () => {
  beforeEach(() => __resetAffordancesForTests())

  it('round-trips register / get / unregister', () => {
    const el = stubEl()
    registerAffordance('picker', el)
    expect(getAffordance('picker')?.el).toBe(el)
    unregisterAffordance('picker')
    expect(getAffordance('picker')).toBeUndefined()
  })

  it('a timed-out await does not corrupt a later await for the same name', async () => {
    // The first await times out; its waiter-cleanup must not leave a stale/dead
    // resolver that breaks a fresh await on the same name.
    await expect(awaitAffordance('gone', { timeoutMs: 5 })).rejects.toThrow(/not ready/)
    const p = awaitAffordance('gone', { timeoutMs: 1000 })
    const el = stubEl()
    registerAffordance('gone', el)
    await expect(p).resolves.toMatchObject({ el })
  })

  it('awaitAffordance resolves immediately when already registered', async () => {
    const el = stubEl()
    registerAffordance('picker', el)
    await expect(awaitAffordance('picker')).resolves.toMatchObject({ el })
  })

  it('awaitAffordance resolves when the name registers AFTER the await (readiness gate)', async () => {
    const pending = awaitAffordance('picker', { timeoutMs: 1000 })
    const el = stubEl()
    registerAffordance('picker', el)
    await expect(pending).resolves.toMatchObject({ el })
  })

  it('awaitAffordance rejects on signal abort', async () => {
    const ac = new AbortController()
    const pending = awaitAffordance('never', { signal: ac.signal, timeoutMs: 1000 })
    ac.abort()
    await expect(pending).rejects.toThrow()
  })

  it('awaitAffordance rejects after the timeout', async () => {
    await expect(awaitAffordance('never', { timeoutMs: 10 })).rejects.toThrow(/not ready/)
  })

  it('element-guarded unregister ignores a stale element (remount safety)', () => {
    const a = stubEl()
    const b = stubEl()
    registerAffordance('picker', a)
    registerAffordance('picker', b) // remount replaced the entry
    unregisterAffordance('picker', a) // the OLD element's unmount fires late
    expect(getAffordance('picker')?.el).toBe(b) // not clobbered
  })
})
