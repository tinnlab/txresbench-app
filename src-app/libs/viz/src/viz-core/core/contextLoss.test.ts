import { describe, it, expect, vi } from 'vitest'
import {
  initialRecoveryState,
  recoveryReducer,
  isNearContextLimit,
  createContextBudget,
  freeCanvasContext,
  scheduleContextRelease,
  MAX_WEBGL_CONTEXTS,
  CONTEXT_LIMIT_HEADROOM,
} from './contextLoss'

// A canvas test double exposing just what the context-free primitives touch.
function fakeCanvas(opts: { connected: boolean }) {
  const lose = vi.fn()
  const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) }
  return {
    lose,
    canvas: {
      isConnected: opts.connected,
      getContext: (t: string) => (t === 'webgl2' ? gl : null),
    } as unknown as HTMLCanvasElement,
  }
}

// ── Recovery state machine ──────────────────────────────────────────────────

describe('recoveryReducer — lost/restored state machine', () => {
  it('starts not-lost with restoreKey 0', () => {
    expect(initialRecoveryState).toEqual({ lost: false, restoreKey: 0 })
  })

  it('lost sets lost=true WITHOUT bumping restoreKey', () => {
    const next = recoveryReducer(initialRecoveryState, { type: 'lost' })
    expect(next.lost).toBe(true)
    expect(next.restoreKey).toBe(0)
  })

  it('restored clears lost AND bumps restoreKey', () => {
    const lost = recoveryReducer(initialRecoveryState, { type: 'lost' })
    const restored = recoveryReducer(lost, { type: 'restored' })
    expect(restored.lost).toBe(false)
    expect(restored.restoreKey).toBe(1)
  })

  it('a full lost→restored cycle bumps restoreKey by exactly 1', () => {
    let s = initialRecoveryState
    s = recoveryReducer(s, { type: 'lost' })
    s = recoveryReducer(s, { type: 'restored' })
    expect(s).toEqual({ lost: false, restoreKey: 1 })
    s = recoveryReducer(s, { type: 'lost' })
    s = recoveryReducer(s, { type: 'restored' })
    expect(s).toEqual({ lost: false, restoreKey: 2 })
  })

  it('a repeated lost is idempotent (same reference, no double-flag)', () => {
    const lost = recoveryReducer(initialRecoveryState, { type: 'lost' })
    const again = recoveryReducer(lost, { type: 'lost' })
    expect(again).toBe(lost)
  })

  it('restored bumps restoreKey even if not currently lost', () => {
    const next = recoveryReducer(initialRecoveryState, { type: 'restored' })
    expect(next).toEqual({ lost: false, restoreKey: 1 })
  })
})

// ── Context-count budget guard ──────────────────────────────────────────────

describe('freeCanvasContext — reclaims the GL context immediately', () => {
  it('calls WEBGL_lose_context.loseContext()', () => {
    const { canvas, lose } = fakeCanvas({ connected: true })
    freeCanvasContext(canvas)
    expect(lose).toHaveBeenCalledTimes(1)
  })
  it('is defensive: a canvas with no GL context is a no-op (no throw)', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    expect(() => freeCanvasContext(canvas)).not.toThrow()
  })
})

describe('scheduleContextRelease — StrictMode-safe deferred free', () => {
  it('after the macrotask, frees ONLY when the canvas is detached (real unmount)', () => {
    vi.useFakeTimers()
    const { canvas, lose } = fakeCanvas({ connected: false })
    scheduleContextRelease(canvas)
    expect(lose).not.toHaveBeenCalled() // deferred, not synchronous
    vi.runAllTimers()
    expect(lose).toHaveBeenCalledTimes(1) // detached → freed
    vi.useRealTimers()
  })
  it('does NOT free a still-connected canvas (StrictMode simulated unmount keeps it mounted)', () => {
    vi.useFakeTimers()
    const { canvas, lose } = fakeCanvas({ connected: true })
    scheduleContextRelease(canvas)
    vi.runAllTimers()
    expect(lose).not.toHaveBeenCalled() // still in the DOM → live context preserved
    vi.useRealTimers()
  })
})

describe('isNearContextLimit — pop-out budget predicate', () => {
  it('defaults warn within CONTEXT_LIMIT_HEADROOM of MAX_WEBGL_CONTEXTS', () => {
    const threshold = MAX_WEBGL_CONTEXTS - CONTEXT_LIMIT_HEADROOM
    expect(isNearContextLimit(threshold - 1)).toBe(false)
    expect(isNearContextLimit(threshold)).toBe(true)
    expect(isNearContextLimit(MAX_WEBGL_CONTEXTS)).toBe(true)
    expect(isNearContextLimit(MAX_WEBGL_CONTEXTS + 5)).toBe(true)
  })

  it('honors custom max + headroom', () => {
    expect(isNearContextLimit(7, 10, 3)).toBe(true) // 10-3 = 7
    expect(isNearContextLimit(6, 10, 3)).toBe(false)
  })

  it('is quiet well below the cap', () => {
    expect(isNearContextLimit(0)).toBe(false)
    expect(isNearContextLimit(1)).toBe(false)
  })
})

describe('createContextBudget — live-count accounting + warning', () => {
  it('acquire/release track the live count and floor at 0', () => {
    const b = createContextBudget(16, () => {})
    expect(b.count).toBe(0)
    expect(b.acquire()).toBe(1)
    expect(b.acquire()).toBe(2)
    expect(b.count).toBe(2)
    expect(b.release()).toBe(1)
    expect(b.release()).toBe(0)
    // over-release never goes negative
    expect(b.release()).toBe(0)
    expect(b.count).toBe(0)
  })

  it('warns exactly when the live count crosses into the headroom band', () => {
    const onWarn = vi.fn()
    const b = createContextBudget(4, onWarn) // headroom 2 → warn at count>=2
    b.acquire() // 1 — quiet
    expect(onWarn).not.toHaveBeenCalled()
    b.acquire() // 2 — near limit
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn).toHaveBeenLastCalledWith(2, 4)
    b.acquire() // 3 — still warns
    expect(onWarn).toHaveBeenCalledTimes(2)
  })

  it('isNearLimit reflects the current count against the cap', () => {
    const b = createContextBudget(4, () => {})
    expect(b.isNearLimit()).toBe(false)
    b.acquire()
    expect(b.isNearLimit()).toBe(false) // 1 < 4-2
    b.acquire()
    expect(b.isNearLimit()).toBe(true) // 2 >= 4-2
    b.release()
    expect(b.isNearLimit()).toBe(false)
  })

  it('separate budgets are isolated', () => {
    const a = createContextBudget(16, () => {})
    const c = createContextBudget(16, () => {})
    a.acquire()
    a.acquire()
    expect(a.count).toBe(2)
    expect(c.count).toBe(0)
  })
})
