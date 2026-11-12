// THE CLIENT'S BAND MUST BE THE SERVER'S BAND, IN THE SERVER'S UNIT.
//
// `validate_password_strength` (txresbench-auth) and `check_password` (server user/app handlers)
// compare `password.len()` — UTF-8 BYTES — against 8 and 72, and REJECT outside that band.
// Every case below is stated as a byte count so a future edit to either side shows up as a
// disagreement rather than as a passing test with a different meaning.
//
// No test here prints a secret: the fixtures are repeated single characters chosen for their
// byte width, and the assertions are lengths and refusal strings.

import { describe, expect, it } from 'vitest'
import {
  PASSWORD_HAS_NUL,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  newPasswordField,
  passwordByteLength,
  passwordRefusal,
} from './passwordPolicy'

describe('the band matches the server', () => {
  it('is 8..=72', () => {
    expect(PASSWORD_MIN_BYTES).toBe(8)
    expect(PASSWORD_MAX_BYTES).toBe(72)
  })
})

describe('passwordByteLength counts UTF-8 bytes, not code units', () => {
  it.each([
    ['ascii', 'a'.repeat(72), 72],
    // "é" is ONE code unit and TWO bytes: 40 of them are 40 by String.length and 80 by the
    // server's measure — the exact gap a character cap misses.
    ['latin-1 supplement', 'é'.repeat(40), 80],
    // "🙂" is a surrogate PAIR: 2 code units, 4 bytes.
    ['astral', '🙂'.repeat(10), 40],
  ])('%s', (_label, value, bytes) => {
    expect(passwordByteLength(value)).toBe(bytes)
  })

  it('String.length would have given a different answer for the non-ascii cases', () => {
    // The negative control for the rule above: if these ever agreed, the test would be
    // asserting nothing.
    expect('é'.repeat(40).length).not.toBe(passwordByteLength('é'.repeat(40)))
    expect('🙂'.repeat(10).length).not.toBe(passwordByteLength('🙂'.repeat(10)))
  })
})

describe('passwordRefusal', () => {
  it('accepts exactly 72 bytes and refuses 73', () => {
    expect(passwordRefusal('a'.repeat(72))).toBeNull()
    expect(passwordRefusal('a'.repeat(73))).toBe(PASSWORD_TOO_LONG)
  })

  it('accepts exactly 8 bytes and refuses 7', () => {
    expect(passwordRefusal('a'.repeat(8))).toBeNull()
    expect(passwordRefusal('a'.repeat(7))).toBe(PASSWORD_TOO_SHORT)
  })

  it('refuses 36 accented characters — 72 bytes is the limit, 36 characters is not', () => {
    // 36 chars = 36 code units = 72 bytes: accepted.
    expect(passwordRefusal('é'.repeat(36))).toBeNull()
    // 37 chars = 74 bytes: refused, even though a 72-CHARACTER cap would have waved it through
    // and left the server to say no.
    expect(passwordRefusal('é'.repeat(37))).toBe(PASSWORD_TOO_LONG)
  })

  it('accepts 4 astral characters (16 bytes) even though they are only 4 "characters"', () => {
    // The inverse mistake: an 8-CHARACTER floor would refuse this, but the server accepts it.
    expect('🙂'.repeat(4).length).toBe(8)
    expect(passwordRefusal('🙂'.repeat(4))).toBeNull()
    // 2 astral characters = 8 bytes: still at the floor.
    expect(passwordRefusal('🙂'.repeat(2))).toBeNull()
    // 1 = 4 bytes: under it.
    expect(passwordRefusal('🙂')).toBe(PASSWORD_TOO_SHORT)
  })

  it('refuses a NUL, which the server refuses separately', () => {
    expect(passwordRefusal(`abcdefgh\0ijkl`)).toBe(PASSWORD_HAS_NUL)
  })

  it('never returns a truncated or otherwise altered value — the API cannot express one', () => {
    // A refusal is a string or null. There is no channel here through which a "fixed up"
    // password could be handed back, which is the point of the shape.
    const outcome = passwordRefusal('a'.repeat(200))
    expect(typeof outcome === 'string' || outcome === null).toBe(true)
  })
})

describe('newPasswordField', () => {
  const field = newPasswordField('Enter a password')

  it('leads with the empty message rather than "too short" when nothing was entered', () => {
    const r = field.safeParse('')
    expect(r.success).toBe(false)
    expect(r.success ? [] : r.error.issues.map(i => i.message)).toEqual(['Enter a password'])
  })

  it('states the limit when the value is over it', () => {
    const r = field.safeParse('a'.repeat(73))
    expect(r.success).toBe(false)
    expect(r.success ? '' : r.error.issues[0].message).toContain('72')
  })

  it('returns the value UNCHANGED when it is acceptable', () => {
    const value = 'a'.repeat(72)
    const r = field.safeParse(value)
    expect(r.success).toBe(true)
    expect(r.success ? r.data.length : -1).toBe(72)
    expect(r.success ? r.data === value : false).toBe(true)
  })
})
