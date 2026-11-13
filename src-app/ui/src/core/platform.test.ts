// @vitest-environment jsdom
/**
 * The platform predicates — in particular `isMacDesktop()`, which gates the
 * shell header's macOS title-bar behaviour (the traffic-light inset and the
 * window drag region). It must answer true ONLY in the Tauri window on
 * macOS: never in a browser on a Mac, never in the Windows/Linux windows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDesktop, isMacDesktop, isMacOS, isWeb } from './platform'

/** The user agents the predicates must tell apart. */
const UA = {
  // WKWebView in the Tauri window on macOS (Intel and Apple silicon alike).
  macWebView:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // WebView2 in the Tauri window on Windows.
  windowsWebView2:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  // WebKitGTK in the Tauri window on Linux.
  linuxWebKitGtk:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // iPadOS Safari / WKWebView: the desktop user agent, word for word a Mac's.
  ipad:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
} as const

type TauriWindow = { __TAURI__?: unknown }

// jsdom has no `navigator.maxTouchPoints`; it is defined per test (an own
// property, removed after each test).
function setUserAgent(ua: string, maxTouchPoints = 0): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true,
  })
}

function setTauri(present: boolean): void {
  const w = window as unknown as TauriWindow
  if (present) w.__TAURI__ = { core: { invoke: vi.fn() } }
  else delete w.__TAURI__
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window.navigator as { maxTouchPoints?: number }).maxTouchPoints
  setTauri(false)
})

describe('isDesktop / isWeb', () => {
  it('follow the Tauri global', () => {
    setTauri(false)
    expect(isDesktop()).toBe(false)
    expect(isWeb()).toBe(true)
    setTauri(true)
    expect(isDesktop()).toBe(true)
    expect(isWeb()).toBe(false)
  })
})

describe('isMacOS', () => {
  it('answers true for the macOS webview and macOS browsers', () => {
    setUserAgent(UA.macWebView)
    expect(isMacOS()).toBe(true)
    setUserAgent(UA.macChrome)
    expect(isMacOS()).toBe(true)
  })

  it('answers false for Windows, Linux and iOS ("like Mac OS X" is not macOS)', () => {
    setUserAgent(UA.windowsWebView2)
    expect(isMacOS()).toBe(false)
    setUserAgent(UA.linuxWebKitGtk)
    expect(isMacOS()).toBe(false)
    setUserAgent(UA.iphone, 5)
    expect(isMacOS()).toBe(false)
  })

  it('answers false for an iPad, whose user agent is a Mac\'s word for word', () => {
    // The UA alone cannot tell them apart …
    expect(UA.ipad).toMatch(/Macintosh/)
    // … the touch points do: an iPad reports 5, a Mac 0.
    setUserAgent(UA.ipad, 5)
    expect(isMacOS()).toBe(false)
    setUserAgent(UA.ipad, 0)
    expect(isMacOS()).toBe(true)
  })
})

describe('isMacDesktop', () => {
  it('is true only in the Tauri window on macOS', () => {
    setTauri(true)
    setUserAgent(UA.macWebView)
    expect(isMacDesktop()).toBe(true)
  })

  it('is false in a browser on a Mac (the web build keeps its header)', () => {
    setTauri(false)
    setUserAgent(UA.macChrome)
    expect(isMacDesktop()).toBe(false)
  })

  it('is false in a Tauri webview on an iPad', () => {
    setTauri(true)
    setUserAgent(UA.ipad, 5)
    expect(isMacDesktop()).toBe(false)
  })

  it('is false in the Windows and Linux desktop windows', () => {
    setTauri(true)
    setUserAgent(UA.windowsWebView2)
    expect(isMacDesktop()).toBe(false)
    setUserAgent(UA.linuxWebKitGtk)
    expect(isMacDesktop()).toBe(false)
  })
})
