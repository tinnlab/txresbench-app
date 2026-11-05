/**
 * The results module's route surface — three routes under one run id, owned
 * by `module.tsx` and built here so sibling flow modules navigate by builder
 * and never by URL literal.
 *
 * Movement rules (the URL-as-view contract, INV-6):
 *
 * - `resultsPath(runId)` is screen G — the patient × method heatmap of the
 *   run, reachable from screen F (`ui-run` — "See the results" /
 *   leave-and-continue) and from screen K (`ui-history` — "reopen results").
 * - `compareResultsPath(runId)` is screen H's Compare-methods tab.
 * - `methodResultsPath(runId, methodId)` is screen H's one-method tab; the
 *   active tab travels in the URL, so back/forward and deep links resolve to
 *   the same tab.
 *
 * `compare` and `methods` are RESERVED path words: the first segment after
 * `/analysis/<runId>/results` is either the literal `compare` or the literal
 * `methods`, and a method id only ever appears AFTER the `methods/` segment
 * (catalog ids are slugs such as `landmark-cox-current`, but the reservation
 * is what keeps a future `results/<x>` route from ever colliding: a method id
 * can never be a top-level segment of this route tree).
 */
export const resultsPath = (runId: string): string => `/analysis/${runId}/results`

export const compareResultsPath = (runId: string): string =>
  `/analysis/${runId}/results/compare`

export const methodResultsPath = (runId: string, methodId: string): string =>
  `/analysis/${runId}/results/methods/${methodId}`
