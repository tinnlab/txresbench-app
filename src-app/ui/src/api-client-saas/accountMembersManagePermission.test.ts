// TEST-15 [covers: ITEM-7] (#139) — `account::members::manage` must land in BOTH
// generated permission enums.
//
// The account surface is mounted UNCONDITIONALLY (`account_routes()` is merged with no
// saas cfg-gate at all — DEC-7), so unlike `billing::admin` (saas-only, see
// `saasPermissions.test.ts`) this key belongs in the default enum AND the saas enum.
//
// This is the guard for the two-spec seam: `just openapi-regen` writes the two clients
// in separate passes, so a regen that ran only one of them leaves the key missing from
// the other. Nothing else would catch that — the Rust side compiles fine, and #149
// would simply find `Permissions.AccountMembersManage` undefined in the saas build.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd() // src-app/ui
const defaultEnum = readFileSync(resolve(root, 'src/api-client/permissions.ts'), 'utf8')
const saasEnum = readFileSync(resolve(root, 'src/api-client-saas/permissions.ts'), 'utf8')
const defaultEndpoints = readFileSync(resolve(root, 'src/api-client/apiEndpoints.ts'), 'utf8')
const saasEndpoints = readFileSync(resolve(root, 'src/api-client-saas/apiEndpoints.ts'), 'utf8')

describe('TEST-15 — account::members::manage lands in both generated clients', () => {
  it('is present in the default AND the saas permission enum', () => {
    expect(defaultEnum).toContain("'account::members::manage'")
    expect(saasEnum).toContain("'account::members::manage'")
    // Bound to the name #149's `<Can>` / `defineAction({ permission })` will import.
    expect(defaultEnum).toContain('AccountMembersManage')
    expect(saasEnum).toContain('AccountMembersManage')
  })

  it('does not disturb the existing account keys', () => {
    // INV-15: `account::manage` keeps its admin-only contract and its enum entry; the
    // new key is an ADDITION, not a rename of the old one.
    for (const e of [defaultEnum, saasEnum]) {
      expect(e).toContain("'account::read'")
      expect(e).toContain("'account::manage'")
    }
  })

  it('the account-scoped proof route reached both specs', () => {
    // If the route were missing from a spec, the permission binding that rides on its
    // doc transform would be missing too — this pins the cause, not just the symptom.
    expect(defaultEndpoints).toContain('manage-context')
    expect(saasEndpoints).toContain('manage-context')
  })
})
