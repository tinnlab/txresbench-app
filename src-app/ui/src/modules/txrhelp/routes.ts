/**
 * The help module's route surface — the one route owned by `module.tsx`,
 * built here so sibling modules bind the page by builder and never by URL
 * literal (the txrhistory/txrresults convention).
 */

/** Screen H — the Help page (`/help`, taken over from the txrshell scaffold). */
const HELP_ROUTE = '/help'

/**
 * The Help page's paths: `helpPath()` for the page, `helpPath(anchor)` for
 * a deep link to one section / problem-code entry (the intake problem list
 * binds each problem to its own entry this way).
 */
export const helpPath = (anchor?: string): string =>
  anchor === undefined ? HELP_ROUTE : `${HELP_ROUTE}#${anchor}`
