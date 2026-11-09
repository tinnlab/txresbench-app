/**
 * txrshell dev-gallery surfaces (qa-fixes ITEM-7, X2) — the shell at the
 * widths the QA report measured. The shell is the one surface a page-story
 * cannot show (the gallery frames mount the page component under its own
 * MemoryRouter, and the route `layout` is the app router's — not the frame's),
 * so the header's own 390 px story lives here: the real TxrShell around an
 * empty routed area, at the board's mobile width, so the gallery-e2e
 * `txr-theme-phone.spec.ts` can assert the X2 byte — no horizontal overflow,
 * the tagline yielded, all four destinations on-screen.
 *
 * DEV-ONLY: picked up by the dev gallery's `import.meta.glob`, never in a
 * production bundle path.
 */
import { lazy, type ReactNode } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { TxrShell } from './TxrLayout'

/** One 390 px frame (the QA report's phone width). */
function NarrowShell({ children }: { children: ReactNode }) {
  return (
    <section
      data-testid="txr-shell-narrow"
      style={{ width: 390, maxWidth: '100%', minWidth: 0, border: '0' }}
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
      title: 'The shell header at 390 px',
      note: 'The X2 byte: the tagline yields under 900 px, the header stacks into two rows under 640 px and all four destinations (New analysis / Models / History / Help) stay on-screen — no horizontal overflow.',
      path: '*',
      initialPath: '/',
      component: NarrowShellStory,
      fullHeight: true,
    },
  ],
}
