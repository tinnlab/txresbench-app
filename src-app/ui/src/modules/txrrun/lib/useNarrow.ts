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
