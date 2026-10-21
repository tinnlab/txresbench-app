// openPanes.ts — the pure OPEN-SET algebra for pane-attached editing surfaces (ITEM-7/8, INV-12).
//
// Every pane-attached surface in the workspace is keyed by a `Set<paneId>` so it can be open on
// SEVERAL panes at once: `editCellIds` and `dataTableCellIds` shipped that way, and the annotate /
// segment controls now match them. The toggle/close semantics and the eligibility reconcile are
// factored out here so they are unit-testable under the node-only vitest harness (the deck.gl-backed
// `GridWorkspace` cannot render there) — the same reason `annotateDock`/`maskDock` are pure.
//
// OPENING IS PER PANE (finding #14) — a pane's OWN toolbar button toggles its dock, exactly like the
// Edit form. There is no open-all-on-engage reconcile any more (and therefore no "panes the user
// explicitly closed" bookkeeping): the open set IS the user's intent. What survives is the eviction
// half — a pane that no longer qualifies is dropped (DEC-8, no stale id survives a pane removal).

/** Toggle a pane in an open set — the `editCellIds` idiom (`has ? delete : add`). */
export function togglePane(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(prev)
  next.has(id) ? next.delete(id) : next.add(id)
  return next
}

/** Remove a pane from an open set, returning `prev` UNCHANGED when absent (no needless re-render). */
export function closePane(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!prev.has(id)) return prev
  const next = new Set(prev)
  next.delete(id)
  return next
}

/** Add a pane to an open set, returning `prev` UNCHANGED when already present. */
export function openPane(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (prev.has(id)) return prev
  return new Set(prev).add(id)
}

/**
 * Drop every pane that no longer QUALIFIES for a surface (DEC-8).
 *
 * `eligibleIds` — panes that qualify right now (e.g. every `annotate` cell that is dense). A pane
 * removed from the grid, or whose `annotate`/`segment` flag was cleared, simply stops appearing here
 * and is evicted, so no stale id can survive.
 *
 * Returns `prev` by IDENTITY when nothing is evicted, so a caller passing this to `setState` does not
 * re-render on a no-op.
 */
export function evictIneligible(
  prev: ReadonlySet<string>,
  eligibleIds: readonly string[],
): ReadonlySet<string> {
  const eligible = new Set(eligibleIds)
  const kept = [...prev].filter(id => eligible.has(id))
  return kept.length === prev.size ? prev : new Set(kept)
}
