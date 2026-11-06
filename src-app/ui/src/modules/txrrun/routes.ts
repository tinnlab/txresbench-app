/**
 * The run module's route surface — the two screen routes owned by
 * `module.tsx` and built here so sibling flow modules navigate by builder
 * and never by URL literal.
 *
 * Movement rules (the URL-as-view contract):
 *
 * - `chooseMethodsPath()` is screen E — reached from the intake flow's
 *   continue steps (screen B/C/N) and the "Start a new analysis" handoffs.
 *   The path is the convention `txrintake` already declared
 *   (`ROUTE_CONVENTIONS.methods`); this module registers it.
 * - `runningPath(runId)` is screen F — reached from E on run creation
 *   (`202`) and from screen K (`ui-history`, "reopen a running run"). The
 *   `/analysis/:runId/` prefix is the family `txrresults` uses, so the
 *   running screen and the results screens of one run sit side by side.
 *
 * `running` is the F terminal segment. The `compare`/`methods` reserved
 * path words belong to `txrresults`' route tree (they are route segments
 * there, never method ids); they never appear in this route tree.
 */
export const chooseMethodsPath = (): string => '/choose-methods'

export const runningPath = (runId: string): string => `/analysis/${runId}/running`
