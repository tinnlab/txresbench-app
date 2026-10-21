import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Button } from '@ziee/kit'
import { Session } from '@/modules/session/Session.store'

/**
 * SessionGuard — the single gate between the browser and every protected route.
 *
 * TxResBench has no login screen: the guard only waits for the local session
 * mint + `/me` (see Session.store). Until then a centering spinner; on failure a
 * direct, actionable message (the server is a local process — the failure is
 * almost always "the app's server is not running").
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const { ready, error } = Session

  // Backstop kick: `session/module.tsx::initialize` starts the mint, but a route
  // that mounts without a module-initialize (remounts, deep links) must still
  // gate on a started session. Idempotent in the store.
  useEffect(() => {
    void Session.initSession()
  }, [])

  if (error) {
    return (
      <div
        data-testid="session-error"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100dvh',
          gap: 12,
          padding: 24,
          fontFamily: 'inherit',
          textAlign: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>TxResBench could not start</h1>
        <p data-allow-custom-color style={{ margin: 0, color: '#666', maxWidth: 520 }}>
          The app's local service did not answer. Start it and reload this page.
        </p>
        <pre
          data-allow-custom-color
          style={{
            margin: 0,
            padding: 12,
            background: '#f5f5f5',
            border: '1px solid #ddd',
            borderRadius: 4,
            fontSize: 12,
            maxWidth: 640,
            overflow: 'auto',
          }}
        >
          {error}
        </pre>
        <Button
          data-testid="session-retry"
          onClick={() => {
            Session.clearError()
            void Session.initSession()
          }}
        >
          Try again
        </Button>
      </div>
    )
  }

  if (!ready) {
    return (
      <div
        data-testid="session-loading"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100dvh',
        }}
      >
        <span aria-label="Loading" style={{ fontSize: 13, color: '#5e5e5e' }}>
          Loading…
        </span>
      </div>
    )
  }

  return <>{children}</>
}
