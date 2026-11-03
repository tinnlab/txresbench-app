/**
 * txrlist selection semantics — PROV-UI-LIST-2 / PROV-UI-LIST-4.
 *
 * The selection is HOST state: the list component is controlled
 * (`selected` + `onSelectionChange`), because the host needs the selection
 * to compute the time estimate and to hand the run to the engine (DEC-3).
 * These pure helpers implement the ONE selection rule set the three boards
 * share, so the host and the component cannot drift on it:
 *
 * - a row is selectable iff `!run.disabled` (a `cannot` row's checkbox is
 *   disabled, never counted — `disabled` is derived by the row builder as
 *   `status === 'cannot'`, EXAMPLE-UL-8);
 * - a disabled row's key is never ADDED by any helper (a stale key already
 *   in the set — host state from before the row became disabled — is left
 *   alone; only `countSelected` ignores it);
 * - "Select all that can run" toggles exactly all the non-disabled rows of
 *   the passed list: if they are ALL selected it unchecks them all,
 *   otherwise it checks them all (the board's checkbox is a toggle, not a
 *   "set all");
 * - a section select-all (screen I's run group of trained models) toggles
 *   exactly the section's non-disabled `rowKeys` with the same all-or-none
 *   rule; the disabled rows of the section never move (EXAMPLE-UL-4);
 * - toggling the last selected row off leaves the empty selection (the
 *   host's estimate hook then shows the "…" total and issues no request);
 *   nothing here clears or re-seeds any cache — the selection is the only
 *   state, and every helper returns a fresh set (or the same reference on
 *   a no-op, which is also a valid "no change" for React state).
 *
 * The helpers read only `key` + `run.disabled` (the minimal
 * `TxrSelectableRow`); a full `TxrListRow` is assignable to it. The set is
 * a `ReadonlySet` in and out — the host owns the state, updates are
 * immutable, and keys of rows currently filtered OUT of the view stay in
 * the set (the run the host is about to start is the selection, not the
 * view; DEC-9's filters are host-owned and never prune it here).
 */

/**
 * The minimal row facts the selection helpers read — the subset of
 * `TxrListRow` the semantics depend on (the stable key + the eligibility
 * verdict's `disabled` flag). A full `TxrListRow` is assignable to it, so
 * the host passes its rows as-is; a test or a host builder can pass the
 * narrow shape without constructing a full row.
 */
export interface TxrSelectableRow {
  key: string
  run: { disabled: boolean }
}

/**
 * The selection set. Read-only in the surface and treated as immutable by
 * every helper (a no-op returns the same reference; any change returns a
 * new set — React-safe for `useState`).
 */
export type TxrSelection = ReadonlySet<string>

/**
 * Toggle ONE row: check an unchecked selectable row, uncheck a checked one.
 * A disabled row is a no-op (its checkbox is disabled, the boards never
 * let it move; if a stale key is somehow present it stays — no helper
 * adds a disabled key, and removing one here would silently shrink selection
 * state the host owns).
 */
export function toggle(selected: TxrSelection, row: TxrSelectableRow): TxrSelection {
  if (row.run.disabled) return selected
  const next = new Set(selected)
  if (next.has(row.key)) {
    next.delete(row.key)
  } else {
    next.add(row.key)
  }
  return next
}

/**
 * Toggle a set of target keys against the passed rows — the shared engine
 * behind "Select all that can run" and the section select-all:
 *
 * - `targetKeys` are filtered to keys that belong to a row in `rows` and
 *   are NOT disabled (a key without a row — stale, or already removed from
 *   the list — is never selected, and a disabled row's key is never added);
 * - if every filtered key is already selected (and there is at least one),
 *   they are ALL removed; otherwise they are ALL added — the toggle-to-all
 *   rule of the boards' select-alls;
 * - selected keys OUTSIDE the filtered target set are untouched, whichever
 *   way the toggle goes (selecting one run's models never clears another
 *   run's, and "select all that can run" never clears a section's partial
 *   selection).
 */
export function toggleAll(
  selected: TxrSelection,
  targetKeys: ReadonlyArray<string>,
  rows: ReadonlyArray<TxrSelectableRow>,
): TxrSelection {
  const selectable = new Set<string>()
  for (const row of rows) {
    if (!row.run.disabled) selectable.add(row.key)
  }
  const eligible = targetKeys.filter(key => selectable.has(key))
  if (eligible.length === 0) return selected
  const next = new Set(selected)
  if (eligible.every(key => next.has(key))) {
    for (const key of eligible) next.delete(key)
  } else {
    for (const key of eligible) next.add(key)
  }
  return next
}

/**
 * "Select all that can run" (the boards' built-in): toggle EVERY
 * non-disabled row of the passed list, with the toggle-all rule above.
 * A full selection unchecks all; a partial (or empty) selection checks all
 * non-disabled rows — the disabled (`cannot`) rows never move.
 */
export function toggleAllCanRun(
  selected: TxrSelection,
  rows: ReadonlyArray<TxrSelectableRow>,
): TxrSelection {
  return toggleAll(
    selected,
    rows.map(row => row.key),
    rows,
  )
}

/**
 * A screen-I run-group select-all: toggle exactly the section's
 * non-disabled `rowKeys`, with the toggle-all rule above. The section's
 * disabled models stay unchecked, the other sections' rows are untouched,
 * and `section.rowKeys` entries with no matching row (a model removed from
 * the list) are ignored.
 */
export function toggleSection(
  selected: TxrSelection,
  section: { rowKeys: ReadonlyArray<string> },
  rows: ReadonlyArray<TxrSelectableRow>,
): TxrSelection {
  return toggleAll(selected, section.rowKeys, rows)
}

/**
 * How many selected keys count toward "N <itemLabel>s selected": the
 * selected keys that belong to a non-disabled row in the passed list. A
 * disabled row's key (stale host state) is never counted, and a key with
 * no row in the passed list is not counted here — pass the full row set
 * for the run count (a view-filtered set gives the visible count).
 */
export function countSelected(
  selected: TxrSelection,
  rows: ReadonlyArray<TxrSelectableRow>,
): number {
  let count = 0
  for (const row of rows) {
    if (!row.run.disabled && selected.has(row.key)) count += 1
  }
  return count
}
