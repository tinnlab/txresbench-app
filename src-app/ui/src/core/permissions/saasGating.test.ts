// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { setAuthView, type PermissionAuthView } from '@ziee/framework/permissions'
import type { StoreProxy } from '@ziee/framework/stores'
import { isKnownPermission, useHasPermission } from './saasGating'

// TEST-1 / TEST-2 (#42 admin-console-shell, ITEM-3) — the saas-gating seam.
//
// The seam gates a saas admin page on the PRESENCE of its backend-generated
// permission: `admin::accounts` is generated in this build (a real
// `Permissions` member), `billing::manage` stands in for a saas permission
// STRIPPED from the OpenAPI spec in an OSS/desktop build (absent from the enum).

const KNOWN = 'admin::accounts' // a real member of the generated Permissions enum
const STRIPPED = 'billing::manage' // absent from this build's enum (saas-only)

// A mutable fake Auth view injected into the permission seam (the app normally
// calls `setAuthView(Auth)` once at startup). A plain object is enough — the
// permission primitives only READ `user` + `permissions` off it.
const view: PermissionAuthView = { user: null, permissions: [] }

beforeEach(() => {
  view.user = null
  view.permissions = []
  setAuthView(view as unknown as StoreProxy<PermissionAuthView>)
})

describe('isKnownPermission (TEST-2)', () => {
  it('is true for a real Permissions enum value', () => {
    expect(isKnownPermission(KNOWN)).toBe(true)
  })
  it('is false for a permission stripped from this build (saas-only)', () => {
    expect(isKnownPermission(STRIPPED)).toBe(false)
  })
})

describe('useHasPermission (TEST-1 — acceptance, INV-2)', () => {
  it('TRUE for a known permission the (non-admin) user holds', () => {
    view.user = { is_admin: false }
    view.permissions = [KNOWN]
    const { result } = renderHook(() => useHasPermission(KNOWN))
    expect(result.current).toBe(true)
  })

  it('TRUE for a known permission via the root-admin short-circuit', () => {
    view.user = { is_admin: true }
    view.permissions = []
    const { result } = renderHook(() => useHasPermission(KNOWN))
    expect(result.current).toBe(true)
  })

  it('FALSE for a stripped (absent) permission EVEN FOR A ROOT ADMIN — the saas self-hide', () => {
    view.user = { is_admin: true } // would pass usePermission via the is_admin bypass…
    view.permissions = []
    const { result } = renderHook(() => useHasPermission(STRIPPED))
    // …but the presence guard runs FIRST, so the absent perm hides for admins too.
    expect(result.current).toBe(false)
  })

  it('FALSE for a known permission a non-admin user does not hold', () => {
    view.user = { is_admin: false }
    view.permissions = ['profile::read']
    const { result } = renderHook(() => useHasPermission(KNOWN))
    expect(result.current).toBe(false)
  })
})
