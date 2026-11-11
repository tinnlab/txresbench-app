/**
 * txrhelp content types — the typed shape of the Help page's data file
 * (`content.ts`): one section list, the quick-start cards, the per-file
 * column specs and the closed problem-code references. The page renders
 * whatever this shape carries; the content is data, the renderer is the
 * components in `pages/` (the redesign: one component per block kind, one
 * accordion for the problem codes).
 *
 * Every block kind is a small closed union, so an unknown kind is a compile
 * error at the renderer and a section can never silently drop a block.
 * The severity group of a problem code is NOT authored here — it is read
 * from the committed validator catalogue (`validator-catalog.json`, the
 * server's own declaration tables rendered by `catalog::catalog_json`), so
 * the code/severity/applicability facts cannot drift from the validator.
 */

/** One authored body block of a Help section. */
export type HelpBlock =
  /** A plain paragraph. */
  | { kind: 'paragraph'; text: string }
  /** Short run-in line above a table (the column tables' caption). */
  | { kind: 'caption'; text: string }
  /** Unordered bullets. */
  | { kind: 'bullets'; items: string[] }
  /** A labelled table (`head` + one string entry per row). */
  | { kind: 'table'; head: string[]; rows: string[][] }
  /** A callout — Tip, Note or Watch out (icon, accent bar, tinted fill). */
  | { kind: 'callout'; tone: 'tip' | 'note' | 'watch'; text: string }
  /** The numbered visual stepper (the four steps). */
  | { kind: 'stepper'; steps: StepCard[] }
  /** One file card of "Preparing your files". */
  | { kind: 'fileCard'; card: FileCardContent }
  /** The status vocabulary (eligibility verdicts + run states, the same
   *  chips the running/choose screens use — the labels and tones are the
   *  sibling modules' own constants, the meanings are authored here). */
  | { kind: 'statuses' }

/** One authored Help section: `id` is the anchor (`#id`). */
export interface HelpSection {
  /** The anchor id (also the page-level test id). */
  id: string
  /** The section heading (TOC + body). */
  title: string
  blocks: HelpBlock[]
}

/** One quick-start card's example action (qa-fixes3 ITEM-5): the one-line
 *  "Try it with example data" that runs the same one-click example flow the
 *  Start screen's card runs. The path union is the txrintake module's
 *  `IntakeIntent` spelling — a LOCAL three-literal union on purpose, so the
 *  help content stays data-pure: the module never imports the intake
 *  module's types (the `txintake` → `txrhelp` dependency direction is
 *  declared; a reverse import would be the manifest cycle the loader
 *  throws on — the `txrrun`/`txrlist` internals precedent). */
export interface QuickStartTryExample {
  /** The visible one-line label (the plan's words). */
  label: string
  /** The example flow's path (`'train'` = learn from my data; the two
   *  predict paths use their intent spelling). */
  path: 'pretrained' | 'train' | 'reuse'
}

/** One quick-start card under the search box (mirrors the Start screen's
 *  three ways in; each button goes to the screen that starts it). */
export interface QuickStartCard {
  id: 'pretrained' | 'learn' | 'saved'
  /** The card's eyebrow ("Quickest", ...). */
  eyebrow: string
  title: string
  /** One or two short sentences. */
  text: string
  /** The chip naming the screen the button opens ("Screen 2 — Your study"). */
  screen: string
  /** The destination route (the module's own route builders, never a literal
   *  in the renderer — the button label is the screen's own words). */
  route: string
  cta: string
  /** The card's one-click example action (qa-fixes3 ITEM-5). */
  tryExample: QuickStartTryExample
}

/** One column spec of a file card (the mono-chip name, the required pill,
 *  the meaning and an example value). */
export interface HelpColumnSpec {
  name: string
  required: boolean
  meaning: string
  example: string
}

/** One file card of "Preparing your files". */
export interface FileCardContent {
  file: 'patients' | 'measurements'
  /** The card heading. */
  title: string
  /** One-line summary. */
  summary: string
  columns: HelpColumnSpec[]
  /** The example rows the "Copy example rows" button copies — the header
   *  line plus the first three rows of the app's committed example table
   *  (the test pins them to `data/file-validator/examples/*.csv`). */
  exampleRows: string
}

/** One step of the numbered visual stepper (the four steps). */
export interface StepCard {
  number: number
  name: string
  /** Exactly two short lines (the plan's "two short lines"). */
  lines: [string, string]
  /** The chip naming the screen it belongs to. */
  screen: string
  /** Details under the card (less than 4 lines each; collapsed by default). */
  details: HelpBlock[]
}

/**
 * One validator problem code's entry — the authored prose of the
 * troubleshooting accordion. The machine facts (severity group, whether the
 * app reports the code) come from `VALIDATOR_CATALOG` (the committed
 * catalogue generated from the server's own declaration tables), keyed by
 * `code`; only the human wording is authored here.
 */
export interface HelpProblemEntry {
  /** The wire code, e.g. `"R03"`. */
  code: string
  /** The anchor id (lower `problem-<code>`). */
  anchor: string
  /** The plain heading WITHOUT the code (the code renders as the chip). */
  title: string
  /** What the message means. */
  meaning: string
  /** What to do about it. */
  action: string
}

/** One entry of the committed validator catalogue (`validator-catalog.json`,
 *  the server's own declaration tables rendered by
 *  `src-app/server/src/modules/file_validator/catalog.rs`). */
export interface ValidatorCatalogEntry {
  /** The wire code (`"R03"`). */
  code: string
  /** The tidy rule id for R-codes; absent for the app-only codes. */
  rule_id: string | null
  severity: 'error' | 'warning' | 'error_or_warning'
  applicability: 'reported' | 'holds_by_construction' | 'not_applicable'
}

/** The troubleshooting accordion's groups (severity order). */
export type ProblemGroup = 'error' | 'warning' | 'error_or_warning' | 'never'
