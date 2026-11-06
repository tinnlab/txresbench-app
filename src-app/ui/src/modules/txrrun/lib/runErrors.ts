/**
 * txrrun — the create-path error resolution (ITEM-8; CONS-UI-RUN-7,
 * DEC-18).
 *
 * The Run button's failures are the engine's three error classes, and each
 * has ONE consumer-side rule:
 *
 * - `400` — the engine's field-level line, surfaced verbatim (the settings
 *   keep their values; the run was never created);
 * - `404 METHOD_NOT_FOUND` — the selection named a method the engine does
 *   not know; the engine's own message carries the id it rejected
 *   ("no method \"<id>\" in the shipped catalogue" — the provider's bytes,
 *   read here, never re-emitted), and when the message does not name one
 *   the local catalogue is the attribution source (a selection key the
 *   fresh list no longer knows). The dropped rows leave the selection with
 *   the notice; a run attempt with a selection NO source can attribute is
 *   never repeated silently — the error line surfaces instead.
 * - `409 RUN_ALREADY_ACTIVE` — the one-active-run contract: resolve the
 *   active run through `Txr.listRuns` (DEC-18) and the page navigates to
 *   its running screen; only when no active run answers does the error
 *   line surface (a racy rejection is never hidden).
 *
 * All functions are pure — the page wires the outcomes, and the unit tests
 * pin the attributions without a DOM.
 */

/** The 409's line (no active run answered — the honest racy state). */
export const RUN_ALREADY_ACTIVE_LINE =
  'A run is already active for these files — the engine allows one at a time.'

/** The 404's line when neither source can name the dropped method. */
export const RUN_METHODS_GONE_LINE =
  'The run could not be created — the selection no longer matches the method catalogue.'

/** The engine's own 404 message shape: `no method "<id>" in the shipped catalogue`. */
const NAMED_METHOD_RE = /no method "([^"]+)" in the shipped catalogue/

/**
 * The selection's stale member, per the engine's own attribution first:
 * the id the 404 message names. The message's quotation marks are the
 * provider's (a debug-quoted String), matched exactly — never re-parsed
 * as a loose quote pair.
 */
function namedMethod(message: string): string | null {
  const match = NAMED_METHOD_RE.exec(message)
  return match === null ? null : match[1]
}

/**
 * The selected ids the catalogue no longer knows: the message's named id
 * when the engine gave one, else the selection's keys outside the fresh
 * known set (the local attribution — the same catalogue the chips came
 * from). A selection a response cannot attribute to ANY id — a message
 * with no name AND a known list that never answered — returns an empty
 * drop (the caller surfaces `RUN_METHODS_GONE_LINE`), so a not-yet-loaded
 * catalogue is never treated as "everything dropped".
 */
export function staleMethodIds(
  message: string,
  selectedKeys: string[],
  knownIds: string[],
): string[] {
  const named = namedMethod(message)
  if (named !== null) return selectedKeys.filter(key => key === named)
  if (knownIds.length === 0) return []
  const known = new Set(knownIds)
  return selectedKeys.filter(key => !known.has(key))
}

/** The dropped-rows notice (the names are the engine's own attribution). */
export function droppedNotice(dropped: string[]): string {
  if (dropped.length === 1) {
    return `${dropped[0]} is no longer in the method catalogue — it was removed from the selection.`
  }
  return `${dropped.length} methods are no longer in the method catalogue — they were removed from the selection.`
}
