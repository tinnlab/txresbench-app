// transitions.test.ts — the PURE per-plot transition config → deck.gl `transitions` mapper.
// Proves the DEFAULT-OFF contract (off ⇒ NO `transitions` key ⇒ instant, byte-identical render)
// and the on-mapping (accessor names → { duration, easing-fn }), the duration/easing defaults,
// and the minimal validation. No React, no deck — pure node.

import { describe, it, expect } from 'vitest'
import {
  deckTransitions,
  easingFn,
  transitionsEnabled,
  transitionConfigError,
  DEFAULT_TRANSITION_DURATION,
  DEFAULT_TRANSITION_EASING,
  TRANSITION_EASINGS,
  type TransitionAccessor,
} from './transitions'

const ACCESSORS: readonly TransitionAccessor[] = ['getFillColor', 'getPosition']

describe('deckTransitions — default OFF (opt-in)', () => {
  it('returns undefined for `false` (no `transitions` key ⇒ instant)', () => {
    expect(deckTransitions(false, ACCESSORS)).toBeUndefined()
  })
  it('returns undefined for `undefined` (omitted ⇒ off)', () => {
    expect(deckTransitions(undefined, ACCESSORS)).toBeUndefined()
  })
  it('returns undefined when no accessors are given (nothing to animate)', () => {
    expect(deckTransitions({ duration: 300 }, [])).toBeUndefined()
  })
})

describe('deckTransitions — enabled mapping', () => {
  it('maps EACH accessor to a { duration, easing } setting', () => {
    const tx = deckTransitions({ duration: 250, easing: 'linear' }, ACCESSORS)
    expect(tx).toBeDefined()
    expect(Object.keys(tx!).sort()).toEqual(['getFillColor', 'getPosition'])
    expect(tx!.getFillColor!.duration).toBe(250)
    expect(tx!.getPosition!.duration).toBe(250)
    // easing is a function (deck expects `(t)=>t'`), linear ⇒ identity
    expect(typeof tx!.getFillColor!.easing).toBe('function')
    expect(tx!.getFillColor!.easing(0.42)).toBeCloseTo(0.42)
  })

  it('defaults duration to DEFAULT_TRANSITION_DURATION when omitted', () => {
    const tx = deckTransitions({}, ['getFillColor'])
    expect(tx!.getFillColor!.duration).toBe(DEFAULT_TRANSITION_DURATION)
  })

  it('defaults easing to the cubic-in-out curve when omitted', () => {
    const tx = deckTransitions({ duration: 100 }, ['getRadius'])
    const e = tx!.getRadius!.easing
    // cubic-in-out endpoints + midpoint (symmetric smoothstep-cubic)
    expect(e(0)).toBeCloseTo(0)
    expect(e(1)).toBeCloseTo(1)
    expect(e(0.5)).toBeCloseTo(0.5)
    // it is NOT linear (a true ease has e(0.25) < 0.25)
    expect(e(0.25)).toBeLessThan(0.25)
  })

  it('preserves an explicit duration of 0 (does not fall back to the default)', () => {
    const tx = deckTransitions({ duration: 0 }, ['getFillColor'])
    expect(tx!.getFillColor!.duration).toBe(0)
  })
})

describe('easingFn', () => {
  it('linear is the identity', () => {
    const e = easingFn('linear')
    expect(e(0)).toBe(0)
    expect(e(0.5)).toBe(0.5)
    expect(e(1)).toBe(1)
  })
  it('cubic-in-out is monotonic 0→1', () => {
    const e = easingFn('cubic-in-out')
    let prev = -1
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const v = e(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
  it('DEFAULT_TRANSITION_EASING is a recognized name', () => {
    expect(TRANSITION_EASINGS).toContain(DEFAULT_TRANSITION_EASING)
  })
})

describe('transitionsEnabled', () => {
  it('is false for false/undefined and true for a config object', () => {
    expect(transitionsEnabled(false)).toBe(false)
    expect(transitionsEnabled(undefined)).toBe(false)
    expect(transitionsEnabled({})).toBe(true)
    expect(transitionsEnabled({ duration: 500 })).toBe(true)
  })
})

describe('transitionConfigError — minimal validation', () => {
  it('accepts false / undefined / null (off)', () => {
    expect(transitionConfigError(false)).toBeNull()
    expect(transitionConfigError(undefined)).toBeNull()
    expect(transitionConfigError(null)).toBeNull()
  })
  it('accepts a valid config', () => {
    expect(transitionConfigError({})).toBeNull()
    expect(transitionConfigError({ duration: 300, easing: 'linear' })).toBeNull()
    expect(transitionConfigError({ easing: 'cubic-in-out' })).toBeNull()
  })
  it('rejects a non-object config', () => {
    expect(transitionConfigError(300)).toMatch(/must be `false` or an object/)
  })
  it('rejects a negative / non-finite / non-number duration', () => {
    expect(transitionConfigError({ duration: -5 })).toMatch(/duration/)
    expect(transitionConfigError({ duration: Number.NaN })).toMatch(/duration/)
    expect(transitionConfigError({ duration: '300' })).toMatch(/duration/)
  })
  it('rejects an unknown easing name', () => {
    expect(transitionConfigError({ easing: 'bounce' })).toMatch(/easing/)
  })
})
