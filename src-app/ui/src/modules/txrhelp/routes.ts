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

/**
 * The router state a step view's Help link carries: the step URL (path +
 * search) Help was opened from, so Help can offer "Back to step N". Router
 * state, not a query parameter: it lives only in this window's history
 * entry, like the step trail and the step's unsaved page state it points
 * back to. A copied link or an address typed by hand carries none. A reload
 * keeps the state, but the step trail is memory only and starts empty, so
 * Help shows no way back then either (`helpReturnTarget`).
 */
export interface HelpLinkState {
  helpFrom: string
}

/** The router state of a Help link opened from the step view at `stepUrl`. */
export const helpLinkState = (stepUrl: string): HelpLinkState => ({ helpFrom: stepUrl })

/** The step URL a Help location's router state carries, or null (any other state). */
export function helpFromOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null
  const from = (state as Partial<HelpLinkState>).helpFrom
  return typeof from === 'string' ? from : null
}
