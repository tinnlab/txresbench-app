/**
 * demo copy — the demo-mode UI's user-visible sentences, in ONE place
 * (ITEM-5; the server's own one-line `notice` text lives in
 * `server/src/modules/demo/copy.rs` — ITEM-7's statements quote that one).
 *
 * Location-neutral (DEC-5 / qa-fixes2 rule): the demo copy says "demo",
 * never where it runs. The copy-guard test scans this module for the banned
 * phrases, so a sentence that sneaks a location claim in fails the guard.
 */

/** The notice bar's text (the plan's exact words). */
export const DEMO_BANNER_TEXT =
  'This is a demo of TxResBench. You can try it with the example data only, ' +
  'and the runs and models here are shared with everyone who visits. ' +
  'To use it on your own data, privately, download the desktop app.'

/** The notice bar's primary action (the download link). */
export const DEMO_BANNER_PRIMARY_ACTION = 'Download the desktop app'

/** The notice bar's secondary link (the Help section's anchor). */
export const DEMO_BANNER_SECONDARY_ACTION = 'What is different in the demo'

/** The notice bar's close button (its accessible name). */
export const DEMO_BANNER_CLOSE = 'Close the demo notice'

/** The header link (visible in demo mode only). */
export const DEMO_HEADER_DOWNLOAD = 'Download the app'

/** The disabled-control reason (the plan's inline reason / tooltip). */
export const DEMO_DISABLED_REASON = 'Not available in the demo'
