import { Button, ErrorState, Separator, Spin, Text } from '@ziee/kit'
import { Apple as AppleIcon, Globe, LogIn, Monitor } from 'lucide-react'
import { AuthProviders } from '@/modules/auth/AuthProviders.store'
import type { PublicProvider } from '@/api-client/types'
import { SESSION_RETURN_TO_KEY } from './constants'

/**
 * Per-provider icon. AntD icons stand in for the official Google /
 * Apple / Microsoft marks — they're recognizable and ship with the
 * design system. If brand-compliance ever matters (Apple's HIG +
 * Google's branding guidelines are strict for native apps; web is
 * looser), swap these for official SVGs.
 */
function iconFor(p: PublicProvider) {
  const t = p.provider_type.toLowerCase()
  const n = p.name.toLowerCase()
  if (t === 'apple' || n.includes('apple')) return <AppleIcon />
  if (n.includes('google')) return <Globe />
  if (n.includes('microsoft') || n.includes('entra') || n.includes('azure')) {
    return <Monitor />
  }
  return <LogIn />
}

/**
 * Renders the row of "Sign in with X" buttons below the
 * username/password form. Pulls the enabled-provider list from the
 * backend on mount. Clicking a button:
 *   1. stashes the current path in sessionStorage so the SPA's
 *      `/auth/callback` page can navigate back to it
 *   2. does a full-page navigation to `/api/auth/oauth/<name>/authorize`
 *      — OAuth flows are full redirects, not fetches
 *
 * If no providers are enabled, renders nothing — the username /
 * password form is the only login option.
 */
export const ProviderButtons: React.FC<{ returnTo?: string }> = ({ returnTo }) => {
  // Store auto-loads via __init__; we just consume. Use BOTH
  // `isLoading` and `hasLoaded` so a future loadProviders() call
  // from outside __init__ also shows the spinner.
  const { providers, error, isLoading, hasLoaded } = AuthProviders

  if (isLoading || !hasLoaded) {
    return (
      <div className="text-center py-2">
        <Spin size="sm" label="Loading sign-in options" />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        data-testid="auth-providers-error"
        resource="sign-in options"
        description="We couldn't load the external sign-in options. You can still sign in with your username and password."
        details={error}
        onRetry={() => AuthProviders.loadProviders()}
        className="my-2"
      />
    )
  }

  if (!providers || providers.length === 0) return null

  const onClick = (name: string) => {
    const target = returnTo ?? window.location.pathname + window.location.search
    try {
      window.sessionStorage.setItem(SESSION_RETURN_TO_KEY, target)
    } catch {
      // Safari private mode or storage-disabled — fall back to `/`
      // after auth completes.
    }
    // Full-page navigation — OAuth is a top-level redirect, not fetch.
    window.location.href = `/api/auth/oauth/${encodeURIComponent(name)}/authorize?return_to=${encodeURIComponent(target)}`
  }

  return (
    <div className="space-y-3">
      <Separator>
        <Text type="secondary" className="text-xs">
          or continue with
        </Text>
      </Separator>
      <div className="space-y-2">
        {providers.map(p => (
          <Button
            key={p.name}
            data-testid={`auth-provider-btn-${p.name}`}
            block
            size="lg"
            icon={iconFor(p)}
            onClick={() => onClick(p.name)}
          >
            {p.display_name}
          </Button>
        ))}
      </div>
    </div>
  )
}
