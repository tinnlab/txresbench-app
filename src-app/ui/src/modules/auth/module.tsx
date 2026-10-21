import { TimerReset } from 'lucide-react'
import { Permissions } from '@/api-client/permissions'
import { createModule } from '@ziee/framework'
// Side-effect import: `Auth.store` self-registers via `registerLazyStore` AND
// sets the SDK permission seam at module scope, so it must be evaluated before
// any permission hook renders. `AuthProviders` is pulled in by AuthPage.
import '@/modules/auth/Auth.store'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: registers `auth.updateSessionSettings` (#49) so the session-settings
// save is drivable by the palette + AI, not only the inline form save.
import '@/core/actions/builtin/sessionSettingsActions'
// Import via the `@/` alias (NOT a relative './AuthGuard') so the desktop
// build's vite-plugin-local-override can redirect this to the desktop
// AuthGuard override (the plugin only rewrites `@/`-prefixed specifiers;
// a relative import would always bind core's AuthGuard, even on desktop —
// bypassing the deliberate desktop divergence). Resolves to core's
// AuthGuard.tsx on the web build.
import { AuthGuard } from '@/modules/auth/AuthGuard'
// Import via the `@/` alias for the same reason as AuthGuard above: if/when a desktop
// override mechanism lands, this is the module that must get a no-op twin (see its header).
import { bootSessionVerify } from '@/modules/auth/bootSessionVerify'

const AuthPage = lazyWithPreload(() =>
  import('./AuthPage').then(m => ({ default: m.AuthPage })),
)
const AuthCallbackPage = lazyWithPreload(() =>
  import('./AuthCallbackPage').then(m => ({ default: m.AuthCallbackPage })),
)
const LinkAccountPage = lazyWithPreload(() =>
  import('./LinkAccountPage').then(m => ({ default: m.LinkAccountPage })),
)
const SessionSettingsPage = lazyWithPreload(() =>
  import('./SessionSettingsPage').then(m => ({
    default: m.SessionSettingsPage,
  })),
)

export default createModule({
  metadata: {
    name: 'auth',
    version: '1.0.0',
    description:
      'Authentication module with login, registration, and social sign-in',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/auth',
      element: AuthPage,
    },
    {
      path: '/auth/callback',
      element: AuthCallbackPage,
    },
    {
      path: '/auth/link-account',
      element: LinkAccountPage,
    },
    {
      path: '/settings/sessions',
      element: SessionSettingsPage,
      requiresAuth: true,
      permission: Permissions.SessionSettingsRead,
      layout: SettingsLayoutDef,
    },
  ],
  // Both auth stores are WHOLE-STORE-LAZY (`registerLazyStore` in their own
  // files). Listing them here would build nothing new — the proxies already
  // self-registered — and would re-add an eager module.tsx -> store import.
  stores: [],
  // Fill the router-owned `routeGuards` slot so the router gates protected
  // routes without importing anything from auth (inverts router→auth).
  slots: {
    routeGuards: [{ id: 'auth-guard', component: AuthGuard }],
    settingsAdminPages: [
      {
        id: 'sessions',
        icon: <TimerReset />,
        label: 'Sessions',
        path: 'sessions',
        order: 29,
        permission: Permissions.SessionSettingsRead,
      },
    ],
  },
  initialize: () => {
    // Start the session verification NOW, in parallel with the app module's
    // `/api/app/setup/status`, instead of waiting for AuthGuard to mount inside the
    // router tree behind a full-screen spinner. `initAuth()` is self-guarded, so
    // AuthGuard's own call collapses into this one. See bootSessionVerify.ts.
    bootSessionVerify()
  },
})
