import { createContext, useContext, useLayoutEffect } from 'react'
import type { WindowChrome } from './windowChrome'

/**
 * The AppLayout's host-window chrome (`hooks/windowChrome.ts`), handed to its
 * own subtree only: the app's sidebar leaves (toggle, top band) and any
 * `HeaderBarContainer` the routed page renders. Anything rendered outside an
 * AppLayout reads null and keeps the web chrome.
 */
export const WindowChromeContext = createContext<WindowChrome | null>(null)

/** The enclosing AppLayout's `WindowChrome`, or null (the web, or outside an AppLayout). */
export function useWindowChrome(): WindowChrome | null {
  return useContext(WindowChromeContext)
}

/**
 * The AppLayout's count of mounted header bars. While a page renders a
 * `HeaderBarContainer`, that bar is the window's title bar; while it
 * renders none (a loading, error or empty state, or a page without one),
 * the AppLayout draws its own title-bar strip instead.
 */
export interface HeaderBarRegistry {
  /** Count one header bar in; the returned function counts it out. */
  register: () => () => void
}

export const HeaderBarRegistryContext = createContext<HeaderBarRegistry | null>(null)

/**
 * Count the calling header bar in the enclosing AppLayout's registry while it
 * is mounted (only where the AppLayout has a `WindowChrome`: on the web there
 * is no strip to replace). A layout effect: the strip goes before the browser
 * paints the header next to it.
 */
export function useRegisterHeaderBar(): void {
  const chrome = useWindowChrome()
  const registry = useContext(HeaderBarRegistryContext)
  useLayoutEffect(() => {
    if (!chrome || !registry) return
    return registry.register()
  }, [chrome, registry])
}
