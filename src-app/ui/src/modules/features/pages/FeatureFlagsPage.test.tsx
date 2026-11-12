// @vitest-environment jsdom
// TEST-10 (#48, fix-round-2 regression) — the Feature Flags page must NOT crash when
// the `registerLazyStore` proxy transiently yields UNDEFINED state fields before the
// store hydrates (the exact `gate:ui` runtime-health crash at FeatureFlagsPage.tsx:88,
// `flags.length` on undefined). With the destructuring defaults it renders the empty
// state; a populated proxy renders one row per flag with its effective badge.

import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FeatureFlagView } from '@/api-client/types'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

// `hasPermissionNow` is exported alongside `usePermission`; a lazy settings store's
// `init` → `loadSettings` calls it during mount, so an incomplete mock leaks an
// unhandled rejection (pre-existing; surfaced by any registered *Settings store).
vi.mock('@/core/permissions', () => ({ usePermission: () => true, hasPermissionNow: () => true }))
vi.mock('@txresbench/shell', () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
// ListPagination pulls kit Pagination (heavy in jsdom); not the subject here.
vi.mock('@/components/common/ListPagination', () => ({ ListPagination: () => null }))

// The store proxy — mutated per test to model hydration states, including the
// pre-hydration UNDEFINED-fields state that caused the crash.
const proxy: Record<string, unknown> = {}
vi.mock('@/modules/features/FeatureFlags.store', () => ({ FeatureFlags: proxy }))

const { FeatureFlagsPage } = await import('./FeatureFlagsPage')

afterEach(() => {
  cleanup()
  for (const k of Object.keys(proxy)) delete proxy[k]
})

describe('TEST-10 — FeatureFlagsPage render safety', () => {
  it('does NOT crash when the proxy yields undefined fields (pre-hydration); renders empty', () => {
    // Every field undefined — the transient proxy state the defaults must absorb.
    expect(() => render(<FeatureFlagsPage />)).not.toThrow()
    // The defaults make flags an [] → the empty state renders (no crash).
    expect(document.querySelector('[data-testid="feature-flags-empty"]')).not.toBeNull()
  })

  it('renders one row per flag with its effective badge when populated', () => {
    const flags: FeatureFlagView[] = [
      { flag_key: 'demo.runtime_flag', description: 'Demo.', default_enabled: false, effective: false },
      { flag_key: 'search.semantic', description: 'Search.', default_enabled: true, global_enabled: true, effective: true },
    ]
    Object.assign(proxy, { flags, loading: false, error: null, pending: {} })
    render(<FeatureFlagsPage />)
    expect(
      document.querySelector('[data-testid="feature-flag-row-demo.runtime_flag"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="feature-flag-effective-search.semantic"]')
        ?.textContent,
    ).toBe('On')
  })
})
