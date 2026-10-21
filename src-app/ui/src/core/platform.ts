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
