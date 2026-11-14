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

// ── ITEM-6 page copy (the audit table's CHANGE column, part 1) ────────────────
// The sentences the ITEM-6 pages show in demo mode. Same rules as above: one
// place, location-neutral, the audit's words where it names them.

/** The Start page's primary card action in demo (the audit's "Use the
 *  example data" byte). */
export const DEMO_START_PRIMARY = 'Use the example data'

/** The Start page's bottom hint (the audit's "bottom hint explains the
 *  demo"). */
export const DEMO_START_HINT =
  'This is a demo: you can use the example data only, and the runs and models here are shared with everyone who visits. The desktop app is for your own data.'

/** The study panel's note when the answers leave the example setup (the
 *  audit's "the demo uses the example study" byte + the no-change clause). */
export const DEMO_STUDY_NOTE =
  'The demo uses the example study, so these answers do not change the methods the demo offers.'

/** The settings card's note (the spec's named sentence, verbatim). */
export const DEMO_SETTINGS_NOTE = 'the demo uses the example setup'

/** The run button's suffix in demo (the audit's "Run N methods (demo)"). */
export const DEMO_RUN_BUTTON_SUFFIX = ' (demo)'

/** The running page's label (the audit's "Demo run - results are the
 *  recorded ones"). */
export const DEMO_RUNNING_LABEL = 'Demo run - results are the recorded ones'

