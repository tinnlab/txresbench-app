import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { CommandPalette } from './CommandPalette'
import { closeCommandPalette, openCommandPalette } from './paletteState'

/**
 * Gallery seed for the command palette overlay.
 *
 * The palette had no gallery surface at all, which is a real coverage gap: it is a first-class
 * overlay, and the gallery's whole job is to render every page and overlay across its states. It
 * was unreachable here for a structural reason rather than an oversight — the palette is mounted
 * by the `routerEffects` slot and opened by a global ⌘/Ctrl-K listener, neither of which the
 * gallery's page harness runs, so no amount of key-pressing on a page surface can summon it.
 *
 * The open state is seeded through the REAL module singleton (`openCommandPalette`), the same
 * entry point the keyboard listener and the sidebar tool use — not a prop override — so what
 * renders here is what ships.
 */
export const gallery: ModuleGallery = {
  overlays: [
    {
      slug: 'command-palette-open',
      surface: 'src/modules/command-palette/CommandPalette.tsx',
      title: 'Command palette — open, unfiltered',
      component: lazy(() => Promise.resolve({ default: CommandPalette })),
      open: () => {
        // Idempotent across a re-mount: the singleton survives React unmounts, and reopening an
        // already-open palette is a no-op that would leave a stale filter behind.
        closeCommandPalette()
        openCommandPalette()
      },
    },
  ],
}
