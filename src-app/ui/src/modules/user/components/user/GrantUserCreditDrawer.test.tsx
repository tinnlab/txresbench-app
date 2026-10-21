// @vitest-environment jsdom
// TEST-5  [covers ITEM-5] — the per-user grant form collects TYPED fields (amount
//   dollars, required reason, optional expiry) and converts dollars→cents + date→ISO;
//   never a raw-JSON textarea; submit dispatches the user.grantUserCredit defineAction.
// TEST-A5 [acceptance][invariant: INV-4] — a dollar entry becomes integer cents; money
//   is rendered/collected in dollars, never a raw-cents integer.

import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const runActionMock = vi.hoisted(() => vi.fn(async () => ({ account_id: 'acct-1', balance_cents: 5000, grants: [] })))
vi.mock('@/core/actions/defineAction', () => ({ runAction: runActionMock }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const { buildUserGrantParams, GrantUserCreditDrawer } = await import('./GrantUserCreditDrawer')
const { useGrantUserCreditDrawerStore } = await import('./GrantUserCreditDrawer.store')
const { formatCents } = await import('@/modules/billing/lib/money')

describe('TEST-5 / TEST-A5 — buildUserGrantParams (dollars→cents, date→ISO) (INV-4)', () => {
  it('converts dollars to integer cents', () => {
    const p = buildUserGrantParams('acct-1', { amount_dollars: 12.5, reason: 'Comp' })
    expect(p.amount_cents).toBe(1250)
    expect(p.account_id).toBe('acct-1')
    expect(p.reason).toBe('Comp')
    expect(p.expires_at).toBeUndefined()
  })

  it('converts a yyyy-MM-dd expiry to an end-of-day ISO timestamp', () => {
    const p = buildUserGrantParams('acct-1', { amount_dollars: 5, reason: 'x', expires_on: '2026-12-31' })
    expect(p.expires_at).toBe('2026-12-31T23:59:59.000Z')
  })

  it('renders a cents balance as a dollar string, never raw cents (INV-4)', () => {
    expect(formatCents(500000)).toBe('$5,000.00')
    expect(formatCents(1250)).toBe('$12.50')
    expect(formatCents(0)).toBe('$0.00')
  })
})

describe('TEST-5 — grant drawer renders typed fields, no JSON textarea', () => {
  it('renders amount / reason / expiry fields and no textarea, titled with the human label', () => {
    useGrantUserCreditDrawerStore.setState({
      isOpen: true,
      accountId: 'acct-1',
      label: 'Ada Lovelace',
    } as never)
    render(<GrantUserCreditDrawer />)
    expect(screen.getByTestId('user-grant-credit-amount')).toBeTruthy()
    expect(screen.getByTestId('user-grant-credit-reason')).toBeTruthy()
    expect(screen.getByTestId('user-grant-credit-expiry')).toBeTruthy()
    expect(screen.getByTestId('user-grant-credit-form').querySelector('textarea')).toBeNull()
    // Human label, never the account UUID (INV-3).
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy()
    expect(screen.queryByText(/acct-1/)).toBeNull()
  })

  it('submitting a valid form dispatches runAction(user.grantUserCredit) with cents (INV-2/INV-4)', async () => {
    runActionMock.mockClear()
    useGrantUserCreditDrawerStore.setState({ isOpen: true, accountId: 'acct-1', label: 'Ada Lovelace' } as never)
    render(<GrantUserCreditDrawer />)
    // Fill the typed fields.
    const amount = screen.getByTestId('user-grant-credit-amount') as HTMLInputElement
    const reason = screen.getByTestId('user-grant-credit-reason') as HTMLInputElement
    await act(async () => {
      fireEvent.change(amount, { target: { value: '12.50' } })
      fireEvent.blur(amount)
      fireEvent.change(reason, { target: { value: 'Partner comp' } })
      fireEvent.blur(reason)
    })
    await act(async () => {
      fireEvent.submit(screen.getByTestId('user-grant-credit-form'))
    })
    await waitFor(() =>
      expect(runActionMock).toHaveBeenCalledWith('user.grantUserCredit', {
        account_id: 'acct-1',
        amount_cents: 1250,
        reason: 'Partner comp',
      }),
    )
  })
})
