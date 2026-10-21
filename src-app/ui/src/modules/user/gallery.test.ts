// TEST-8 [covers ITEM-8] — the user gallery registers seeded states for the
// design-critic vision pass with REALISTIC data (human names/emails, dollar-from-cents
// balances, premium on/off, and a no-personal-account user) — never UUID mocks as
// identity.

import { describe, expect, it } from 'vitest'
import { gallery, seededUsers } from './gallery'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('TEST-8 — user gallery', () => {
  it('exports seeded states, each with a slug, path, and component', () => {
    expect((gallery.seeded ?? []).length).toBeGreaterThan(0)
    for (const s of gallery.seeded ?? []) {
      expect(s.slug, 'slug').toBeTruthy()
      expect(s.path, `${s.slug} path`).toBeTruthy()
      expect(s.component, `${s.slug} component`).toBeTruthy()
    }
  })

  it('covers populated + empty + error + grant-drawer states', () => {
    const slugs = (gallery.seeded ?? []).map(s => s.slug)
    expect(slugs).toContain('users-populated')
    expect(slugs).toContain('users-grant-credit-drawer')
    expect(slugs).toContain('users-empty')
    expect(slugs).toContain('users-error')
  })

  it('seeds realistic users: human names/emails, premium on AND off, and a no-account user', () => {
    expect(seededUsers.length).toBeGreaterThanOrEqual(3)
    for (const u of seededUsers) {
      expect(u.display_name, 'a human display_name').toBeTruthy()
      expect(u.display_name).not.toMatch(UUID_RE) // never a UUID as identity (INV-3)
      expect(u.email).toMatch(/@/)
    }
    // premium on AND off both represented.
    expect(seededUsers.some(u => u.billing?.premium === true)).toBe(true)
    expect(seededUsers.some(u => u.billing?.premium === false)).toBe(true)
    // a user with NO personal account → the "—" state.
    expect(seededUsers.some(u => !u.personal_account_id && !u.billing)).toBe(true)
    // balances are integer cents (rendered as dollars by the column, INV-4).
    for (const u of seededUsers) {
      if (u.billing) expect(Number.isInteger(u.billing.credit_balance_cents)).toBe(true)
    }
  })
})
