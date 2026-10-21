// TEST-10 (#44) — the module gallery registers ≥1 seeded state, and every seeded
// state names a component + path (so the gate:ui crawl renders the populated list
// + members-drawer states for the design-critic vision pass).

import { describe, expect, it } from 'vitest'
import { gallery, seededAccounts, seededMembers } from './gallery'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('TEST-10 — admin-accounts gallery', () => {
  it('exports at least one seeded state', () => {
    expect(gallery.seeded && gallery.seeded.length).toBeGreaterThan(0)
  })

  it('every seeded state has a slug, path, and component', () => {
    for (const s of gallery.seeded ?? []) {
      expect(s.slug, 'slug').toBeTruthy()
      expect(s.path, `${s.slug} path`).toBeTruthy()
      expect(s.component, `${s.slug} component`).toBeTruthy()
    }
  })

  it('includes the populated-list and account-detail states (#57)', () => {
    const slugs = (gallery.seeded ?? []).map(s => s.slug)
    expect(slugs).toContain('accounts-admin-populated')
    // The members drawer is retired; the detail page (with the inline members
    // widget) is the reviewed surface now, in both saas and non-saas states.
    expect(slugs).toContain('account-detail-populated-saas')
    expect(slugs).toContain('account-detail-populated-nonsaas')
    expect(slugs).toContain('account-detail-loading')
    expect(slugs).toContain('account-detail-error')
  })
})

// TEST-10 [covers ITEM-11] (#51) — the gallery seeds REALISTIC identities so the
// populated vision pass reviews human-readable rows, not UUID mocks (the very gap
// that let the raw-id defect ship). Regression guard against reseeding UUIDs.
describe('TEST-10 — gallery seeds realistic member/owner identities', () => {
  it('every seeded member carries a non-empty, non-UUID username + email', () => {
    expect(seededMembers.length).toBeGreaterThan(0)
    for (const m of seededMembers) {
      expect(m.username, 'username').toBeTruthy()
      expect(m.username).not.toMatch(UUID_RE)
      expect(m.email, 'email').toMatch(/@/)
      // display_name, when present, is a human name (not a UUID).
      if (m.display_name) expect(m.display_name).not.toMatch(UUID_RE)
    }
  })

  it('at least one seeded member exercises the username fallback (no display_name)', () => {
    expect(seededMembers.some(m => !m.display_name)).toBe(true)
  })

  it('owner_label is a human name (not a UUID) wherever an owner exists', () => {
    const withOwner = seededAccounts.filter(a => a.owner_user_id)
    expect(withOwner.length).toBeGreaterThan(0)
    for (const a of withOwner) {
      expect(a.owner_label, 'owner_label present when owned').toBeTruthy()
      expect(a.owner_label as string).not.toMatch(UUID_RE)
    }
    // The orphan (no owner) has no label — mirrors the backend None-iff-None rule.
    const orphan = seededAccounts.find(a => !a.owner_user_id)
    expect(orphan?.owner_label ?? undefined).toBeUndefined()
  })
})
