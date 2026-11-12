// Runtime platform detection.
//
// Desktop = the Tauri shell (exposes `window.__TAURI__`). The desktop app is
// SINGLE-USER, so sharing, ownership-transfer, and the admin transfer setting
// are WEB-ONLY — gate those affordances with `isDesktop()`. Projects themselves
// (create / list / datasets / card) work on both platforms.
//
// A pure predicate (no React) so it can gate slots, routes, and render alike.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

export function isWeb(): boolean {
  return !isDesktop()
}

// macOS, read from the user agent: WKWebView (the Tauri webview on macOS)
// reports "Macintosh; Intel Mac OS X ..." on Intel and Apple silicon alike.
// iOS says "like Mac OS X" but never "Macintosh", so it does not match.
export function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent)
}

// The macOS desktop window. Its title bar is a transparent overlay
// (`TitleBarStyle::Overlay`, sdk/desktop/harness/src/window.rs): the page is
// drawn under it, so the page must keep the traffic lights clear and provide
// the window's drag area itself. The browser build and the Windows/Linux
// desktop windows answer false.
export function isMacDesktop(): boolean {
  return isDesktop() && isMacOS()
}
