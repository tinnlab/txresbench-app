// @vitest-environment jsdom
/**
 * TEST-AS-1 (shell half) — the app-shell header's structure and the document
 * rules, as jsdom can see them (jsdom does not evaluate media queries or
 * layout, so the STRUCTURE the media rules key on + the token colours are
 * pinned here; the real 390/700/768×520 behaviour is the browser tier —
 * TEST-AS-1's gallery legs in `txr-shell-primitives.spec.ts` +
 * `txr-theme-phone.spec.ts`).
 *
 * app-shell ITEM-1 bytes: the shell is ONE 56 px row at every width (the
 * brand + tagline left, the nav row right, then the theme switch) with a
 * menu button below 700 px, a skip link as the FIRST tab stop, and the
 * two-mode document rules (`txr-shell-mode-*` on <html>).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ThemeContext, type ThemeContextValue } from '@txresbench/shell'
import { MAC_TITLE_BAR } from '@/core/macTitleBar'
import { TxrShell } from './TxrLayout'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The theme context value a real ThemeProvider computes for the light theme. */
const LIGHT_THEME: ThemeContextValue = {
  selectedTheme: 'system',
  resolvedTheme: 'light',
  isDarkMode: false,
  setTheme: () => {},
}

describe('AppShell header (TEST-AS-1)', () => {
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
      shell: view.container.querySelector<HTMLElement>('.txr-shell')!,
      header: view.container.querySelector<HTMLElement>('.txr-shell-header')!,
      brandGroup: view.container.querySelector<HTMLElement>('.txr-shell-brand-group')!,
      tagline: view.container.querySelector<HTMLElement>('.txr-shell-tagline')!,
      actions: view.container.querySelector<HTMLElement>('.txr-shell-actions')!,
      nav: view.container.querySelector<HTMLElement>('.txr-shell-nav')!,
      menu: view.container.querySelector<HTMLElement>('.txr-shell-nav-menu')!,
      toggle: view.container.querySelector<HTMLElement>('[data-testid="txr-theme-toggle"]')!,
      skip: view.container.querySelector<HTMLElement>('[data-testid="txr-shell-skip-link"]')!,
      body: view.container.querySelector<HTMLElement>('.txr-app-shell-body')!,
    }
  }

  afterEach(() => {
    document.documentElement.classList.remove('txr-shell-mode-shell', 'txr-shell-mode-flow')
  })

  it('keeps the board header byte: brand + tagline left, nav + theme switch right, the four destinations', () => {
    const { header, brandGroup, tagline, actions, nav, toggle } = headerOf()
    expect(header).not.toBeNull()
    expect(brandGroup.contains(tagline)).toBe(true)
    expect(actions.contains(nav)).toBe(true)
    expect(nav.querySelectorAll('a.txr-nav-link')).toHaveLength(4)
    expect(nav.textContent).toContain('New analysis')
    expect(nav.textContent).toContain('Models')
    expect(nav.textContent).toContain('History')
    expect(nav.textContent).toContain('Help')
    expect(actions.contains(toggle)).toBe(true)
    expect(nav.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.textContent).toContain('Light')
    // The one-row byte: a 56 px bar, never wrapping, flex: none so the body
    // gets the rest of the viewport (DEC-1).
    expect(header.style.height).toBe('56px')
    // React serializes flex: 'none' to its longhand triplet.
    expect(header.style.flex).toBe('0 0 auto')
    // The palette goes through the app tokens — never a light hex (RM-1).
    expect(header.style.background).toBe('var(--txr-surface-dim)')
    expect(header.style.borderBottom).toContain('var(--txr-border)')
  })

  it('carries the menu button (the below-700 nav) with the four destinations', () => {
    const { menu } = headerOf()
    expect(menu).not.toBeNull()
    // The menu items render only when the menu is open (Base UI draws the
    // content lazily, portalled) — jsdom pins the trigger; the four
    // destinations inside the OPEN menu are the browser tier's byte
    // (txr-shell-primitives.spec.ts + the phone sweeps).
    const trigger = menu.querySelector<HTMLElement>('[data-testid="txr-shell-nav-menu-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger!.tagName).toBe('BUTTON')
  })

  it('the skip link is the FIRST tab stop, before the brand', () => {
    const { view, skip, header } = headerOf()
    expect(skip.textContent).toBe('Skip to content')
    expect(skip.getAttribute('href')).toBe('#txr-main')
    // DOM order is the focus order: the skip link precedes the header.
    expect(header.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // The body carries the target id, focusable for the skip jump.
    const body = view.container.querySelector<HTMLElement>('#txr-main')!
    expect(body.tabIndex).toBe(-1)
  })

  it('puts the shell-mode class on the document (the mode the jsdom guard answers) and the body is the routed area', () => {
    const { shell, body } = headerOf()
    expect(document.documentElement.classList.contains('txr-shell-mode-shell')).toBe(true)
    expect(shell.className).toContain('txr-app-shell-shell')
    // React serializes flex: 1 to its longhand triplet.
    expect(body.style.flex).toBe('1 1 0%')
  })

  it('carries the responsive hooks the index.css block keys on (nav row + menu + skip link)', () => {
    const { header, brandGroup, tagline, actions, nav, menu, skip, body } = headerOf()
    // The class hooks the media rules select (index.css @media blocks).
    expect(header.className).toContain('txr-shell-header')
    expect(brandGroup.className).toContain('txr-shell-brand-group')
    expect(tagline.className).toContain('txr-shell-tagline')
    expect(actions.className).toContain('txr-shell-actions')
    expect(nav.className).toContain('txr-shell-nav')
    expect(menu.className).toContain('txr-shell-nav-menu')
    expect(skip.className).toContain('txr-shell-skip-link')
    expect(body.className).toContain('txr-app-shell-body')
  })

  it('the narrow + shell-mode rules exist in index.css: 900/700 breakpoints, one row, the menu swap, the fixed document', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    expect(index).toContain('@media (max-width: 900px)')
    expect(/@media \(max-width: 900px\)\s*\{\s*\.txr-shell-tagline\s*\{[^}]*display: none/.test(index)).toBe(true)
    // ITEM-1: the 700 px menu byte — the nav row yields, the menu takes its
    // place, the header stays ONE 56 px row, the theme label collapses.
    expect(index).toContain('@media (max-width: 700px)')
    const narrow700 = /@media \(max-width: 700px\)\s*\{[\s\S]*?\}\s*\}/.exec(index)?.[0] ?? ''
    expect(narrow700).toContain('.txr-shell-header')
    expect(/\.txr-shell-nav\s*\{\s*display: none !important/.test(narrow700)).toBe(true)
    expect(/\.txr-shell-nav-menu\s*\{\s*display: inline-flex !important/.test(narrow700)).toBe(true)
    expect(/\.txr-theme-toggle\s+\.txr-theme-toggle-label\s*\{[^}]*display: none/.test(narrow700)).toBe(true)
    // Above 700 the menu is hidden (the media query's other half).
    expect(/@media \(min-width: 701px\)\s*\{[^}]*\.txr-shell-nav-menu\s*\{\s*display: none !important/.test(index)).toBe(true)
    // The shell-mode document rules (DEC-1: the document never scrolls).
    expect(/html\.txr-shell-mode-shell,\s*html\.txr-shell-mode-shell body\s*\{[^}]*height: 100%[^}]*overflow: hidden/.test(index)).toBe(true)
    expect(index).toContain('html.txr-shell-mode-shell #root')
    // The skip link's focus rule (off-screen until keyboard focus).
    expect(/\.txr-shell-skip-link:focus-visible\s*\{[^}]*left: 12px/.test(index)).toBe(true)
    // The flow-mode sticky header.
    expect(index).toContain('.txr-app-shell-flow .txr-shell-header')
  })
})

/**
 * The macOS desktop title bar: Tauri's overlay title bar puts the traffic
 * lights over the header's left end and gives the page every mouse event,
 * so in that window (and only there) the header keeps the traffic lights'
 * strip clear and is the window's drag region. The drag itself is Tauri's
 * injected script (it reads `data-tauri-drag-region`), not app code, so the
 * pins are the attribute, the class and the index.css inset.
 */
describe('AppShell header on the macOS desktop window', () => {
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const WINDOWS_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

  function renderShell({ tauri, ua }: { tauri: boolean; ua: string }) {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
    const w = window as unknown as { __TAURI__?: unknown }
    if (tauri) w.__TAURI__ = { core: { invoke: vi.fn() } }
    else delete w.__TAURI__
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
      shell: view.container.querySelector<HTMLElement>('.txr-shell')!,
      header: view.container.querySelector<HTMLElement>('.txr-shell-header')!,
    }
  }

  function renderHeader(opts: { tauri: boolean; ua: string }) {
    return renderShell(opts).header
  }

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    document.documentElement.classList.remove('txr-shell-mode-shell', 'txr-shell-mode-flow')
  })

  it('makes the whole header the drag region and marks it for the traffic-light inset', () => {
    const header = renderHeader({ tauri: true, ua: MAC_UA })
    // "deep": a mousedown anywhere in the header's subtree drags the window,
    // except on links/buttons (Tauri's script lets those through).
    expect(header.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(header.classList.contains('txr-shell-header-macos')).toBe(true)
    // The controls stay controls: none of them claims the drag itself, and
    // each is an element Tauri's script treats as clickable (A / BUTTON).
    const controls = header.querySelectorAll<HTMLElement>('a, button')
    expect(controls.length).toBeGreaterThanOrEqual(6) // brand + 4 nav links + theme switch
    for (const control of controls) {
      expect(control.hasAttribute('data-tauri-drag-region')).toBe(false)
    }
    expect(header.querySelector('[data-tauri-drag-region]')).toBeNull()
  })

  it('marks the shell root so the focused skip links move clear of the traffic lights', () => {
    const { shell } = renderShell({ tauri: true, ua: MAC_UA })
    expect(shell.classList.contains('txr-app-shell-macos')).toBe(true)
  })

  it('sets the title-bar geometry from core/macTitleBar.json on the shell root, once', () => {
    const { shell, header } = renderShell({ tauri: true, ua: MAC_UA })
    expect(shell.style.getPropertyValue('--txr-mac-content-start')).toBe(`${MAC_TITLE_BAR.contentStart}px`)
    // The text starts past the zoom button, with a gap.
    expect(MAC_TITLE_BAR.contentStart).toBeGreaterThan(MAC_TITLE_BAR.trafficLights.right)
    // The traffic lights are centred on the header, which is the title bar's height.
    expect(header.style.height).toBe(`${MAC_TITLE_BAR.titleBarHeight}px`)
    expect((MAC_TITLE_BAR.trafficLights.top + MAC_TITLE_BAR.trafficLights.bottom) / 2).toBe(
      MAC_TITLE_BAR.titleBarHeight / 2,
    )
  })

  it('leaves the header unchanged in a browser on a Mac', () => {
    const { shell, header } = renderShell({ tauri: false, ua: MAC_UA })
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(header.className).toBe('txr-shell-header')
    expect(header.style.padding).toBe('0px 28px')
    expect(shell.classList.contains('txr-app-shell-macos')).toBe(false)
    expect(shell.style.getPropertyValue('--txr-mac-content-start')).toBe('')
  })

  it('leaves the header unchanged in the Windows desktop window', () => {
    const { shell, header } = renderShell({ tauri: true, ua: WINDOWS_UA })
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(header.className).toBe('txr-shell-header')
    expect(shell.classList.contains('txr-app-shell-macos')).toBe(false)
  })

  it('index.css clears the traffic lights at every width with the geometry source, not a copy of it', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    const rule = /\.txr-shell-header\.txr-shell-header-macos\s*\{([^}]*)\}/.exec(index)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/padding-left:\s*var\(--txr-mac-content-start\)\s*!important/)
  })

  it('index.css moves both focused skip links to the same left edge as the header content, on the macOS window only', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    // The web positions stay as they were.
    expect(/\.txr-shell-skip-link:focus-visible\s*\{[^}]*left: 12px/.test(index)).toBe(true)
    expect(/\.txr-help-skip-link:focus\s*\{[^}]*left: 12px !important/.test(index)).toBe(true)
    // Under the shell's macOS class they start at the shared content edge
    // (the AppLayout screens' skip link uses the same `contentStart`).
    expect(index).toMatch(
      /\.txr-app-shell-macos \.txr-shell-skip-link:focus-visible\s*\{[^}]*left:\s*var\(--txr-mac-content-start\);/,
    )
    expect(index).toMatch(
      /\.txr-app-shell-macos \.txr-help-skip-link:focus\s*\{[^}]*left:\s*var\(--txr-mac-content-start\) !important/,
    )
  })

  it('index.css carries no copy of the macOS geometry: every macOS rule reads the custom property', () => {
    const index = readFileSync(resolve(HERE, '../../index.css'), 'utf8')
    // Every rule whose SELECTOR (not a comment before it) names a macOS class.
    const macRules = [...index.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter(m => /macos/.test(m[1].split('*/').pop()!))
      .map(m => m[2])
    expect(macRules.length).toBe(3)
    for (const body of macRules) {
      expect(body).not.toMatch(/\b\d+px\b/)
    }
  })
})
