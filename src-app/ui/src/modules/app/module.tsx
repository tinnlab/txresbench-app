import { createModule } from '@ziee/framework'
import { App } from '@/modules/app/App.store'
import '@/modules/app/AppMode.store'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

const SetupPage = lazyWithPreload(() => import('./SetupPage'))

/**
 * SetupRedirect — routes to /setup when the app needs first-time admin
 * setup. Mounted inside <BrowserRouter> via the `routerEffects` slot so
 * it can use `useNavigate` but renders nothing.
 */
function SetupRedirect() {
  const needsSetup = App.needsSetup
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (needsSetup && location.pathname !== '/setup') {
      navigate('/setup', { replace: true })
    }
  }, [needsSetup, navigate, location.pathname])

  return null
}

export default createModule({
  metadata: {
    name: 'app',
    version: '1.0.0',
    description: 'Application-level module',
  },
  routes: [
    {
      // No `layout:` — SetupPage renders its own AuthScreenLayout (shared with
      // the login page), which supplies the `main` landmark + meta-theme-color +
      // themed backdrop. A router BlankLayout here would double the `main`
      // landmark and race two meta-theme-color hooks.
      path: '/setup',
      element: SetupPage,
      requiresAuth: false,
    },
  ],
  // `App` + `AppMode` are WHOLE-STORE-LAZY (`registerLazyStore` in their own
  // files) — but BOOT-EAGER in practice: `initialize` below drives
  // `App.checkSetupStatus()`, and the desktop bootstrap flips `AppMode` before
  // any component mounts, so the side-effect import above keeps AppMode
  // registered. Listing them here would only build a second proxy.
  stores: [],
  slots: {
    routerEffects: [
      {
        id: 'app-setup-redirect',
        component: SetupRedirect,
      },
    ],
  },
  initialize: async () => {
    // Check setup status on app initialization
    await App.checkSetupStatus()
    if (App.$.needsSetup) {
      console.log('Application needs setup')
    } else {
      console.log('Application is already set up')
    }
    console.log('App module initialized')
  },
})
