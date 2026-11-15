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

// ── ITEM-7 page copy (the audit table's CHANGE column, part 2) ────────────────
// The sentences the ITEM-7 pages show in demo mode. Same rules as above: one
// place, location-neutral, the plan's words where it names them.

/** The results pages' line (the audit's "These are recorded results of the
 *  example data" byte). */
export const DEMO_RECORDED_RESULTS_LINE =
  'These are recorded results of the example data'

/** The shared-pool + retention statement (the plan's exact sentence — the
 *  History, Models, Saved-models and Help paragraphs all carry it). */
export const DEMO_POOL_STATEMENT =
  'The demo is shared with everyone. It keeps the last 50 runs and the last ' +
  '50 models; older ones are deleted automatically. Download the desktop app ' +
  'for your own private workspace.'

/** Format the counters ("37 of 50 runs" / "12 of 50 models" — the audit's
 *  "n of 50" byte). The numbers are the server's (the counted, non-pinned
 *  entries over the configured limit); a null count is the quiet ellipsis
 *  (the usage read has not landed yet — pages must not invent a figure). */
export function formatDemoCounter(
  count: number | null,
  limit: number,
  noun: 'runs' | 'models',
): string {
  return `${count ?? '\u2026'} of ${limit} ${noun}`
}

/** The pretrained card's chip in demo (the audit's "Included in the demo"
 *  byte — the card is included in the demo rather than downloaded). */
export const DEMO_PRETRAINED_CHIP = 'Included in the demo'

// ── ITEM-7 Help section copy (the audit's "About this demo" row) ──────────────

/** The Help section's id (the notice bar's `/help#demo` anchor). */
export const DEMO_HELP_SECTION_ID = 'demo'

/** The Help section's title (the audit's byte). */
export const DEMO_HELP_TITLE = 'About this demo'

/** The Help section's lead (what the demo is). */
export const DEMO_HELP_LEAD =
  'This is a demo of TxResBench. You can try the whole flow with the example ' +
  'data only; the runs here replay recorded results, so the example stays ' +
  'identical for every visitor, and nothing you do here is your own data.'

/** What the demo allows (the audit's "what is possible"). */
export const DEMO_HELP_CAN = [
  'Use the example data through all three ways in, and see the example methods, runs, predictions and saved models.',
  'Download the predictions of a run as a CSV, watch a run replay, and stop or skip it.',
  'Save the recorded models of a run under a generated name and use them again.',
]

/** What the demo blocks (the audit's "what is not possible"). */
export const DEMO_HELP_CANNOT = [
  'Upload your own files: the example tables are the only tables the demo accepts.',
  'Rename, delete, export or import runs and models, or clear the history — the demo keeps its own limits instead.',
  'Install or refresh pretrained models: the cards shown are included in the demo.',
  'Type a name of your own: saved set names are generated for you.',
]

/** The Help section's privacy line. */
export const DEMO_HELP_PRIVACY =
  'The demo does not track you and uses no analytics. It has no sign-up; ' +
  'your browser gets an anonymous session, and the demo keeps no personal data.'

/** The demo's generated set name (the audit's "the save dialog shows a
 *  generated name (no text field)" byte; the server's own byte is ITEM-1's
 *  `Demo models <UTC yyyy-mm-dd HH:MM>` — the same clock and format, so the
 *  dialog's preview and the server's saved name agree to the minute). */
export function demoGeneratedSetName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    ` ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`
  return `Demo models ${stamp}`
}

