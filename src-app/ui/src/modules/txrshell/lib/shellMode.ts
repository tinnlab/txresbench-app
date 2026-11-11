/**
 * txrshell — the app-shell mode switch (app-shell ITEM-1, DEC-1/DEC-2).
 *
 * The app has TWO layouts by window size (the audit doc, section 2):
 *
 *  · SHELL mode — the viewport is at least 768 px wide AND 520 px high (the
 *    desktop window is always in it, DEC-2): the document never scrolls,
 *    the header is a fixed 56 px bar, the pages scroll inside their own
 *    regions.
 *  · FLOW mode — anything smaller (phones, the web demo on a phone):
 *    normal document scrolling with a sticky header, so touch devices
 *    behave as users expect.
 *
 * The ONE media query below is the single source of truth: `index.css`
 * declares the document rules (html/body/#root height + overflow) against
 * the SAME expression, and the shell's React state follows this query — a
 * resize moves both halves together, never a JS guess next to a CSS guess.
 *
 * The hook is guarded the way the txrrun narrow hook is: a browser without
 * `matchMedia` (the test environment's jsdom) answers SHELL — desktop —
 * which is the app's primary target and the layout the unit tier must see.
 */
import { useEffect, useState } from 'react'

/** Shell-mode minimum viewport width (px). */
export const SHELL_MODE_MIN_WIDTH = 768
/** Shell-mode minimum viewport height (px). */
export const SHELL_MODE_MIN_HEIGHT = 520

/** The one media expression both the CSS and the hook answer. */
export const SHELL_MODE_QUERY = `(min-width: ${SHELL_MODE_MIN_WIDTH}px) and (min-height: ${SHELL_MODE_MIN_HEIGHT}px)`

/** The two shell layouts. */
export type ShellMode = 'shell' | 'flow'

/** Pure mode resolution — the boundary is inclusive on BOTH axes. */
export function resolveShellMode(width: number, height: number): ShellMode {
  return width >= SHELL_MODE_MIN_WIDTH && height >= SHELL_MODE_MIN_HEIGHT
    ? 'shell'
    : 'flow'
}

/** The mode now, per the real media query (guarded: jsdom answers shell). */
export function currentShellMode(): ShellMode {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(SHELL_MODE_QUERY).matches
    ) {
      return 'shell'
    }
  } catch {
    // A test DOM whose matchMedia exists but is not implemented: desktop.
  }
  // No working matchMedia (jsdom): the app's desktop byte.
  return 'shell'
}

/** Reactive shell mode: answers the query now and follows a resize. */
export function useShellMode(): ShellMode {
  const [mode, setMode] = useState<ShellMode>(currentShellMode)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(SHELL_MODE_QUERY)
    } catch {
      return
    }
    const onChange = (): void => setMode(mql.matches ? 'shell' : 'flow')
    mql.addEventListener('change', onChange)
    setMode(mql.matches ? 'shell' : 'flow')
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return mode
}

/** The class the shell puts on <html> for the mode's document rules. */
export function shellModeClass(mode: ShellMode): string {
  return `txr-shell-mode-${mode}`
}
