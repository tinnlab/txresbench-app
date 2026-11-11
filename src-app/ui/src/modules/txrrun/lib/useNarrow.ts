/**
 * txrrun — the ITEM-2 narrow-layout hook (qa-fixes3 ITEM-2 (d)).
 *
 * The plan's phone (390 px) layout makes the two cards — the files summary
 * and the settings — COLLAPSIBLE, collapsed by default with their one-line
 * summary visible. The app's phone rules are the `max-width: 640px` media
 * rules in `src/index.css` (every txr phone rule's breakpoint), so the
 * default state follows the same breakpoint. The hook is guarded the way
 * the Help page's rail media hook is: a browser without `matchMedia` (or
 * the test environment's jsdom) answers false — desktop — and a resize
 * moves the state only through the real media query, never a local guess.
 */
import { useEffect, useState } from 'react'

/** The app's phone breakpoint (the index.css `max-width: 640px` rules). */
export const TXR_NARROW_MAX_WIDTH = 640

const NARROW_QUERY = `(max-width: ${TXR_NARROW_MAX_WIDTH - 1}px)`

function isNarrow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_QUERY).matches
  )
}

/**
 * app-shell ITEM-2 — the short-shell-window query. The audit's three
 * measured heights are 900 (the chrome fits expanded), 720 and 768 (the
 * fixed top would leave the list region nothing), so the E page's two
 * collapsible cards answer this query: below 800 px tall they render
 * COLLAPSED by default (the same one-line form the phone width uses), and
 * the user can expand them in place.
 */
const SHORT_QUERY = '(max-height: 799px)'

/** True on a short shell window (guarded — jsdom answers false, desktop). */
export function useShortShell(): boolean {
  const [short, setShort] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(SHORT_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(SHORT_QUERY)
    const onChange = (): void => setShort(mql.matches)
    mql.addEventListener('change', onChange)
    setShort(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return short
}

/** True on the app's phone width (guarded — jsdom answers false, desktop). */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrow)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => setNarrow(mql.matches)
    mql.addEventListener('change', onChange)
    setNarrow(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return narrow
}
