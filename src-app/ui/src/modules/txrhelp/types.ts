/**
 * txrhelp content types — the typed shape of the Help page's data file
 * (`content.ts`): one section list + the closed problem-code
 * references. The page renders whatever this shape carries; the content is
 * data, the renderer is one component.
 *
 * Every block kind is a small closed union, so an unknown kind is a
 * compile error at the renderer and a section can never silently drop a
 * block.
 */

/** One authored body block of a Help section. */
export type HelpBlock =
  /** A plain paragraph. */
  | { kind: 'paragraph'; text: string }
  /** Short run-in line above a table (the column tables' caption). */
  | { kind: 'caption'; text: string }
  /** Unordered bullets. */
  | { kind: 'bullets'; items: string[] }
  /** Numbered steps (the four-step walk). */
  | { kind: 'steps'; items: string[] }
  /** A labelled table (`head` + one string entry per row). */
  | { kind: 'table'; head: string[]; rows: string[][] }
  /** A quiet note line (board-adjacent emphasis, not an alert). */
  | { kind: 'note'; text: string }

/** One authored Help section: `id` is the anchor (`#id`). */
export interface HelpSection {
  /** The anchor id (also the page-level test id). */
  id: string
  /** The section heading (TOC + body). */
  title: string
  blocks: HelpBlock[]
}

/**
 * One validator problem code's entry — the closed
 * `ProblemCode` vocabulary of the server's file validator, 28 codes.
 * `anchor` is the section sub-anchor the problems list links to.
 */
export interface HelpProblemEntry {
  /** The wire code, e.g. `"R03"`. */
  code: string
  /** The anchor id (lower `problem-<code>`). */
  anchor: string
  /** The entry's heading. */
  title: string
  /**
   * The severity the code is REPORTED with (`error`, `warning`) or
   * `never` for the two declared-not-applicable tidy ids (R01, R21) —
   * they are part of the closed vocabulary and are never emitted.
   */
  level: 'error' | 'warning' | 'never'
  /** What the message means. */
  meaning: string
  /** What to do about it. */
  action: string
}
