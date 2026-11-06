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
 *
 * The change-files handoff (CONS-UI-RUN-12): the E screen's "Change files"
 * dialog hosts the intake's file cards, and a pick-from-disk goes to the
 * intake screen that owns the parse/inspect/validate flow — screen C
 * (`/files`) in the train-mode flow, screen N (`/predict-files`) in the
 * predict flow. The two targets are the declared constants here, never
 * literals in the module's copy; the routes themselves belong to
 * `txrintake`.
 */
export const chooseMethodsPath = (): string => '/choose-methods'

export const runningPath = (runId: string): string => `/analysis/${runId}/running`

/** Screen C (`txrintake`) — the train-mode change-files target. */
export const filesPath = (): string => '/files'

/** Screen N (`txrintake`) — the predict-mode change-files target. */
export const predictFilesPath = (): string => '/predict-files'

/**
 * Screen K (`txrshell`) — the F not-found/error states' "History" link.
 * The shell owns the route (and its module declares no builder), so this
 * module declares the constant beside its own two — the same convention as
 * the change-files targets above; the UI never spells a path literal.
 */
export const historyPath = (): string => '/history'
