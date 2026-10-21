// TEST-A5 [acceptance][invariant: INV-5] — money is CENTS in the API, rendered as
// USD dollars in the UI. Proves the single formatter never shows a raw cents
// integer where a dollar amount belongs, and the grant form's dollars→cents.

import { describe, expect, it } from 'vitest'
import { formatCents, dollarsToCents } from './money'

describe('TEST-A5 — formatCents (cents → dollars)', () => {
  it('formats cents as USD dollars', () => {
    expect(formatCents(1250)).toBe('$12.50')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(5000)).toBe('$50.00')
  })

  it('never renders a raw cents integer as if it were dollars', () => {
    // 1250 cents is $12.50 — NOT "1250" and NOT "$1250".
    const out = formatCents(1250)
    expect(out).not.toBe('1250')
    expect(out).not.toContain('1250')
  })

  it('is resilient to a NaN/undefined slipping through', () => {
    expect(formatCents(Number.NaN)).toBe('$0.00')
  })
})

describe('TEST-A5 — dollarsToCents (form dollars → API cents)', () => {
  it('converts dollars to integer cents without float drift', () => {
    expect(dollarsToCents(12.5)).toBe(1250)
    expect(dollarsToCents(0.1)).toBe(10)
    expect(dollarsToCents(12.1)).toBe(1210)
    expect(dollarsToCents(1234.56)).toBe(123456)
    expect(dollarsToCents(50)).toBe(5000)
  })

  it('round-trips through formatCents', () => {
    expect(formatCents(dollarsToCents(12.5))).toBe('$12.50')
  })
})
