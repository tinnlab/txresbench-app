import { Link, NavLink, Outlet } from 'react-router-dom'
import type { ReactNode } from 'react'
import { TxrThemeToggle } from './TxrThemeToggle'

/**
 * TxrLayout — the TxResBench app shell per the design boards: a top header with
 * the brand + tagline, the top navigation (New analysis / Models / History /
 * Help) and the theme switch, and the routed main area below. No sidebar, no
 * login, no setup.
 *
 * The palette is the app's token layer (`assets/txr-theme.css`) — never a hex
 * literal — so the header follows the dark theme with the pages (RM-1, RES-25).
 * The responsive half (qa-fixes ITEM-7, X2; single-row byte: qa-fixes3 ITEM-6):
 * the board's header is ONE 56 px row. Under 900 px the tagline yields (the
 * longest, least-needed byte — the brand stays); under 640 px the row stays a
 * single row — the nav becomes a horizontally scrollable strip (index.css
 * against the `.txr-shell-*` hooks below; a media query cannot touch an
 * inline style) and the theme switch collapses to its icon (`.txr-theme-toggle-*`
 * hooks). The desktop look above the breakpoints is the byte this file
 * declares.
 *
 * The analysis screens themselves are a later build step; the routes registered
 * against this layout render their own content.
 */
export function TxrShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="txr-shell"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--txr-surface)',
        color: 'var(--txr-text)',
        fontFamily: "'Source Sans 3', system-ui, sans-serif",
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <header
        className="txr-shell-header"
        style={{
          height: 56,
          boxSizing: 'border-box',
          padding: '0 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderBottom: '1px solid var(--txr-border)',
          background: 'var(--txr-surface-dim)',
        }}
      >
        <div
          className="txr-shell-brand-group"
          style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0, flexShrink: 0 }}
        >
          <Link
            to="/"
            className="txr-shell-brand"
            style={{
              fontFamily: "'Source Serif 4', Georgia, serif",
              fontWeight: 600,
              fontSize: 22,
              color: 'var(--txr-text)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            TxResBench
          </Link>
          <span className="txr-shell-tagline" style={{ color: 'var(--txr-muted)', fontSize: 13 }}>
            Treatment response from blood markers
          </span>
        </div>
        <div
          className="txr-shell-actions"
          style={{ display: 'flex', alignItems: 'center', gap: 22 }}
        >
          <nav
            aria-label="Main"
            className="txr-shell-nav"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 14 }}
          >            <NavLink
              to="/"
              end
              className="txr-nav-link"
              style={({ isActive }) => ({
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: isActive ? 700 : 400,
                textDecoration: 'none',
                background: isActive ? 'var(--txr-accent-soft)' : 'transparent',
                color: isActive ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
              })}
            >
              New analysis
            </NavLink>
            <NavLink
              to="/models"
              className="txr-nav-link"
              style={({ isActive }) => ({
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: isActive ? 700 : 400,
                textDecoration: 'none',
                background: isActive ? 'var(--txr-accent-soft)' : 'transparent',
                color: isActive ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
                whiteSpace: 'nowrap',
              })}
            >
              Models
            </NavLink>
            <NavLink
              to="/history"
              className="txr-nav-link"
              style={({ isActive }) => ({
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: isActive ? 700 : 400,
                textDecoration: 'none',
                background: isActive ? 'var(--txr-accent-soft)' : 'transparent',
                color: isActive ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
                whiteSpace: 'nowrap',
              })}
            >
              History
            </NavLink>
            <NavLink
              to="/help"
              className="txr-nav-link"
              style={({ isActive }) => ({
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: isActive ? 700 : 400,
                textDecoration: 'none',
                background: isActive ? 'var(--txr-accent-soft)' : 'transparent',
                color: isActive ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
                whiteSpace: 'nowrap',
              })}
            >
              Help
            </NavLink>
          </nav>
          <TxrThemeToggle />
        </div>
      </header>
      {/* The routed area is a plain flex frame, NOT a second <main> (qa-fixes
          RES-09): every page owns its own main landmark (txrresults,
          txrhistory, txrmodels, txrrun, txrhelp, and the txrintake pages'
          role="main" containers) — the layout's main would nest two document
          landmarks per page. */}
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}

/** The layout component the router mounts per route group. */
export default function TxrLayout() {
  return (
    <TxrShell>
      <Outlet />
    </TxrShell>
  )
}
