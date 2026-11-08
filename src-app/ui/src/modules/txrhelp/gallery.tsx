/**
 * txrhelp dev-gallery surfaces (ITEM-4) — the Help content page's render
 * states, mounted over the REAL `HelpPage` (no cassette: the page reads no
 * provider; its content is the module's own typed data).
 *
 * - `txr-help` — the full page at the desktop width: the TOC + every
 *   section + the closed problem-code entries.
 * - `txr-help-narrow-390` — the board's mobile width: the TOC and the
 *   tables wrap, nothing overflows.
 *
 * The gallery host's `theme=light|dark` query (`?surface=txr-help&theme=…`)
 * drives the token theme the page reads, so one spec checks both themes
 * through the same story (the command-palette spec convention).
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, type CSSProperties } from 'react'
import { Route, Routes } from 'react-router-dom'
import type { ModuleGallery } from '@ziee/gallery'
import { HelpPage } from './pages/HelpPage'

/** The bounded white pane look (the gallery's frame idiom). */
const FRAME: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--background)',
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'txr-help',
      title: 'Help — the full page',
      note: 'The Help content page: the on-this-page table of contents, every section (what the app does, the four steps, preparing your files, choosing methods, reading results, saved and pretrained models, run history, privacy, where your data lives) and the troubleshooting list with one entry per closed validator code. Renders in light and dark (the host theme query) and at phone width (the narrow story; the tables scroll inside their own pane).',
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
      note: 'The same page inside the board\'s mobile width: the table of contents stacks above the sections, the tables scroll within the pane, no horizontal page overflow.',
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
  ],
}
