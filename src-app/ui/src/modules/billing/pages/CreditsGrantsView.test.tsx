// @vitest-environment jsdom
// TEST-A4 [acceptance][invariant: INV-4], TEST-13 [ITEM-13] — the ledger renders
// the FULL auditable set (active + revoked + expired), each with a resolved grantor
// name (never a UUID), reason, and a status badge; the balance is shown as dollars;
// the premium badge shows when premium is on.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CreditBalanceResponse, CreditGrantResponse } from '@/api-client-saas/types'
import { CreditsGrantsView } from './CreditsGrantsView'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const ADA = '00000000-0000-4000-8000-0000000000f1'
const TURING = '00000000-0000-4000-8000-0000000000f4'

const grants: CreditGrantResponse[] = [
  {
    id: 'g1',
    account_id: 'a1',
    active: true,
    amount_cents: 5000,
    reason: 'Partner comp',
    granted_by: ADA,
    created_at: '2026-08-01T00:00:00Z',
    expires_at: '2026-12-31T23:59:59Z',
  },
  {
    id: 'g2',
    account_id: 'a1',
    active: false,
    amount_cents: 2500,
    reason: 'Trial credit',
    granted_by: TURING,
    created_at: '2026-06-01T00:00:00Z',
    revoked_at: '2026-07-01T00:00:00Z',
    revoked_by: ADA,
  },
  {
    id: 'g3',
    account_id: 'a1',
    active: false,
    amount_cents: 1000,
    reason: 'Promo',
    granted_by: ADA,
    created_at: '2026-03-01T00:00:00Z',
    expires_at: '2026-05-01T23:59:59Z',
  },
]

const credits: CreditBalanceResponse = { account_id: 'a1', balance_cents: 5000, grants }

const baseProps = {
  hasAccount: true,
  loading: false,
  error: null,
  credits,
  premium: false,
  premiumKnown: false,
  canManage: true,
  resolveName: (id?: string | null) =>
    id === ADA ? 'Ada Lovelace' : id === TURING ? 'Alan Turing' : id ? `Name(${id})` : '—',
  onRetry: vi.fn(),
  onOpenGrant: vi.fn(),
  onRevoke: vi.fn(),
  onSetPremium: vi.fn(),
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe('TEST-A4 — auditable ledger retains revoked + expired grants', () => {
  it('renders every grant including the revoked and expired ones', () => {
    render(<CreditsGrantsView {...baseProps} />)
    expect(screen.getByTestId('billing-grant-status-g1').textContent).toBe('Active')
    expect(screen.getByTestId('billing-grant-status-g2').textContent).toBe('Revoked')
    expect(screen.getByTestId('billing-grant-status-g3').textContent).toBe('Expired')
  })

  it('renders grantor as a human name, never a raw UUID', () => {
    render(<CreditsGrantsView {...baseProps} />)
    const table = screen.getByTestId('billing-ledger-table')
    expect(table.textContent).toContain('Ada Lovelace')
    expect(table.textContent).toContain('Alan Turing')
    expect(table.textContent).not.toMatch(UUID_RE)
  })

  it('shows the reason on each grant', () => {
    render(<CreditsGrantsView {...baseProps} />)
    const table = screen.getByTestId('billing-ledger-table')
    expect(table.textContent).toContain('Partner comp')
    expect(table.textContent).toContain('Trial credit')
  })

  it('shows WHO revoked a grant and WHEN (auditability), as a name not a UUID', () => {
    render(<CreditsGrantsView {...baseProps} />)
    const revokedBy = screen.getByTestId('billing-grant-revoked-by-g2')
    expect(revokedBy.textContent).toContain('Ada Lovelace') // g2 revoked_by = ADA
    expect(revokedBy.textContent).not.toMatch(UUID_RE)
    // Active/expired grants carry no revoked-by line.
    expect(screen.queryByTestId('billing-grant-revoked-by-g1')).toBeNull()
  })
})

describe('TEST-13 — balance as dollars, premium badge, pagination', () => {
  it('renders the balance as dollars, not raw cents', () => {
    render(<CreditsGrantsView {...baseProps} />)
    expect(screen.getByTestId('billing-credits-balance').textContent).toBe('$50.00')
  })

  it('renders grant amounts as dollars', () => {
    render(<CreditsGrantsView {...baseProps} />)
    const table = screen.getByTestId('billing-ledger-table')
    expect(table.textContent).toContain('$50.00')
    expect(table.textContent).toContain('$25.00')
    expect(table.textContent).not.toContain('5000')
  })

  it('shows the premium badge only when premium is KNOWN and on (never on cold load)', () => {
    // Unknown (cold load) → no badge even though `premium` defaults false.
    const { rerender } = render(<CreditsGrantsView {...baseProps} premiumKnown={false} premium={false} />)
    expect(screen.queryByTestId('billing-premium-badge')).toBeNull()
    // Known-but-off → still no badge.
    rerender(<CreditsGrantsView {...baseProps} premiumKnown premium={false} />)
    expect(screen.queryByTestId('billing-premium-badge')).toBeNull()
    // Known-and-on → badge.
    rerender(<CreditsGrantsView {...baseProps} premiumKnown premium />)
    expect(screen.getByTestId('billing-premium-badge')).toBeTruthy()
  })

  it('always offers explicit enable/disable premium controls', () => {
    render(<CreditsGrantsView {...baseProps} />)
    expect(screen.getByTestId('billing-premium-enable')).toBeTruthy()
    expect(screen.getByTestId('billing-premium-disable')).toBeTruthy()
  })

  // TEST-15 [ITEM-19/ITEM-20] — premium is a DEFINITE read-state, and the old "not reported
  // by the API" caveat is gone now that the billing GET projects `premium` (#39).
  it('shows the definite premium state and NO "not reported by API" caveat', () => {
    const { rerender } = render(<CreditsGrantsView {...baseProps} premiumKnown premium />)
    expect(screen.getByTestId('billing-premium-known').textContent).toContain(
      'Comped to unlimited allowance',
    )
    expect(screen.queryByText(/isn't reported by the billing API/i)).toBeNull()
    rerender(<CreditsGrantsView {...baseProps} premiumKnown premium={false} />)
    expect(screen.getByTestId('billing-premium-known').textContent).toContain('Not comped')
    expect(screen.queryByText(/isn't reported by the billing API/i)).toBeNull()
    // The old "(set this session)" qualifier is gone — it's a real read now, not a session note.
    expect(screen.queryByText(/set this session/i)).toBeNull()
  })

  it('renders the ledger pagination with a total', () => {
    render(<CreditsGrantsView {...baseProps} />)
    expect(screen.getByTestId('billing-ledger-pagination')).toBeTruthy()
  })

  it('shows the no-account prompt when no account is selected', () => {
    render(<CreditsGrantsView {...baseProps} hasAccount={false} credits={null} />)
    expect(screen.getByTestId('billing-credits-noaccount')).toBeTruthy()
  })
})
