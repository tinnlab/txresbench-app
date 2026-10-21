// TEST-17 [covers ITEM-17] — the billing gallery registers seeded states for the
// design-critic vision pass, with REALISTIC data (human reasons, cents amounts, a
// ledger that includes revoked + expired grants) — not UUID mocks.

import { describe, expect, it } from 'vitest'
import { gallery, seededGrants } from './gallery'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('TEST-17 — billing gallery', () => {
  it('exports seeded states, each with a slug, path, and component', () => {
    expect((gallery.seeded ?? []).length).toBeGreaterThan(0)
    for (const s of gallery.seeded ?? []) {
      expect(s.slug, 'slug').toBeTruthy()
      expect(s.path, `${s.slug} path`).toBeTruthy()
      expect(s.component, `${s.slug} component`).toBeTruthy()
    }
  })

  it('covers the populated + error states across all three billing widgets (#57 Views)', () => {
    const slugs = (gallery.seeded ?? []).map(s => s.slug)
    expect(slugs).toContain('billing-subscription-populated')
    expect(slugs).toContain('billing-subscription-suspended-override')
    expect(slugs).toContain('billing-subscription-error')
    expect(slugs).toContain('billing-usage-populated')
    expect(slugs).toContain('billing-usage-error')
    expect(slugs).toContain('billing-credits-populated')
    expect(slugs).toContain('billing-credits-premium')
  })

  it('seeds a realistic ledger: cents amounts, human reasons, and revoked + expired grants', () => {
    expect(seededGrants.length).toBeGreaterThanOrEqual(3)
    for (const g of seededGrants) {
      expect(Number.isInteger(g.amount_cents)).toBe(true)
      expect(g.amount_cents).toBeGreaterThan(0)
      expect(g.reason).toBeTruthy()
      expect(g.reason).not.toMatch(UUID_RE) // a human reason, not a UUID mock
    }
    // INV-4: the ledger retains a revoked grant and an expired grant.
    expect(seededGrants.some(g => g.revoked_at)).toBe(true)
    expect(seededGrants.some(g => !g.revoked_at && !g.active && g.expires_at)).toBe(true)
    expect(seededGrants.some(g => g.active)).toBe(true)
  })
})
