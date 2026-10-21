// @vitest-environment jsdom
// TEST-9 [covers ITEM-9] — the set-plan drawer offers a TYPED plan Select seeded
// from the real catalog (never a free-text box), including the account's current
// plan even if the catalog omits it.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PlanCatalogEntry } from '@/api-client-saas/types'

const getCatalog = vi.hoisted(() => vi.fn())
vi.mock('@/api-client-saas/client', () => ({ SaasApiClient: { Billing: { getCatalog } } }))
vi.mock('@/core/actions/defineAction', () => ({ runAction: vi.fn() }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})
afterEach(cleanup)

const { planOptions, SetPlanDrawer } = await import('./SetPlanDrawer')
const { useSetPlanDrawerStore } = await import('./SetPlanDrawer.store')
const { useBillingSubscriptionStore } = await import('@/modules/billing/stores/BillingSubscription.store')

const catalog: PlanCatalogEntry[] = [
  // `member_allowance` (#141) is the plan's SEAT allowance. Required on the DTO, so the
  // fixtures carry it; these tests are about plan SELECTION and do not assert on it.
  { id: 'free', compute_allowance: 10, storage_allowance: 5, member_allowance: 5, hard_cap: true, overage: false },
  { id: 'pro', compute_allowance: 1000, storage_allowance: 500, member_allowance: 50, hard_cap: false, overage: true },
]

describe('TEST-9 — planOptions', () => {
  it('lists the catalog plans', () => {
    const opts = planOptions(catalog, 'pro')
    expect(opts.map(o => o.value)).toEqual(['free', 'pro'])
  })

  it('appends the current plan when the catalog omits it', () => {
    const opts = planOptions(catalog, 'legacy-enterprise')
    expect(opts.map(o => o.value)).toContain('legacy-enterprise')
    expect(opts.find(o => o.value === 'legacy-enterprise')?.label).toContain('(current)')
  })
})

describe('TEST-9 — set-plan drawer renders a typed Select from the catalog', () => {
  it('fetches the catalog and renders the plan Select (not a free-text box)', async () => {
    getCatalog.mockResolvedValue(catalog)
    useBillingSubscriptionStore.setState({ billing: { account_id: 'a1', plan_id: 'pro', subscription_status: 'active', suspended: false } } as never)
    useSetPlanDrawerStore.setState({ isOpen: true } as never)
    // The drawer takes the account from an `accountId` prop (#57).
    render(<SetPlanDrawer accountId="a1" />)
    await waitFor(() => expect(getCatalog).toHaveBeenCalled())
    expect(screen.getByTestId('billing-setplan-select')).toBeTruthy()
    expect(screen.getByTestId('billing-setplan-form').querySelector('textarea')).toBeNull()
  })
})
