// @vitest-environment jsdom
// TEST-15 [covers ITEM-15] — the grant form collects TYPED fields (amount dollars,
// required reason, optional expiry) and converts dollars→cents + a date→ISO; never
// a raw-JSON textarea.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const runActionMock = vi.hoisted(() => vi.fn())
vi.mock('@/core/actions/defineAction', () => ({ runAction: runActionMock }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const { buildGrantParams, GrantCreditDrawer } = await import('./GrantCreditDrawer')
const { useGrantCreditDrawerStore } = await import('./GrantCreditDrawer.store')

describe('TEST-15 — buildGrantParams (dollars→cents, date→ISO)', () => {
  it('converts dollars to integer cents', () => {
    const p = buildGrantParams('a1', { amount_dollars: 12.5, reason: 'Comp' })
    expect(p.amount_cents).toBe(1250)
    expect(p.account_id).toBe('a1')
    expect(p.reason).toBe('Comp')
    expect(p.expires_at).toBeUndefined()
  })

  it('converts a yyyy-MM-dd expiry to an end-of-day ISO timestamp', () => {
    const p = buildGrantParams('a1', { amount_dollars: 5, reason: 'x', expires_on: '2026-12-31' })
    expect(p.expires_at).toBe('2026-12-31T23:59:59.000Z')
  })

  it('omits expires_at when no expiry is given', () => {
    const p = buildGrantParams('a1', { amount_dollars: 5, reason: 'x', expires_on: '' })
    expect('expires_at' in p).toBe(false)
  })
})

describe('TEST-6 — grant drawer renders typed fields, no JSON textarea, uses accountId prop', () => {
  it('renders amount / reason / expiry fields and no textarea', () => {
    useGrantCreditDrawerStore.setState({ isOpen: true } as never)
    // The drawer now takes the account from an `accountId` prop (#57), not the
    // retired BillingSelection store.
    render(<GrantCreditDrawer accountId="a1" />)
    expect(screen.getByTestId('billing-grant-amount')).toBeTruthy()
    expect(screen.getByTestId('billing-grant-reason')).toBeTruthy()
    expect(screen.getByTestId('billing-grant-expiry')).toBeTruthy()
    expect(screen.getByTestId('billing-grant-form').querySelector('textarea')).toBeNull()
  })
})
