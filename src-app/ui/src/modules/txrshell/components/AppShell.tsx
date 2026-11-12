import { useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarTrigger } from '@ziee/kit'
import { FiMenu } from 'react-icons/fi'
import { TxrThemeToggle } from '../TxrThemeToggle'
import { shellModeClass, useShellMode } from '../lib/shellMode'

/**
 * txrshell — AppShell (app-shell ITEM-1, DEC-1/DEC-2).
 *
 * The desktop-double-click shell: a fixed 56 px header bar and a routed
 * area that fills the viewport. TWO modes by window size (the audit doc,
 * section 2): SHELL mode from 768×520 (the desktop window is always in
 * it — the document never scrolls; the pages scroll inside their own
 * regions) and FLOW mode below (normal document scrolling with a sticky
 * header, the phone/web-demo byte). The mode is ONE media query
 * (`lib/shellMode.ts`): the hook follows it for the layout, and the same
 * expression drives the document rules in index.css against the
 * `txr-shell-mode-*` class this shell puts on <html>.
 *
 * Header bytes (the boards): brand + tagline left, the four destinations
 * right, then the theme switch. ONE row at every width (qa-fixes3
 * ITEM-6): below 700 px the nav collapses into a menu button (keyboard:
 * Base UI menu — arrows, Escape, focus return; screen-reader: menubar/
 * menu/menuitem roles) and the theme switch is an icon-only button whose
 * accessible name carries the visible state text. A skip link is the
 * first tab stop (it targets the routed area), so the shell is
 * keyboard-complete before the first content element.
 *
 * The routed area is a plain div — never a `<main>` (RES-09): every page
 * owns its own main landmark; the shell's div is the skip-link target.
 */
export interface AppShellProps {
  children: ReactNode
}

/** The four destinations (the single list both the row and the menu render). */
export const SHELL_NAV_ITEMS = [
  { to: '/', label: 'New analysis', end: true },
  { to: '/models', label: 'Models', end: false },
  { to: '/history', label: 'History', end: false },
  { to: '/help', label: 'Help', end: false },
] as const

export function AppShell({ children }: AppShellProps) {
  const mode = useShellMode()

  // The document rules follow the shell: the `txr-shell-mode-*` class on
  // <html> (index.css) makes the document fixed in shell mode and leaves it
  // scrolling in flow mode. The class leaves with the shell, so non-shell
  // routes (the settings screens) keep their own document behaviour.
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.remove('txr-shell-mode-shell', 'txr-shell-mode-flow')
    root.classList.add(shellModeClass(mode))
    return () => {
      root.classList.remove('txr-shell-mode-shell', 'txr-shell-mode-flow')
    }
  }, [mode])

  const navLinkStyle = ({ isActive }: { isActive: boolean }) => ({
    padding: '6px 14px',
    borderRadius: 6,
    fontWeight: isActive ? 700 : 400,
    textDecoration: 'none',
    background: isActive ? 'var(--txr-accent-soft)' : 'transparent',
    color: isActive ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
    whiteSpace: 'nowrap' as const,
  })

  return (
    <div
      className={`txr-shell txr-app-shell txr-app-shell-${mode}`}
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
      {/* The skip link is the FIRST tab stop (before the brand): a keyboard
          user never tabs through the header's controls to reach content. */}
      <a
        className="txr-shell-skip-link"
        href="#txr-main"
        data-testid="txr-shell-skip-link"
      >
        Skip to content
      </a>
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
          flex: 'none',
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
          <nav aria-label="Main" className="txr-shell-nav" style={{ display: 'flex', gap: 4, fontSize: 14 }}>
            {SHELL_NAV_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className="txr-nav-link"
                style={navLinkStyle}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          {/* The narrow byte (below 700 px): the nav row yields to a menu
              button — one click, the four destinations, complete keyboard
              (Base UI menu) and screen-reader semantics. CSS shows one and
              hides the other (a media query cannot touch an inline style). */}
          <Menubar className="txr-shell-nav-menu">
            <MenubarMenu>
              <MenubarTrigger
                data-testid="txr-shell-nav-menu-trigger"
                className="txr-shell-nav-menu-trigger"
              >
                <FiMenu aria-hidden />
                Menu
              </MenubarTrigger>
              <MenubarContent className="txr-shell-nav-menu-content">
                {SHELL_NAV_ITEMS.map(item => (
                  <MenubarItem
                    key={item.to}
                    className="txr-shell-nav-menu-item"
                    render={<NavLink to={item.to} end={item.end} />}
                  >
                    {item.label}
                  </MenubarItem>
                ))}
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
          <TxrThemeToggle />
        </div>
      </header>
      {/* The routed area: the shell's skip-link target. In shell mode it is
          the ONE scroller before the pages own their regions (ITEM-2/3); in
          flow mode the document scrolls and this div is plain content. */}
      <div
        id="txr-main"
        tabIndex={-1}
        className="txr-app-shell-body"
        style={{ flex: 1, minHeight: 0 }}
      >
        {children}
      </div>
    </div>
  )
}
