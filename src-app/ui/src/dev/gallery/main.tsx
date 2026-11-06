// CytoAnalyst component gallery — boots @ziee/gallery with this app's DI surface.
// Dev-only: reachable ONLY from gallery.html (a separate Vite entry never
// imported by the app's main.tsx), so it tree-shakes out of the prod bundle.

import {
  mountGallery,
  moduleNameFromPath,
  type DiscoveredGallery,
  type ModuleGallery,
  type SpecialRoute,
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
// A module may also ship byte/error mock routes (`txrMockRoutes` — the txrresults
// module answers its SSE stream and CSV download, which the JSON cassette cannot
// express); they are gathered here and passed to `mountGallery({ specialRoutes })`.
const moduleGalleries = import.meta.glob<{
  gallery?: ModuleGallery
  txrMockRoutes?: Array<{ route: SpecialRoute }>
}>('../../modules/**/gallery.{ts,tsx}', { eager: true })

// `specialRoutes` are tried in order (mockApi.ts's first-match contract), so an
// id-scoped route must be registered BEFORE a path-family route that would also
// match the request. The glob keys are sorted alphabetically and `txrresults`
// (a path-family stream route) sorts before `txrrun` (a stream route scoped to
// its own fixture run ids) — so the gathered order is the REVERSE module order:
// the newest module's id-scoped routes are tried first, and a route that does
// not own the request falls through to the earlier modules', unchanged.
const routeOrder = Object.entries(moduleGalleries).sort(([a], [b]) => b.localeCompare(a))

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
  specialRoutes: routeOrder.flatMap(([, m]) => m.txrMockRoutes?.flatMap(e => e.route) ?? []),

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
