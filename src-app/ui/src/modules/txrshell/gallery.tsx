/**
 * txrshell dev-gallery surfaces (qa-fixes ITEM-7, X2; ITEM-6 (c)) — the shell
 * at the widths the QA report measured. The shell is the one surface a
 * page-story cannot show (the gallery frames mount the page component under
 * its own MemoryRouter, and the route `layout` is the app router's — not the
 * frame's), so the header's own narrow stories live here: the real TxrShell
 * around an empty routed area, at a width the spec passes (`?w=360|390|414|
 * 768`, default 390), so the gallery-e2e `txr-theme-phone.spec.ts` can
 * assert the bytes — no horizontal overflow, the tagline yielded, ONE header
 * row, every destination reachable (the strip scrolls to the focused link).
 *
 * DEV-ONLY: picked up by the dev gallery's `import.meta.glob`, never in a
 * production bundle path.
 */
import { lazy, type ReactNode } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { TxrShell } from './TxrLayout'

/** One narrow frame (the spec's `?w=` query, the QA report's 390 default). */
function NarrowShell({ children }: { children: ReactNode }) {
  const w = Number(new URLSearchParams(window.location.search).get('w')) || 390
  return (
    <section
      data-testid="txr-shell-narrow"
      style={{ width: w, maxWidth: '100%', minWidth: 0, border: '0' }}
    >
      {children}
    </section>
  )
}

const NarrowShellStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <NarrowShell>
        <TxrShell>
          <div style={{ padding: '24px 16px' }} />
        </TxrShell>
      </NarrowShell>
    ),
  }),
)

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'txr-shell-narrow-390',
      title: 'The shell header at narrow width',
      note: 'The narrow-byte: the tagline yields under 900 px, the header stays ONE 56 px row at every width — the nav becomes a scrollable strip under 640 px — and all four destinations (New analysis / Models / History / Help) stay reachable, no horizontal page overflow.',
      path: '*',
      initialPath: '/',
      component: NarrowShellStory,
      fullHeight: true,
    },
  ],
}
