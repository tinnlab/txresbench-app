import { useMemo, useState, type ReactNode } from 'react'
import { HeaderBarRegistryContext, type HeaderBarRegistry } from '../hooks/useWindowChrome'
import type { WindowChrome } from '../hooks/windowChrome'

/**
 * The top of the AppLayout's main column in a window whose title bar is drawn
 * by the page (`windowChrome`). Every AppLayout screen needs a title bar there
 * — the drag region, and the band the window controls sit in, so content
 * starts below them — whatever the routed page renders:
 *
 *  - a page that renders a `HeaderBarContainer` gets it from that bar (the
 *    bar counts itself in through `HeaderBarRegistryContext`);
 *  - while it renders none (a loading, error or empty state, or a page with
 *    no header at all) this host draws an empty strip of the title-bar
 *    height that drags the window.
 *
 * With no `windowChrome` (the web) it draws nothing. The count lives here,
 * not in the AppLayout, so a header bar mounting re-renders only this host;
 * the page (`children`) is passed through unchanged.
 */
export function WindowTitleBarHost({
  windowChrome,
  children,
}: {
  windowChrome: WindowChrome | null
  children: ReactNode
}) {
  const [headerBars, setHeaderBars] = useState(0)
  const registry = useMemo<HeaderBarRegistry>(
    () => ({
      register: () => {
        setHeaderBars(n => n + 1)
        return () => setHeaderBars(n => n - 1)
      },
    }),
    [],
  )
  return (
    <HeaderBarRegistryContext.Provider value={registry}>
      {windowChrome && headerBars === 0 && (
        <div
          data-testid="app-window-title-bar"
          data-tauri-drag-region="deep"
          aria-hidden="true"
          className="w-full flex-shrink-0"
          style={{ height: windowChrome.titleBarHeight }}
        />
      )}
      {children}
    </HeaderBarRegistryContext.Provider>
  )
}
