// The macOS desktop window's title bar, as the page sees it.
//
// The window uses Tauri's overlay title bar (sdk/desktop/harness/src/window.rs):
// the page is drawn under the title-bar strip, the traffic lights sit over
// the page's top-left corner, and the page must provide the window's drag
// area. So in that window (`isMacDesktop()`) the page's top bar keeps them
// clear and is the drag region, in native full screen too: macOS slides the
// title bar and the traffic lights back in when the pointer reaches the top
// edge.
//
// ONE source for the UI side: `macTitleBar.json`. Its numbers:
//  - trafficLightPosition: what the window is built with
//    (`traffic_light_position` in src-app/desktop/tauri/src/lib.rs, the Rust
//    side's own source; its test `traffic_lights_match_the_ui_geometry`
//    reads this JSON and fails when the two disagree);
//  - trafficLights: where the three buttons land in the page, in CSS px
//    (measured on macOS 27 with that position: close button's left edge at
//    x = 20, three 14 px buttons 20 px apart, so x = 20..74; y = 20..36);
//  - titleBarHeight: the height of the page's title bar — the shell header
//    and, in this window, the AppLayout's header bar, the sidebar's top
//    band and the toggle band — on which the buttons are centred (28);
//  - contentStart: where text starts after the buttons (a 20 px gap): the
//    shell header's content and both screens' focused skip links.
// The TS code takes the numbers from here (`MAC_WINDOW_CHROME` for the
// shell's AppLayout); the CSS takes them as custom properties the shell sets
// once on its root (`MAC_TITLE_BAR_CSS_VARS`, used by index.css).
import type { CSSProperties } from 'react'
import geometry from './macTitleBar.json'

export const MAC_TITLE_BAR = geometry

/**
 * The AppLayout chrome (`@txresbench/shell` `WindowChrome`) for the macOS
 * desktop window: the toggle, the header and the skip link clear the
 * traffic lights, and every title-bar band is `titleBarHeight` tall.
 */
export const MAC_WINDOW_CHROME = {
  controlsRight: geometry.trafficLights.right,
  contentStart: geometry.contentStart,
  titleBarHeight: geometry.titleBarHeight,
} as const

/** The custom properties index.css's macOS rules read (set on the shell root). */
export const MAC_TITLE_BAR_CSS_VARS = {
  '--txr-mac-content-start': `${geometry.contentStart}px`,
} as CSSProperties
