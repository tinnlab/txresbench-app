import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runChoreography, CHOREOGRAPHY_LIMITS, type Step } from './choreography'
import { registerAffordance, __resetAffordancesForTests } from './affordances'
import {
  subscribeChoreography,
  __resetChoreographyBusForTests,
  type ChoreographyEvent,
} from './choreographyBus'
import type { ActionContext } from './ctx'

// TEST-6/7/8 (richer-actions ITEM-6/8/9/14) — the choreography runner: step order,
// the affordance + INSTANCE readiness gates, yield semantics, narrate soft-vs-full
// captions, the dwell limit + reduced-motion collapse, run-serialization, the
// result object, and the failure/interrupt paths (never throws).

function harness(opts: { instanceDelay?: boolean } = {}) {
  const calls: Array<[string, unknown]> = []
  const openPaneCalls: string[] = []
  const inst = {
    id: 'd1',
    type: 'datasets',
    snapshot: {},
    handlers: {
      revealPicker: () => {
        calls.push(['revealPicker', undefined])
        return { ok: true }
      },
      selectDataset: (p: unknown) => {
        calls.push(['selectDataset', p])
        return { ok: true }
      },
      attach: (p: unknown) => {
        calls.push(['attach', p])
        return { ok: true }
      },
      failing: () => {
        calls.push(['failing', undefined])
        return { ok: false }
      },
      thrower: () => {
        calls.push(['thrower', undefined])
        throw new Error('boom')
      },
    },
  }
  let instanceAvailable = !opts.instanceDelay
  const ctx = {
    navigate() {},
    progress() {},
    log() {},
    instance: () => inst,
    instances: (t: string) => (instanceAvailable && t === 'datasets' ? [inst] : []),
    stores: { instance: () => inst, instances: () => [inst] },
  } as unknown as ActionContext
  const events: ChoreographyEvent[] = []
  subscribeChoreography(e => events.push(e))
  return {
    ctx,
    calls,
    events,
    openPaneCalls,
    makeInstanceAvailable: () => {
      instanceAvailable = true
    },
  }
}

const baseOpts = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) => ({
  instanceType: 'datasets',
  narrate: true,
  prefersReducedMotion: true,
  openPane: (k: string) => {
    h.openPaneCalls.push(k)
  },
  ...over,
})

const el = () => ({}) as unknown as HTMLElement

describe('runChoreography — sequence (ITEM-6/14)', () => {
  beforeEach(() => {
    __resetAffordancesForTests()
    __resetChoreographyBusForTests()
  })

  it('runs steps in order, opens the pane, invokes handlers, emits spotlights + a final clear, returns ok', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    registerAffordance('datasets:attach-button', el())
    const steps: Step[] = [
      { op: 'openPane', kind: 'datasets' },
      { handler: 'revealPicker', spotlight: 'datasets:picker', caption: 'Opening…' },
      { handler: 'attach', spotlight: 'datasets:attach-button', caption: 'Attaching…' },
    ]
    const res = await runChoreography(steps, { view_id: 'w', dataset_id: 'ds1' }, h.ctx, baseOpts(h))
    expect(res).toMatchObject({ ok: true })
    expect(h.openPaneCalls).toEqual(['datasets'])
    expect(h.calls.map(c => c[0])).toEqual(['revealPicker', 'attach'])
    expect(h.calls.find(c => c[0] === 'attach')?.[1]).toMatchObject({ dataset_id: 'ds1' })
    const spots = h.events.filter(e => e.type === 'spotlight')
    expect(spots.map(e => (e as { caption?: string }).caption)).toEqual(['Opening…', 'Attaching…'])
    expect(h.events.at(-1)?.type).toBe('clear')
  })

  it('a handler step WAITS for its affordance before invoking (readiness gate)', async () => {
    const h = harness()
    let resolved = false
    const p = runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h),
    ).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(h.calls.length).toBe(0)
    registerAffordance('datasets:picker', el())
    await p
    expect(resolved).toBe(true)
    expect(h.calls.map(c => c[0])).toEqual(['revealPicker'])
  })

  it('WAITS for the live INSTANCE (registered a phase later) before invoking (react-state race fix)', async () => {
    const h = harness({ instanceDelay: true }) // instance not yet registered
    registerAffordance('datasets:picker', el())
    const p = runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { readinessTimeoutMs: 2000 }),
    )
    await Promise.resolve()
    expect(h.calls.length).toBe(0) // affordance ready but instance not → still waiting
    h.makeInstanceAvailable()
    const res = await p
    expect(res.ok).toBe(true)
    expect(h.calls.map(c => c[0])).toEqual(['revealPicker'])
  })

  it('stops at yield — later steps do not run, result yielded', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const steps: Step[] = [
      { handler: 'revealPicker', spotlight: 'datasets:picker' },
      { op: 'yield' },
      { handler: 'attach', spotlight: 'datasets:picker' },
    ]
    const res = await runChoreography(steps, { view_id: 'w' }, h.ctx, baseOpts(h))
    expect(res).toMatchObject({ ok: true, yielded: true })
    expect(h.calls.map(c => c[0])).toEqual(['revealPicker'])
  })

  it('soft (narrate:false) emits a spotlight WITHOUT a caption', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker', caption: 'X' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { narrate: false }),
    )
    const spot = h.events.find(e => e.type === 'spotlight') as { caption?: string }
    expect(spot.caption).toBeUndefined()
  })

  it('best-effort: an affordance that never registers still invokes the handler (not-ready branch)', async () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { readinessTimeoutMs: 20 }),
    )
    expect(res.ok).toBe(true)
    expect(h.calls.map(c => c[0])).toEqual(['revealPicker'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('runChoreography — dwell limits (ITEM-8)', () => {
  beforeEach(() => {
    __resetAffordancesForTests()
    __resetChoreographyBusForTests()
  })

  it('reduced motion + ready affordance+instance schedules NO timer (dwell collapsed to 0)', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { prefersReducedMotion: true }),
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('non-reduced schedules a dwell of CHOREOGRAPHY_LIMITS.stepDwellMs', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { prefersReducedMotion: false }),
    )
    expect(spy.mock.calls.some(c => c[1] === CHOREOGRAPHY_LIMITS.stepDwellMs)).toBe(true)
    spy.mockRestore()
  })

  it('holds the final spotlight for CHOREOGRAPHY_LIMITS.finalHoldMs before clearing (FB-1)', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { prefersReducedMotion: false }),
    )
    expect(spy.mock.calls.some(c => c[1] === CHOREOGRAPHY_LIMITS.finalHoldMs)).toBe(true)
    spy.mockRestore()
  })
})

describe('runChoreography — failure + interruption (ITEM-9)', () => {
  beforeEach(() => {
    __resetAffordancesForTests()
    __resetChoreographyBusForTests()
  })

  it('an already-aborted signal runs zero steps and returns aborted', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const ac = new AbortController()
    ac.abort()
    const res = await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      { ...h.ctx, signal: ac.signal } as ActionContext,
      baseOpts(h),
    )
    expect(res).toMatchObject({ ok: false, aborted: true })
    expect(h.calls.length).toBe(0)
    expect(h.events.some(e => e.type === 'clear')).toBe(true)
  })

  it('aborting mid-run (while awaiting an affordance) stops remaining steps + clears', async () => {
    const h = harness()
    const ac = new AbortController()
    const p = runChoreography(
      [
        { handler: 'revealPicker', spotlight: 'datasets:picker' },
        { handler: 'attach', spotlight: 'datasets:picker' },
      ],
      { view_id: 'w' },
      { ...h.ctx, signal: ac.signal } as ActionContext,
      baseOpts(h, { readinessTimeoutMs: 2000 }),
    )
    ac.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false, aborted: true })
    expect(h.calls.length).toBe(0)
    expect(h.events.some(e => e.type === 'clear')).toBe(true)
  })

  it('a NEW run supersedes an in-flight one (run-serialization)', async () => {
    const hA = harness()
    const hB = harness()
    registerAffordance('datasets:pB', el())
    // A awaits an affordance that never registers → stays in-flight.
    const pA = runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:pA' }],
      { view_id: 'w' },
      hA.ctx,
      baseOpts(hA, { readinessTimeoutMs: 3000 }),
    )
    await Promise.resolve()
    const rB = await runChoreography(
      [{ handler: 'revealPicker', spotlight: 'datasets:pB' }],
      { view_id: 'w' },
      hB.ctx,
      baseOpts(hB),
    )
    const rA = await pA
    expect(rA.aborted).toBe(true) // superseded
    expect(rB.ok).toBe(true)
    // The superseded run A must NOT emit a clobbering `clear`: only B (which owns
    // the overlay) clears when it finishes. Exactly one clear in the whole stream.
    expect(hA.events.filter(e => e.type === 'clear').length).toBe(1)
  })

  it('never throws when a handler throws — returns ok:false + error, and clears', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const res = await runChoreography(
      [{ handler: 'thrower', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/threw/)
    expect(h.events.at(-1)?.type).toBe('clear')
  })

  it('a handler that returns {ok:false} stops the run with ok:false (no false success)', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    registerAffordance('datasets:attach-button', el())
    const res = await runChoreography(
      [
        { handler: 'failing', spotlight: 'datasets:picker' },
        { handler: 'attach', spotlight: 'datasets:attach-button' },
      ],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h),
    )
    expect(res.ok).toBe(false)
    expect(h.calls.map(c => c[0])).toEqual(['failing']) // stopped before attach
  })

  it('a missing handler returns ok:false with an error', async () => {
    const h = harness()
    registerAffordance('datasets:picker', el())
    const res = await runChoreography(
      [{ handler: 'nonexistent', spotlight: 'datasets:picker' }],
      { view_id: 'w' },
      h.ctx,
      baseOpts(h, { readinessTimeoutMs: 100 }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unavailable/)
  })
})
