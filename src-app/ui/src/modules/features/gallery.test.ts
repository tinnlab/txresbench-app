// @vitest-environment jsdom
// TEST-8 (#48) — the Feature Flags module gallery registers the populated, empty,
// loading, and error seeds (so the gate:ui crawl renders the POPULATED list for the
// design-critic + 390px review), and each seed names a slug/path/component and
// seeds the store without throwing.

import { describe, expect, it } from 'vitest'
import { gallery } from './gallery'

describe('TEST-8 — feature-flags gallery', () => {
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

  it('includes the populated, empty, loading and error states', () => {
    const slugs = (gallery.seeded ?? []).map(s => s.slug)
    expect(slugs).toContain('feature-flags-populated')
    expect(slugs).toContain('feature-flags-empty')
    expect(slugs).toContain('feature-flags-loading')
    expect(slugs).toContain('feature-flags-error')
  })

  // TEST-11 (#53) — the per-account section had a populated seed (a selected account
  // with mixed inherited + overridden rows). TxResBench strip: the per-account
  // overrides surface was removed with the account-management modules, so this seed
  // no longer exists.

  it('each seed setup runs without throwing', () => {
    for (const s of gallery.seeded ?? []) {
      expect(() => s.setup?.(), s.slug).not.toThrow()
    }
  })
})
