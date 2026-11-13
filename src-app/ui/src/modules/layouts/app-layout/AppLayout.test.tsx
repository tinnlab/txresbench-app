// @vitest-environment jsdom
/**
 * The AppLayout screens (today the /settings pages) in the macOS desktop
 * window. Its title bar is Tauri's
 * overlay (sdk/desktop/harness/src/window.rs): the traffic lights sit over
 * the page's top-left corner (x 20..74, y 20..36, core/macTitleBar.json) and
 * the page must provide the window's drag area. So in that window (native
 * full screen included: macOS slides the traffic lights back in at the top
 * edge) the app's AppLayout hands the shell's AppLayout the traffic lights'
 * geometry (`windowChrome`), and:
 *
 *  - the fixed sidebar toggle moves from left 12 to 82, past the lights;
 *  - every title-bar band — the page's header bar, the sidebar's top spacer,
 *    the band around the toggle — is 56 px tall (the lights are centred on
 *    it) and drags the window (`data-tauri-drag-region="deep"`);
 *  - the header bar clears the toggle (left padding 118 with the sidebar
 *    collapsed);
 *  - a screen that renders NO header bar (a loading, error or empty state;
 *    the Settings page always renders one, so this is the safety net for
 *    any AppLayout screen that does not) still gets a title bar: the
 *    AppLayout's own 56 px strip, which drags the window and keeps the
 *    content below the lights;
 *  - the focused skip link starts at left 94, as the shell's does.
 *
 * The browser build and the Windows/Linux windows keep the web chrome: no
 * drag attribute anywhere, no strip, the toggle at 12, the header at 48 / 12
 * and 50 px tall. A header bar rendered outside an AppLayout never gets the
 * macOS chrome.
 *
 * Tauri's drag script (tauri `src/window/scripts/drag.js`) lets a mousedown
 * through on A / BUTTON / INPUT / … and on tabindex / role=button elements
 * that carry no drag attribute of their own, so the pins below also check
 * that no control carries the attribute.
 */
import { useState, type ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Button, Input } from '@txresbench/kit'
import { HeaderBarContainer, ThemeContext, type ThemeContextValue } from '@txresbench/shell'
import { MAC_TITLE_BAR } from '@/core/macTitleBar'
import { AppLayout } from './AppLayout'
import { AppLayout as AppLayoutStore } from './AppLayout.store'

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

/** The theme context value a real ThemeProvider computes for the light theme. */
const LIGHT_THEME: ThemeContextValue = {
  selectedTheme: 'system',
  resolvedTheme: 'light',
  isDarkMode: false,
  setTheme: () => {},
}

const LIGHTS = MAC_TITLE_BAR.trafficLights
const TITLE_BAR = `${MAC_TITLE_BAR.titleBarHeight}px`

type TauriWindow = { __TAURI__?: unknown }

function setPlatform({ tauri, ua }: { tauri: boolean; ua: string }): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
  const w = window as unknown as TauriWindow
  if (tauri) w.__TAURI__ = { core: { invoke: vi.fn() } }
  else delete w.__TAURI__
}

/** A page as Settings / Projects / Datasets build it: the shared header bar on top. */
function HeaderPage() {
  return (
    <HeaderBarContainer>
      <h4>Datasets</h4>
      <Input aria-label="Search datasets" data-testid="page-search" />
      <Button data-testid="page-upload">Upload data</Button>
    </HeaderBarContainer>
  )
}

/** A page in its loading / error / empty state: no header bar at all. */
function HeaderlessPage() {
  return <p data-testid="page-loading">Loading dataset</p>
}

function renderInLayout(page: ReactNode, { sidebarCollapsed }: { sidebarCollapsed: boolean }) {
  act(() => AppLayoutStore.setSidebarCollapsed(sidebarCollapsed))
  const view = render(
    <MemoryRouter initialEntries={['/settings']}>
      <ThemeContext.Provider value={LIGHT_THEME}>
        <AppLayout>{page}</AppLayout>
      </ThemeContext.Provider>
    </MemoryRouter>,
  )
  const byTestId = (id: string) => view.getByTestId(id)
  return {
    view,
    toggleBar: byTestId('layout-sidebar-toggle-bar'),
    toggle: byTestId('layout-sidebar-toggle-button'),
    spacer: byTestId('layout-sidebar-header-spacer'),
    skip: byTestId('app-layout-skip-link'),
    header: () => view.queryByTestId('app-header-bar'),
    strip: () => view.queryByTestId('app-window-title-bar'),
    dragRegions: () => [...view.container.querySelectorAll<HTMLElement>('[data-tauri-drag-region]')],
  }
}

function renderPage({ sidebarCollapsed }: { sidebarCollapsed: boolean }) {
  const page = renderInLayout(<HeaderPage />, { sidebarCollapsed })
  return { ...page, header: page.header()! }
}

beforeAll(() => {
  // jsdom has no ResizeObserver (the AppLayout measures its main column).
  if (!('ResizeObserver' in window)) {
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as TauriWindow).__TAURI__
})

function expectWebChrome(page: ReturnType<typeof renderPage>, { sidebarCollapsed }: { sidebarCollapsed: boolean }) {
  expect(page.dragRegions()).toEqual([])
  expect(page.strip()).toBeNull()
  expect(page.toggleBar.style.left).toBe('12px')
  // Heights: the classes' own 50 px (no inline height).
  expect(page.toggleBar.style.height).toBe('')
  expect(page.spacer.style.height).toBe('')
  expect(page.header.style.height).toBe('')
  expect(page.header.style.paddingLeft).toBe(sidebarCollapsed ? '48px' : '12px')
  // No inline left: the class's own `focus:left-2` places the skip link.
  expect(page.skip.style.left).toBe('')
}

const WEB_PLATFORMS = [
  ['a browser on a Mac', { tauri: false, ua: MAC_UA }],
  ['the Windows desktop window', { tauri: true, ua: WINDOWS_UA }],
  ['the Linux desktop window', { tauri: true, ua: LINUX_UA }],
] as const

describe('AppLayout chrome outside the macOS desktop window', () => {
  for (const [name, platform] of WEB_PLATFORMS) {
    it(`keeps the web chrome in ${name}`, () => {
      setPlatform(platform)
      expectWebChrome(renderPage({ sidebarCollapsed: true }), { sidebarCollapsed: true })
      cleanup()
      expectWebChrome(renderPage({ sidebarCollapsed: false }), { sidebarCollapsed: false })
    })

    it(`draws no title-bar strip over a header-less page in ${name}`, () => {
      setPlatform(platform)
      const page = renderInLayout(<HeaderlessPage />, { sidebarCollapsed: true })
      expect(page.strip()).toBeNull()
      expect(page.dragRegions()).toEqual([])
    })
  }
})

describe('AppLayout chrome in the macOS desktop window', () => {
  it('moves the sidebar toggle, the header content and the skip link past the traffic lights (sidebar collapsed)', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    const page = renderPage({ sidebarCollapsed: true })
    expect(page.toggleBar.style.left).toBe('82px')
    expect(Number.parseInt(page.toggleBar.style.left, 10)).toBeGreaterThan(LIGHTS.right)
    // The header runs under the lights and the toggle (82 + 28 px + 8 px gap).
    expect(page.header.style.paddingLeft).toBe('118px')
    // The skip link at the shell's content edge (index.css's
    // `--txr-mac-content-start`): one value, core/macTitleBar.json.
    expect(page.skip.style.left).toBe(`${MAC_TITLE_BAR.contentStart}px`)
    expect(MAC_TITLE_BAR.contentStart).toBeGreaterThan(LIGHTS.right)
  })

  it('makes every title-bar band the title bar\'s height, so the toggle and the header are centred on the traffic lights', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    const page = renderPage({ sidebarCollapsed: true })
    expect(page.header.style.height).toBe(TITLE_BAR)
    expect(page.toggleBar.style.height).toBe(TITLE_BAR)
    expect(page.spacer.style.height).toBe(TITLE_BAR)
    // The lights' centre is the bands' centre (28 of 56).
    expect((LIGHTS.top + LIGHTS.bottom) / 2).toBe(MAC_TITLE_BAR.titleBarHeight / 2)
  })

  it('makes the header bar, the sidebar top and the band around the toggle the drag region', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    const collapsed = renderPage({ sidebarCollapsed: true })
    expect(collapsed.header.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(collapsed.toggleBar.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(collapsed.spacer.getAttribute('data-tauri-drag-region')).toBe('deep')
    // The page's header bar is the title bar: no strip on top of it.
    expect(collapsed.strip()).toBeNull()
    cleanup()

    // Sidebar open: the toggle sits over the sidebar's top spacer, and the
    // header beside the sidebar keeps its 12 px.
    const open = renderPage({ sidebarCollapsed: false })
    expect(open.toggleBar.style.left).toBe('82px')
    expect(open.header.style.paddingLeft).toBe('12px')
    expect(open.spacer.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(open.header.getAttribute('data-tauri-drag-region')).toBe('deep')
  })

  it('leaves every control a control: none carries the drag attribute', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    const page = renderPage({ sidebarCollapsed: true })
    expect(page.dragRegions().length).toBe(3)
    const controls = page.view.container.querySelectorAll<HTMLElement>(
      'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
    )
    expect(controls.length).toBeGreaterThanOrEqual(3) // skip link, toggle, the header's input + button
    for (const control of controls) {
      expect(control.hasAttribute('data-tauri-drag-region')).toBe(false)
    }
    expect(page.toggle.tagName).toBe('BUTTON')
  })

  it('gives a page that renders no header bar a title-bar strip that drags the window and keeps the content below the traffic lights', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    const page = renderInLayout(<HeaderlessPage />, { sidebarCollapsed: true })
    expect(page.header()).toBeNull()
    const strip = page.strip()!
    expect(strip).not.toBeNull()
    expect(strip.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(strip.style.height).toBe(TITLE_BAR)
    expect(MAC_TITLE_BAR.titleBarHeight).toBeGreaterThan(LIGHTS.bottom)
    // The strip is the main column's first child, so the page starts below it.
    const main = page.view.container.querySelector('main')!
    expect(main.firstElementChild).toBe(strip)
    const loading = page.view.getByTestId('page-loading')
    expect(strip.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Toggle band, sidebar top and the strip drag the window.
    expect(page.dragRegions().length).toBe(3)
  })

  it('swaps the strip for the page\'s header bar when the page loads, and back', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    let setLoaded: (loaded: boolean) => void = () => {}
    function LoadingThenLoaded() {
      const [loaded, set] = useState(false)
      setLoaded = set
      return loaded ? <HeaderPage /> : <HeaderlessPage />
    }
    const page = renderInLayout(<LoadingThenLoaded />, { sidebarCollapsed: true })
    expect(page.strip()).not.toBeNull()
    expect(page.header()).toBeNull()

    act(() => setLoaded(true))
    expect(page.strip()).toBeNull()
    expect(page.header()!.getAttribute('data-tauri-drag-region')).toBe('deep')

    act(() => setLoaded(false))
    expect(page.header()).toBeNull()
    expect(page.strip()).not.toBeNull()
  })
})

describe('the macOS chrome belongs to the AppLayout', () => {
  it('a header bar rendered outside an AppLayout never gets the inset, the height or the drag attribute', () => {
    setPlatform({ tauri: true, ua: MAC_UA })
    act(() => AppLayoutStore.setSidebarCollapsed(true))
    const view = render(
      <MemoryRouter>
        <ThemeContext.Provider value={LIGHT_THEME}>
          <HeaderPage />
        </ThemeContext.Provider>
      </MemoryRouter>,
    )
    const header = view.getByTestId('app-header-bar')
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(header.style.height).toBe('')
    expect(header.style.paddingLeft).toBe('48px')
    expect(view.container.querySelector('[data-tauri-drag-region]')).toBeNull()
  })

  it('an AppLayout always has it in the macOS window, with nothing set up beforehand', () => {
    // No store write, no prior mount: the platform alone decides.
    setPlatform({ tauri: true, ua: MAC_UA })
    const page = renderInLayout(<HeaderlessPage />, { sidebarCollapsed: false })
    expect(page.strip()).not.toBeNull()
    expect(page.spacer.getAttribute('data-tauri-drag-region')).toBe('deep')
    cleanup()
    // … and the next AppLayout in a browser on the same page has none.
    setPlatform({ tauri: false, ua: MAC_UA })
    const web = renderInLayout(<HeaderlessPage />, { sidebarCollapsed: false })
    expect(web.strip()).toBeNull()
    expect(web.dragRegions()).toEqual([])
  })
})
