// ShowcaseApp.tsx — the dedicated Visualization Showcase catalog UI (ITEM-66). A
// sidebar of stories grouped by category + a live demo pane. Dev-only; renders viz-core
// against the fixture DataSource (no backend). Also the surface visual-regression + e2e
// drive.
//
// Light/dark toggle (DEC-39): the toggle sets the page + stage BACKGROUND, themes the
// showcase's own chrome, and publishes the active theme to
// `document.documentElement.dataset.vizTheme` + `window.__VIZ_THEME__` so the render
// harness + any theme-aware story can read it. viz-core never reads the app theme; the
// showcase is what passes a theme into it.

import { useEffect, useState } from 'react'
import { DARK_THEME, LIGHT_THEME } from '../viz-core/theme'
import { allStories, storiesByCategory } from './registry'

type ThemeName = 'light' | 'dark'

declare global {
  interface Window {
    __VIZ_THEME__?: ThemeName
  }
}

export function ShowcaseApp() {
  const stories = allStories()
  // #13: the active story rides the URL HASH (`#<story-id>`), so a reload / deep-link / back-forward
  // restores it. Initialize from the hash when it names a real story, else the first story.
  const [activeId, setActiveId] = useState(() => {
    const h = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.replace(/^#/, '')) : ''
    return stories.some(s => s.id === h) ? h : (stories[0]?.id ?? '')
  })
  const [themeName, setThemeName] = useState<ThemeName>('light')
  const active = stories.find(s => s.id === activeId) ?? stories[0]
  const byCat = storiesByCategory()

  const theme = themeName === 'dark' ? DARK_THEME : LIGHT_THEME
  const pageBg = themeName === 'dark' ? '#0b1220' : '#ffffff'

  // Publish the active theme so the render harness + theme-aware stories can read it.
  useEffect(() => {
    document.documentElement.dataset.vizTheme = themeName
    window.__VIZ_THEME__ = themeName
  }, [themeName])

  // #13: reflect the active story into the URL hash (replaceState so it doesn't spam history), and
  // react to back/forward / manual hash edits. A reload reads the hash via the initializer above.
  useEffect(() => {
    if (activeId && `#${activeId}` !== window.location.hash) {
      window.history.replaceState(null, '', `#${encodeURIComponent(activeId)}`)
    }
  }, [activeId])
  useEffect(() => {
    const onHash = () => {
      const h = decodeURIComponent(window.location.hash.replace(/^#/, ''))
      if (allStories().some(s => s.id === h)) setActiveId(h)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        background: pageBg,
        color: theme.fg,
      }}
    >
      <nav
        data-testid="showcase-sidebar"
        style={{
          width: 260,
          borderRight: `1px solid ${theme.border}`,
          overflowY: 'auto',
          padding: 12,
          boxSizing: 'border-box',
          background: theme.surface,
          color: theme.fg,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 700 }}>Visualization Showcase</div>
          <button
            type="button"
            data-testid="showcase-theme-toggle"
            aria-pressed={themeName === 'dark'}
            aria-label={`Switch to ${themeName === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${themeName === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => {
              const next = themeName === 'dark' ? 'light' : 'dark'
              // Set the dark-mode signal SYNCHRONOUSLY (before the re-render) so charts, which read it
              // via `defaultChartTheme()` at render, pick up the new theme THIS render (#14) — the
              // effect below only reasserts it.
              document.documentElement.dataset.vizTheme = next
              setThemeName(next)
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 11px',
              border: `1px solid ${theme.border}`,
              borderRadius: 999,
              cursor: 'pointer',
              background: 'rgba(128,128,128,0.14)',
              color: theme.fg,
              font: 'inherit',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>{themeName === 'dark' ? '🌙' : '☀️'}</span>
            {themeName === 'dark' ? 'Dark' : 'Light'}
          </button>
        </div>
        {[...byCat.entries()].map(([category, group]) => (
          <div key={category} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', color: theme.muted, marginBottom: 4 }}>
              {category}
            </div>
            {group.map(s => (
              <button
                key={s.id}
                data-testid={`showcase-story-${s.id}`}
                onClick={() => setActiveId(s.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 6px',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  color: theme.fg,
                  font: 'inherit',
                  background:
                    s.id === active?.id
                      ? themeName === 'dark'
                        ? 'rgba(120,150,255,0.25)'
                        : '#e6f0ff'
                      : 'transparent',
                }}
              >
                {s.title}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main data-testid="showcase-stage" style={{ flex: 1, minWidth: 0, background: pageBg, color: theme.fg }}>
        {active ? <active.Component /> : <div style={{ padding: 24 }}>No stories registered.</div>}
      </main>
    </div>
  )
}
