import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Button } from '@txresbench/kit'
import { Session } from '@/modules/session/Session.store'

/**
 * SessionGuard — the single gate between the browser and every protected route.
 *
 * TxResBench has no login screen: the guard only waits for the local session
 * mint + `/me` (see Session.store). While the mint runs the page says what
 * it is doing ("Starting the app…", and the still-trying line once the mint
 * is slow — R3-intake-8: a failing or slow `POST /api/session/local` must
 * never leave a bare "Loading…" the user cannot act on); the store retries
 * the mint automatically (3 tries, backoff) and after the last try the
 * guard shows "We could not start the app" with the plain reason and a
 * Retry button.
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const { ready, error, minting, slow } = Session

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
        <h1 style={{ margin: 0, fontSize: 22 }}>We could not start the app</h1>
        <p data-allow-custom-color style={{ margin: 0, color: 'var(--txr-text-2)', maxWidth: 520 }}>
          The app did not answer after 3 tries. The reason:
        </p>
        <pre
          data-allow-custom-color
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--txr-surface-dim)',
            border: '1px solid var(--txr-border)',
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
          Retry
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
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100dvh',
          gap: 8,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <span aria-label="Loading" style={{ fontSize: 13, color: 'var(--txr-muted)' }}>
          {minting ? 'Starting the app…' : 'Loading…'}
        </span>
        {slow ? (
          <span
            data-testid="session-slow"
            style={{ fontSize: 12.5, color: 'var(--txr-muted)' }}
          >
            This is taking longer than usual. Still trying.
          </span>
        ) : null}
      </div>
    )
  }

  return <>{children}</>
}
