/**
 * txrhelp dev-gallery surfaces (qa-fixes2 ITEM-3 redesign) — the Help content page's
 * render states, mounted over the REAL `HelpPage` (no cassette: the page
 * reads no provider; its content is the module's own typed data; the
 * template/copy buttons need the real backend and are present but inert in
 * the gallery — the layout is what this tier measures).
 *
 * - `txr-help` — the full page at the desktop width: the quick start row,
 *   the search box, the rail + every section + the closed problem-code
 *   accordion.
 * - `txr-help-narrow-390` — the board's mobile width: the rail is the
 *   "Contents" disclosure, the stepper and the quick-start cards stack, the
 *   tables scroll inside their own pane, nothing overflows.
 *
 * The gallery host's `theme=light|dark` query (`?surface=txr-help&theme=…`)
 * drives the token theme the page reads, so one spec checks both themes
 * through the same story (the theme-switch spec convention).
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, type CSSProperties } from 'react'
import { Route, Routes } from 'react-router-dom'
import type { ModuleGallery } from '@ziee/gallery'
import { AppShell } from '@/modules/txrshell/components/AppShell'
import { HelpPage } from './pages/HelpPage'

/** The bounded white pane look (the gallery's frame idiom). */
const FRAME: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'txr-help',
      title: 'Help — the full page',
      note: 'The Help content page: the quick-start row (the same three ways as the Start screen), the search box, the sticky on-this-page rail, the four-step cards, the per-file column tables, the status vocabulary, the callouts, and the troubleshooting accordion with one entry per closed validator code. Renders in light and dark (the host theme query) and at phone width (the narrow story; the tables scroll inside their own pane).',
      path: '/*',
      initialPath: '/help',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <div style={FRAME}>
              <Routes>
                <Route path="/help" element={<HelpPage />} />
                <Route path="*" element={null} />
              </Routes>
            </div>
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-help-narrow-390',
      title: 'Help — 390 px',
      note: 'The same page inside the board\'s mobile width: the rail becomes a "Contents" disclosure, the stepper and the quick-start cards stack, the tables scroll within the pane, no horizontal page overflow.',
      path: '/*',
      initialPath: '/help',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <div style={{ width: 390, maxWidth: '100%' }}>
              <div style={{ ...FRAME, width: 390, maxWidth: '100%' }}>
                <Routes>
                  <Route path="/help" element={<HelpPage />} />
                  <Route path="*" element={null} />
                </Routes>
              </div>
            </div>
          ),
        }),
      ),
      fullHeight: true,
    },
    {
      slug: 'txr-shell-route-help',
      title: 'Help inside the shell',
      note: 'The app-shell ITEM-3 route byte: the title + purpose + search fixed, the whole article (quick-start row + the rail/content grid) in the ONE region — the rail sticks at the region\'s top without scrolling itself, the spy follows the region, the anchors land flush at its top (scroll-margin 0 in shell mode) and the print byte prints the full article. The audit section-4 legs (test: `txr-shell-routes.spec.ts`).',
      path: '/*',
      initialPath: '/help',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <AppShell>
              <Routes>
                <Route path="/help" element={<HelpPage />} />
                <Route path="*" element={null} />
              </Routes>
            </AppShell>
          ),
        }),
      ),
    },
  ],
}
