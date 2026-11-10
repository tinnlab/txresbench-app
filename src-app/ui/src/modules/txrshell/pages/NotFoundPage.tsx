import type { CSSProperties } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button } from '@ziee/kit'
import { useDocumentTitle } from '../lib/document-title'

/**
 * The global "page not found" screen (help-r2.md R2-G2) — the catch-all
 * route the shell now registers (`path: '*'`), so an unknown address or a
 * stale deep link shows a real not-found state instead of the SDK router's
 * silent redirect to `/` (a wrong URL looked like a working landing page).
 *
 * The shape is the app's own not-found idioms (the results screen's
 * "could not be found" block): one serif heading, one short sentence, one
 * way out — here "Back to the start" (the K/J results' "New analysis"
 * role), matching the boards' "what do you want to do" home. The attempted
 * address is named so a typo is visible and correctable; the path is the
 * browser's, never an app constant.
 */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '48px 32px 24px',
  display: 'flex',
  justifyContent: 'center',
  minWidth: 0,
}

const NOT_FOUND_BLOCK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 12,
  maxWidth: 520,
}

const NOT_FOUND_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 26,
  lineHeight: 1.3,
}

const NOT_FOUND_TEXT: CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: 'var(--txr-text-2)',
}

const NOT_FOUND_PATH: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 13,
  color: 'var(--txr-muted)',
  overflowWrap: 'anywhere',
}

export function NotFoundPage() {
  const { pathname } = useLocation()
  useDocumentTitle('Page not found')

  return (
    <main data-testid="txr-not-found" style={PAGE_MAIN}>
      <div style={NOT_FOUND_BLOCK}>
        <h1 style={NOT_FOUND_TITLE}>Page not found</h1>
        <p data-testid="txr-not-found-text" style={NOT_FOUND_TEXT}>
          There is no page at this address. The link may be wrong, the page may
          have moved, or the address may have a typo.
        </p>
        <p style={NOT_FOUND_PATH}>{pathname}</p>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Button
            data-testid="txr-not-found-home"
            variant="outline"
            className="rounded-lg font-semibold"
            style={{ padding: '9px 16px' }}
          >
            Back to the start
          </Button>
        </Link>
      </div>
    </main>
  )
}
