// @vitest-environment jsdom
// TEST-8 [covers ITEM-12] — the billing module retires the three standalone pages:
// it registers NO route and NO settingsAdminPages entry for billing-subscription /
// billing-usage / billing-credits, and the retired BillingSelection store +
// AccountPicker files no longer exist. The billing `defineAction` registration
// import stays (the detail-page drawers still fire billing.* actions).

import { describe, expect, it, vi } from 'vitest'

// Neutralize the presence-gated side-effect import so loading the module is inert.
vi.mock('@/core/permissions', () => ({ isKnownPermission: () => false }))

interface ModuleView {
  routes?: { path: string }[]
  slots?: { settingsAdminPages?: { id: string }[] }
}
const billingModule = (await import('./module')).default as unknown as ModuleView

const RETIRED = ['billing-subscription', 'billing-usage', 'billing-credits']

describe('TEST-8 — billing module retires the standalone pages', () => {
  it('registers no route for any retired billing page', () => {
    const paths = (billingModule.routes ?? []).map(r => r.path)
    for (const id of RETIRED) {
      expect(paths.some(p => p.includes(id))).toBe(false)
    }
  })

  it('registers no settingsAdminPages slot entry for any retired billing page', () => {
    const entries = billingModule.slots?.settingsAdminPages ?? []
    for (const id of RETIRED) {
      expect(entries.some(e => e.id === id)).toBe(false)
    }
  })

  it('no longer ships the BillingSelection store or the AccountPicker', async () => {
    // Variable specifiers so tsc doesn't try to resolve the deleted modules.
    const selPath = '@/modules/billing/stores/BillingSelection.store'
    const pickerPath = '@/modules/billing/components/AccountPicker'
    await expect(import(/* @vite-ignore */ selPath)).rejects.toBeTruthy()
    await expect(import(/* @vite-ignore */ pickerPath)).rejects.toBeTruthy()
  })
})
