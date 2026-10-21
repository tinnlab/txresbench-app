// @vitest-environment jsdom
// TEST-14 [covers ITEM-10] — the admin-accounts module registers the account-detail
// route `/settings/accounts-admin/:id` (gated admin::accounts, requiresAuth,
// SettingsLayout) alongside the list route, and does NOT add a second
// settingsAdminPages nav entry for the detail page.

import { describe, expect, it } from 'vitest'
import { Permissions } from '@/api-client/permissions'

interface RouteView {
  path: string
  permission?: unknown
  requiresAuth?: boolean
  layout?: unknown
}
interface ModuleView {
  routes?: RouteView[]
  slots?: { settingsAdminPages?: { id: string }[] }
}
const adminAccountsModule = (await import('./module')).default as unknown as ModuleView

describe('TEST-14 — account-detail route registration', () => {
  it('registers the `/settings/accounts-admin/:id` detail route gated on admin::accounts', () => {
    const detail = (adminAccountsModule.routes ?? []).find(
      r => r.path === '/settings/accounts-admin/:id',
    )
    expect(detail).toBeTruthy()
    expect(detail?.permission).toBe(Permissions.AdminAccounts)
    expect(detail?.requiresAuth).toBe(true)
    expect(detail?.layout).toBeTruthy()
  })

  it('keeps the list route', () => {
    const list = (adminAccountsModule.routes ?? []).find(
      r => r.path === '/settings/accounts-admin',
    )
    expect(list).toBeTruthy()
  })

  it('adds NO extra settingsAdminPages entry for the detail page (nav shows only the list)', () => {
    const entries = adminAccountsModule.slots?.settingsAdminPages ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('admin-accounts')
  })
})
