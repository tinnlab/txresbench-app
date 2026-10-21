import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Card, Layout, Title } from '@ziee/kit'
import { Loading } from '@ziee/shell'
import { Auth } from '@/modules/auth/Auth.store'
import { BlankLayoutComponent } from '@/modules/layouts/blank'
import { SESSION_RETURN_TO_KEY } from './constants'

const { Content } = Layout

/**
 * True when `target` is a safe same-origin path. Strict: must start
 * with a single `/`, not `//` (protocol-relative URL → open redirect),
 * no backslashes (Windows-style), no control characters, no embedded
 * scheme.
 */
function isSameOriginPath(target: string | null): boolean {
  if (!target) return false
  if (!target.startsWith('/')) return false
  if (target.startsWith('//')) return false
  if (/[\\\x00-\x1f]/.test(target)) return false
  return true
}

/**
 * /auth/callback — landing page after a successful OAuth dance.
 *
 * The backend redirects to `/auth/callback#token=<JWT>&return_to=<path>`.
 * The token is in the URL **fragment** (`#…`) so it's never sent in
 * Referer headers or written to server access logs. We:
 *   1. Read both fields from `location.hash`.
 *   2. Call `history.replaceState` to scrub them immediately —
 *      removes the token from URL bar, browser history, and any
 *      subsequent Referer.
 *   3. Hand the token to `Auth.store.setAuthFromAutoLogin`, then call
 *      `Auth.initAuth()` to fetch `/api/auth/me` and hydrate user +
 *      permissions.
 *   4. Navigate to `return_to` (URL > sessionStorage > "/").
 */
export const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  // Capture the URL fragment SYNCHRONOUSLY on first render before any
  // effect or router hook gets a chance to strip it. (Some router
  // setups normalize the URL between the initial DOM mount and the
  // first useEffect tick — observed in tests where the hash was gone
  // by the time the effect ran.)
  const [initial] = useState(() => {
    const raw = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    const params = new URLSearchParams(raw)
    const expiresInRaw = params.get('expires_in')
    const expiresIn = expiresInRaw ? Number.parseInt(expiresInRaw, 10) : NaN
    return {
      token: params.get('token'),
      // Access-token lifetime (seconds) — seeds the proactive silent
      // refresh. The refresh token itself never rides the URL: it was
      // set as an httpOnly cookie on the redirect response.
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined,
      returnTo: params.get('return_to'),
    }
  })

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const token = initial.token
      const returnToFromUrl = initial.returnTo

      // Scrub the fragment FIRST so even an immediate throw below
      // doesn't leave the token in the URL bar. (May already be
      // gone — see the useState initializer above.)
      try {
        window.history.replaceState({}, '', '/auth/callback')
      } catch {
        // ignore — older browsers / sandboxed iframes
      }
      // Belt-and-suspenders: even with the fragment scrubbed from the
      // URL bar, the original full URL (token + return_to) lives on
      // in the Performance API's navigation entry. Anything in the
      // page that introspects performance.getEntriesByType('navigation')
      // — analytics scripts, perf widgets — would see the token.
      // Clear it.
      try {
        performance.clearResourceTimings?.()
        // No standard API to clear navigation entries; setting the
        // URL via replaceState above is the strongest available
        // mitigation. This catch leaves intentionally as documentation
        // that we considered it.
      } catch {
        // ignore
      }

      if (!token) {
        setError('No authentication token in the callback URL.')
        return
      }

      // Hydrate the auth store + re-fetch profile.
      // user=null: server is the truth — initAuth() right below
      // re-fetches /me. The store keeps isAuthenticated=false until
      // /me resolves so consumers don't see a half-hydrated state.
      // refresh_token stays blank: it lives in the httpOnly cookie the
      // server set on the OAuth redirect (cookie mode).
      Auth.setAuthFromAutoLogin({
        user: null,
        access_token: token,
        refresh_token: '',
        expires_in: initial.expiresIn,
      })

      try {
        await Auth.initAuth()
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : 'Failed to load user profile',
          )
        }
        return
      }

      // Resolve the post-login destination. URL value wins; fall back
      // to sessionStorage (set on the LoginForm button click); fall
      // back to "/".
      let target = returnToFromUrl ?? null
      if (!target) {
        try {
          target = window.sessionStorage.getItem(SESSION_RETURN_TO_KEY)
        } catch {
          target = null
        }
      }
      try {
        window.sessionStorage.removeItem(SESSION_RETURN_TO_KEY)
      } catch {
        // ignore
      }

      if (!cancelled) {
        // SECURITY: re-validate return_to as a same-origin path
        // before navigating. The backend validated on the way IN to
        // /authorize, but the value round-trips through the OAuth
        // provider's URL and back here in our fragment — a tampered
        // provider response could deliver a protocol-relative URL
        // like `//evil.com/x` which react-router would happily
        // navigate to. Strict path-only allowlist.
        const safeTarget = isSameOriginPath(target) ? target! : '/'
        navigate(safeTarget, { replace: true })
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <BlankLayoutComponent>
      <Layout data-testid="auth-callback-layout" className="min-h-dvh">
        <Content data-testid="auth-callback-content" className="flex items-center justify-center p-4">
          <Card data-testid="auth-callback-card" className="w-full max-w-md text-center">
            {error ? (
              <>
                <Title level={4}>Sign-in failed</Title>
                <Alert data-testid="auth-callback-error" tone="error" title={error} className="my-3" />
                <Link to="/auth">Return to login</Link>
              </>
            ) : (
              <Loading description="Completing sign-in…" label="Completing sign-in" />
            )}
          </Card>
        </Content>
      </Layout>
    </BlankLayoutComponent>
  )
}
