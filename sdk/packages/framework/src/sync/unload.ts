// A stream ending is NORMAL when the page is going away: navigation, a
// closed tab, or a bfcache freeze all tear the SSE fetch down, and
// "reconnecting" against an unloading document is the loop doing its job
// into a corpse. The reconnect logic then is not a failure to report at
// `warn` — quiet-and-correct is `debug`, and a real drop (the page still
// there and visible) stays a `warn`.
//
// The signal is `pagehide` (the one event that fires on navigation AND on
// close AND on bfcache freeze); `pageshow` clears it, so a bfcache restore
// returns the page to the warn regime for genuine drops. The flag is module
// state: one page, one stream manager, one truth.
let pageHiding = false

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    pageHiding = true
  })
  window.addEventListener('pageshow', () => {
    pageHiding = false
  })
}

/** True while the document is unloading/hidden for navigation or close. */
export function isDocumentUnloading(): boolean {
  return pageHiding
}
