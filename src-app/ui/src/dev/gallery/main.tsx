// CytoAnalyst component gallery — boots @ziee/gallery with this app's DI surface.
// Dev-only: reachable ONLY from gallery.html (a separate Vite entry never
// imported by the app's main.tsx), so it tree-shakes out of the prod bundle.

import {
  mountGallery,
  moduleNameFromPath,
  type DiscoveredGallery,
  type ModuleGallery,
} from '@ziee/gallery'
import {
  ACCENT_ORDER,
  ACCENT_PRESETS,
  AppErrorBoundary,
  DEFAULT_ACCENT,
  LazyComponentRenderer,
  Loading,
  ThemeProvider,
} from '@ziee/shell'
import { useRoutesStore } from '@ziee/framework/router'
import { ApiEndpoints } from '@/api-client/apiEndpoints'
import { loadModules } from '@/modules/loader'
import { useConfigClientStore } from '@/modules/config-client/ConfigClient.store'
import { galleryCassette, seedAuth } from './fixtures/cassette'
import '@/index.css'

// Per-module `gallery.tsx` surfaces (overlays / seeded / cassettes). None yet —
// pages are auto-enumerated from the router store. `import.meta.glob` MUST live
// in the app (Vite-only), which is why the gallery injects `discoverGalleries`.
const moduleGalleries = import.meta.glob<{ gallery?: ModuleGallery }>(
  '../../modules/**/gallery.{ts,tsx}',
  { eager: true },
)

mountGallery({
  discoverGalleries: (): DiscoveredGallery[] =>
    Object.entries(moduleGalleries)
      .filter(([, m]) => Boolean(m.gallery))
      .map(([path, m]) => ({
        module: moduleNameFromPath(path),
        gallery: m.gallery!,
      })),

  apiEndpoints: ApiEndpoints as unknown as Record<string, string>,
  crawlCassette: galleryCassette,

  loadModules,
  seedAuth,
  useRoutesStore,
  ThemeProvider,
  ErrorBoundary: AppErrorBoundary,
  Loading,
  LazyComponentRenderer,

  accents: ACCENT_ORDER,
  accentLabels: Object.fromEntries(
    ACCENT_ORDER.map(k => [k, ACCENT_PRESETS[k].label]),
  ),
  defaultAccent: DEFAULT_ACCENT,
  setThemePref: t => useConfigClientStore.getState().setThemePreference(t),
  setAccentPref: a =>
    useConfigClientStore.getState().setAccentPreset(a as never),
})
