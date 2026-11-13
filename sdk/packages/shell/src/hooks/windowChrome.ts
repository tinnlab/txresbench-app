/**
 * Host-window chrome for the AppLayout screens — the pure arithmetic behind
 * the sidebar toggle, the header bar (`HeaderBarContainer`,
 * `useHeaderLeftInset`), the sidebar's top band, the AppLayout's own
 * title-bar strip and its skip link.
 *
 * A desktop window that draws its title bar INSIDE the page (macOS under an
 * overlay title bar: the traffic lights sit over the page's top-left corner,
 * and the page must provide the window's drag area) passes a `WindowChrome`
 * to the AppLayout (`windowChrome` prop). The AppLayout hands it to its own
 * subtree only (`useWindowChrome()`), so a header bar rendered outside an
 * AppLayout keeps the web chrome. Without one the chrome is the web chrome,
 * exactly.
 *
 * With a `WindowChrome`:
 *  - the sidebar toggle sits `CONTROL_GAP` px after the window controls;
 *  - the header bar, the sidebar's top band and the toggle band are
 *    `titleBarHeight` tall, and the header bar (or, on a screen that renders
 *    none, the AppLayout's own strip) is the drag region (Tauri's
 *    `data-tauri-drag-region`; `"deep"` = the whole subtree drags, links and
 *    buttons stay clickable);
 *  - the focused skip link starts at `contentStart`.
 */

/** What a desktop window's own title-bar controls take from the page. */
export interface WindowChrome {
  /** Right edge (px) of the window's own controls over the page's top-left corner. */
  controlsRight: number
  /** Left edge (px) for text placed past the controls (the focused skip link). */
  contentStart: number
  /** Height (px) of the title bar the page draws: the header bar, the sidebar's top band, the toggle band. */
  titleBarHeight: number
}

/** Left edge (px) of the fixed sidebar toggle with no window controls. */
export const SIDEBAR_TOGGLE_LEFT = 12
/** The sidebar toggle's size (px). */
export const SIDEBAR_TOGGLE_SIZE = 28
/** Gap (px) between the window controls / the toggle and what follows. */
export const CONTROL_GAP = 8
/** Header left padding that clears the toggle (12 + its 28 px + an 8 px gap). */
export const HEADER_INSET_COLLAPSED = SIDEBAR_TOGGLE_LEFT + SIDEBAR_TOGGLE_SIZE + CONTROL_GAP
/** Header left padding beside an open sidebar (the toggle sits over the sidebar). */
export const HEADER_INSET_EXPANDED = 12
/** The header bar's height (px) with no window controls. */
export const HEADER_BAR_HEIGHT = 50

/** A usable `WindowChrome`, or null (absent, or any field not a positive number). */
export function windowChromeOrNull(chrome: WindowChrome | null | undefined): WindowChrome | null {
  if (!chrome || typeof chrome !== 'object') return null
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
  return ok(chrome.controlsRight) && ok(chrome.contentStart) && ok(chrome.titleBarHeight)
    ? chrome
    : null
}

/** The fixed sidebar toggle's left edge. */
export function sidebarToggleLeftFor(chrome?: WindowChrome | null): number {
  const c = windowChromeOrNull(chrome)
  return c ? c.controlsRight + CONTROL_GAP : SIDEBAR_TOGGLE_LEFT
}

/**
 * The header bar's left padding. With the sidebar collapsed the header runs
 * to the window's left edge, under the fixed toggle (and the window
 * controls, when there are any), so it starts after the toggle; with the
 * sidebar open the header starts past the sidebar, which carries both.
 */
export function headerLeftInsetFor(
  isSidebarCollapsed: boolean,
  chrome?: WindowChrome | null,
): number {
  return isSidebarCollapsed
    ? sidebarToggleLeftFor(chrome) + SIDEBAR_TOGGLE_SIZE + CONTROL_GAP
    : HEADER_INSET_EXPANDED
}

/** The header bar's (and the sidebar top band's) height. */
export function titleBarHeightFor(chrome?: WindowChrome | null): number {
  const c = windowChromeOrNull(chrome)
  return c ? c.titleBarHeight : HEADER_BAR_HEIGHT
}

/**
 * The focused skip link's left edge as an inline style, or `undefined` to
 * keep the class's own `left-2` (the web position, byte-identical).
 */
export function skipLinkStyleFor(chrome?: WindowChrome | null): { left: number } | undefined {
  const c = windowChromeOrNull(chrome)
  return c ? { left: c.contentStart } : undefined
}

/** The title bar's `data-tauri-drag-region` value (`undefined` = no attribute). */
export function windowDragRegionAttr(chrome?: WindowChrome | null): 'deep' | undefined {
  return windowChromeOrNull(chrome) ? 'deep' : undefined
}
