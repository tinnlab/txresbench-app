// @vitest-environment jsdom
/**
 * TEST-QF-7 (X2 half) — the shell header's responsive structure.
 *
 * The QA measurement (X2/G-2/RES-26): at 390 px the tagline wrapped into five
 * clipped lines and the nav pushed History/Help off-screen (page scrollWidth
 * 526). The fix: theme tokens for the palette (the header must follow dark
 * mode with the pages) + the `.txr-shell-*` hooks the responsive block in
 * index.css keys on (tagline hidden under 900 px, header stacked into two
 * rows under 640 px — the board itself is desktop-only, DEC-2's board byte at
 * desktop is unchanged, and the narrow rules live in CSS because a media
 * query cannot touch an inline style).
 *
 * jsdom does not evaluate media queries or layout, so this pins the
 * STRUCTURE the rules key on + the token colours; the real 390 px
 * no-overflow assertion is the browser tier (`tests/gallery-e2e/` —
 * TEST-QF-7's phone arm, and the header's own e2e sweep in ITEM-8).
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ThemeContext, type ThemeContextValue } from '@ziee/shell'
import { TxrShell } from './TxrLayout'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The theme context value a real ThemeProvider computes for the light theme. */
const LIGHT_THEME: ThemeContextValue = {
  selectedTheme: 'system',
  resolvedTheme: 'light',
  isDarkMode: false,
  setTheme: () => {},
}

describe('TxrShell header (TEST-QF-7, X2)', () => {
  function headerOf() {
    const view = render(
      <MemoryRouter initialEntries={['/']}>
        <ThemeContext.Provider value={LIGHT_THEME}>
          <TxrShell>
            <div data-testid="txr-shell-content" />
          </TxrShell>
        </ThemeContext.Provider>
      </MemoryRouter>,
    )
    return {
      view,
      header: view.container.querySelector<HTMLElement>('.txr-shell-header')!,
      brandGroup: view.container.querySelector<HTMLElement>('.txr-shell-brand-group')!,
      tagline: view.container.querySelector<HTMLElement>('.txr-shell-tagline')!,
      actions: view.container.querySelector<HTMLElement>('.txr-shell-actions')!,
      nav: view.container.querySelector<HTMLElement>('.txr-shell-nav')!,
      toggle: view.container.querySelector<HTMLElement>('[data-testid="txr-theme-toggle"]')!,
    }
  }

  it('keeps the board header byte at desktop: brand + tagline left, nav + theme switch right, the four destinations', () => {
    const { header, brandGroup, tagline, actions, nav, toggle, view } = headerOf()
    expect(header).not.toBeNull()
    expect(brandGroup.contains(tagline)).toBe(true)
    expect(actions.contains(nav)).toBe(true)
    // qa-fixes2 ITEM-3 (R2-H5): Help is now one of the four nav links — the
    // NavLink paints the active pill on /help like the other destinations.
    expect(nav.querySelectorAll('a.txr-nav-link')).toHaveLength(4)
    expect(nav.textContent).toContain('New analysis')
    expect(nav.textContent).toContain('Models')
    expect(nav.textContent).toContain('History')
    expect(nav.textContent).toContain('Help')
    // The theme switch sits in the same actions cluster, to the right of Help
    // (qa-fixes2 ITEM-1), and shows the CURRENT state with an icon + label.
    expect(actions.contains(toggle)).toBe(true)
    expect(nav.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.textContent).toContain('Light')
    // The palette goes through the app tokens — never a light hex that would
    // stay light in dark mode (RM-1).
    expect(header.style.background).toBe('var(--txr-surface-dim)')
    expect(header.style.borderBottom).toContain('var(--txr-border)')
    expect(view.container.querySelector<HTMLElement>('.txr-shell')!.style.background).toBe(
      'var(--txr-surface)',
    )
  })

  it('carries the responsive hooks the index.css block keys on (tagline + wrap + stack + toggle label)', () => {
    const { header, brandGroup, tagline, actions, nav, toggle } = headerOf()
    // The class hooks the media rules select (index.css @media blocks).
    expect(header.className).toContain('txr-shell-header')
    expect(brandGroup.className).toContain('txr-shell-brand-group')
    expect(tagline.className).toContain('txr-shell-tagline')
    expect(actions.className).toContain('txr-shell-actions')
    expect(nav.className).toContain('txr-shell-nav')
    expect(toggle.className).toContain('txr-theme-toggle')
    expect(toggle.querySelector('.txr-theme-toggle-label')).not.toBeNull()
  })

  it('the narrow rules exist in index.css: the tagline yields first, the header stacks below 640, the toggle label collapses', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    expect(index).toContain('@media (max-width: 900px)')
    expect(/@media \(max-width: 900px\)\s*\{\s*\.txr-shell-tagline\s*\{[^}]*display: none/.test(index)).toBe(true)
    expect(/@media \(max-width: 640px\)\s*\{[^}]*\.txr-shell-header\s*\{[^}]*height: auto/.test(index)).toBe(true)
    expect(/\.txr-shell-actions\s*\{[^}]*flex: 1 1 100%/.test(index)).toBe(true)
    // ITEM-1's own narrow byte: the switch's label hides, the icon stays.
    expect(
      /@media \(max-width: 640px\)\s*\{[\s\S]*?\.txr-theme-toggle\s+\.txr-theme-toggle-label\s*\{[^}]*display: none/.test(
        index,
      ),
    ).toBe(true)
  })
})
