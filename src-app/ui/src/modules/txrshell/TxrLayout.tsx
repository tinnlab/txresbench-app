import { Link, NavLink, Outlet } from 'react-router-dom'
import type { ReactNode } from 'react'

/**
 * TxrLayout — the TxResBench app shell per the design boards: a top header with
 * the brand + tagline, the top navigation (New analysis / Models / History /
 * Help), and the routed main area below. No sidebar, no login, no setup.
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
        background: '#ffffff',
        color: '#141414',
        fontFamily: "'Source Sans 3', system-ui, sans-serif",
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <header
        style={{
          height: 56,
          boxSizing: 'border-box',
          padding: '0 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid #cfcdc7',
          background: '#f7f6f3',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <Link
            to="/"
            style={{
              fontFamily: "'Source Serif 4', Georgia, serif",
              fontWeight: 600,
              fontSize: 22,
              color: '#141414',
              textDecoration: 'none',
            }}
          >
            TxResBench
          </Link>
          <span style={{ color: '#5e5e5e', fontSize: 13 }}>
            Treatment response from blood markers, on your computer
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <nav
            aria-label="Main"
            style={{ display: 'flex', gap: 4, fontSize: 14 }}
          >
            <NavLink
              to="/"
              end
              className="txr-nav-link"
              style={({ isActive }) => ({
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: isActive ? 700 : 400,
                textDecoration: 'none',
                background: isActive ? '#e8eef6' : 'transparent',
                color: isActive ? '#143a68' : '#3a3a3a',
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
                background: isActive ? '#e8eef6' : 'transparent',
                color: isActive ? '#143a68' : '#3a3a3a',
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
                background: isActive ? '#e8eef6' : 'transparent',
                color: isActive ? '#143a68' : '#3a3a3a',
              })}
            >
              History
            </NavLink>
          </nav>
          <Link
            to="/help"
            style={{ fontSize: 14, color: '#3a3a3a', textDecoration: 'none' }}
          >
            Help
          </Link>
        </div>
      </header>
      <main style={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>
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
