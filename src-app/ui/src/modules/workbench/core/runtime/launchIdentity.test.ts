import { describe, it, expect, beforeEach } from 'vitest'
import { canonicalize, launchIdentity } from './launchIdentity'
import { markInFlight, isInFlight, __resetInFlightForTests } from './inFlightLaunches'

// The duplicate-run guard rests entirely on these two. The identity decides what counts as "the
// same launch"; the set decides how long that lasts. Both have a failure mode that is worse than
// being absent: an identity that varies with key order makes the guard INTERMITTENT, and a flag
// that outlives its run disables Run forever.

describe('launch identity is stable under everything that does not change the submission', () => {
  it('is unchanged by key order, at every depth', () => {
    const a = launchIdentity('an.analysis', { matrix: 'a1', extra: 'a2' }, { max: 10, min: 1 })
    const b = launchIdentity('an.analysis', { extra: 'a2', matrix: 'a1' }, { min: 1, max: 10 })
    expect(a).toBe(b)
    // Nested, because a params bag is not flat in practice (a criteria list of objects).
    expect(canonicalize({ x: { p: 1, q: 2 } })).toBe(canonicalize({ x: { q: 2, p: 1 } }))
  })

  it('preserves ARRAY order — an array is data, not an accident of construction', () => {
    // A slot list and a criteria list mean different things in different orders, so two launches
    // that differ only in array order are genuinely different submissions.
    expect(canonicalize({ k: [1, 2] })).not.toBe(canonicalize({ k: [2, 1] }))
  })

  it('ignores `undefined` members — they are absent from the body either way', () => {
    expect(launchIdentity('a', { m: 'x' }, { min: undefined })).toBe(launchIdentity('a', { m: 'x' }, {}))
  })

  it('separates different analyses, inputs and params', () => {
    const base = launchIdentity('a', { m: 'x' }, { min: 1 })
    expect(base).not.toBe(launchIdentity('b', { m: 'x' }, { min: 1 }))
    expect(base).not.toBe(launchIdentity('a', { m: 'y' }, { min: 1 }))
    expect(base).not.toBe(launchIdentity('a', { m: 'x' }, { min: 2 }))
  })

  it('reads as the submission it names', () => {
    // Not a digest: when the guard misfires, the identity has to say what it thought was equal.
    expect(launchIdentity('a', { m: 'x' }, {})).toContain('a::')
    expect(launchIdentity('a', { m: 'x' }, {})).toContain('"m":"x"')
  })
})

describe('in-flight membership is exactly “submitted and not yet finished”', () => {
  beforeEach(() => __resetInFlightForTests())

  it('marks, then releases', () => {
    const id = launchIdentity('a', {}, {})
    expect(isInFlight(id)).toBe(false)
    const release = markInFlight(id)
    expect(isInFlight(id)).toBe(true)
    release()
    expect(
      isInFlight(id),
      'a finished run must be re-runnable with identical inputs — the guard is against the ' +
        'accidental second click, not against the user',
    ).toBe(false)
  })

  it('a double release does not clear a DIFFERENT launch of the same identity', () => {
    // The caller releases on a terminal frame and on the error path, so double release is normal.
    const id = launchIdentity('a', {}, {})
    const first = markInFlight(id)
    const second = markInFlight(id)
    first()
    first() // repeated — must be inert
    expect(isInFlight(id), 'the second launch is still running').toBe(true)
    second()
    expect(isInFlight(id)).toBe(false)
  })

  it('tracks launches independently', () => {
    const a = markInFlight(launchIdentity('a', {}, {}))
    markInFlight(launchIdentity('b', {}, {}))
    a()
    expect(isInFlight(launchIdentity('a', {}, {}))).toBe(false)
    expect(isInFlight(launchIdentity('b', {}, {}))).toBe(true)
  })
})
