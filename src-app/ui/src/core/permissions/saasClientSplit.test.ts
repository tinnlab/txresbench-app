// TEST-1 — acceptance test for the two-spec client seam (#50), INV-1.
//
// Pins the design invariant (admin-console-shell.md §"The saas-gating seam"): a saas-only
// permission is a KNOWN permission in the saas-ON client and ABSENT from the default client.
// This test asserts the DESIGN'S promise directly against the two GENERATED enums — flip the
// generation (e.g. lose the saas billing surface, or leak billing into the default client) and
// it goes red. It imports each client by its FIXED real path, so it is mode-independent (vitest
// runs in default mode; no VITE_SAAS alias is in play).

import { describe, it, expect } from 'vitest'
import { Permissions as DefaultPermissions } from '@/api-client/permissions'
import { Permissions as SaasPermissions } from '@/api-client-saas/permissions'

describe('two-spec client presence-split (#50, INV-1)', () => {
  it('billing::admin IS a known permission in the saas-ON client (api-client-saas/permissions.ts)', () => {
    expect(Object.values(SaasPermissions)).toContain('billing::admin')
  })

  it('billing::admin is ABSENT from the default (saas-OFF) client (api-client/permissions.ts)', () => {
    expect(Object.values(DefaultPermissions)).not.toContain('billing::admin')
  })

  it('the saas client is a strict superset on the billing surface (read/manage present only there)', () => {
    const saas = new Set<string>(Object.values(SaasPermissions))
    const def = new Set<string>(Object.values(DefaultPermissions))
    for (const p of ['billing::admin', 'billing::manage', 'billing::read']) {
      expect(saas.has(p)).toBe(true)
      expect(def.has(p)).toBe(false)
    }
    // Non-billing permissions are identical between the two clients (same backend surface).
    expect(def.has('admin::accounts')).toBe(true)
    expect(saas.has('admin::accounts')).toBe(true)
  })
})
