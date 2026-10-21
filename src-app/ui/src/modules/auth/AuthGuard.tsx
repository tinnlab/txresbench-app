import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Auth } from '@/modules/auth/Auth.store'
import { App } from '@/modules/app/App.store'
import { AppMode } from '@/modules/app/AppMode.store'
import { AuthPage } from '@/modules/auth/AuthPage'
import { Loading } from '@ziee/shell'

interface AuthGuardProps {
  children: React.ReactNode
}

export const AuthGuard: React.FC<AuthGuardProps> = ({ children }) => {
  const { isAuthenticated, isInitializing } = Auth
  const { needsSetup } = App
  const { multiUserMode } = AppMode
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    // Desktop (single-admin) skips initAuth: the desktop-base module's
    // auto-login retry loop is the single source of truth for the token.
    // Any persisted token from a previous launch is stale because the
    // desktop server regenerates its JWT secret per launch.
    if (multiUserMode) {
      Auth.initAuth()
    }
  }, [multiUserMode])

  useEffect(() => {
    // Desktop never redirects to /setup; setup is handled before webview creation.
    if (!multiUserMode) return
    if (needsSetup === true && location.pathname !== '/setup') {
      navigate('/setup', { replace: true })
    }
  }, [needsSetup, navigate, location.pathname, multiUserMode])

  // Desktop: show loading spinner while auto-login is in progress;
  // never render the multi-user AuthPage (desktop users don't know
  // the hardcoded password).
  if (!multiUserMode) {
    if (!isAuthenticated) {
      return <Loading fullscreen />
    }
    return <>{children}</>
  }

  // Show loading spinner while checking auth status
  if (isInitializing || needsSetup === null) {
    return <Loading fullscreen />
  }

  // Redirect to setup if needed
  if (needsSetup) {
    navigate('/setup', { replace: true })
    return null
  }

  // Show authentication page if not authenticated
  if (!isAuthenticated) {
    return <AuthPage />
  }

  // Show the protected content. Post-auth redirects (onboarding,
  // etc.) are owned by the contributing module — see the
  // `routerEffects` slot consumed by RouterComponent.
  return <>{children}</>
}
