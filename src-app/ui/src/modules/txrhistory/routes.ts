/**
 * The history module's route surface — the one screen route owned by
 * `module.tsx` and built here so sibling flow modules navigate by builder
 * and never by URL literal.
 *
 * `historyPath()` is screen K — the `/history` route `txrshell`'s scaffold
 * used to own; the same string, now owned here (the shell's route block is
 * removed on the same branch, the `ui-intake` `/` handoff precedent). The
 * `txrrun` module declares a same-named constant beside its own two
 * builders (its F-screen not-found "History" link, written before this
 * module existed); the value is the same, and this module is the route's
 * owner.
 */
const HISTORY_ROUTE = '/history'

/** Screen K — the history list (board `History.dc.html`). */
export const historyPath = (): string => HISTORY_ROUTE
